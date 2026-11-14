function parseDiffLines(patch) {
  const rows = [];
  let previousHunk;
  let remainingOld = 0;
  let remainingNew = 0;
  let oldNumber;
  let newNumber;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();

  for (const raw of lines) {
    const crlf = raw.endsWith('\r');
    const line = crlf ? raw.slice(0, -1) : raw;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
    if (header) {
      const [, oldStart, oldLength = '1', newStart, newLength = '1'] = header;
      oldNumber = Number(oldStart);
      newNumber = Number(newStart);
      remainingOld = Number(oldLength);
      remainingNew = Number(newLength);
      // A zero-length range denotes a position after the specified line.
      const fromOld = oldNumber + Number(remainingOld === 0);
      const fromNew = newNumber + Number(remainingNew === 0);
      const count = fromOld - (previousHunk?.oldEnd ?? 1);
      const newCount = fromNew - (previousHunk?.newEnd ?? 1);
      if (count > 0 && newCount > 0) rows.push({ kind: 'gap', count, newCount, text: '' });
      previousHunk = { oldEnd: fromOld + remainingOld, newEnd: fromNew + remainingNew };
      rows.push({ kind: 'hunk', text: line });
      continue;
    }

    const eol = crlf ? '\r\n' : '\n';
    const text = line.slice(1);
    if (line.startsWith(' ') && remainingOld > 0 && remainingNew > 0) {
      rows.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, text, eol });
      remainingOld--;
      remainingNew--;
    } else if (line.startsWith('-') && remainingOld > 0) {
      rows.push({ kind: 'delete', oldNumber: oldNumber++, text, eol });
      remainingOld--;
    } else if (line.startsWith('+') && remainingNew > 0) {
      rows.push({ kind: 'add', newNumber: newNumber++, text, eol });
      remainingNew--;
    } else if (line.startsWith('\\ ')) {
      const previous = rows.at(-1);
      if (previous?.eol) {
        // Git supplies the separator before its no-newline marker.
        if (previous.eol === '\r\n') previous.text += '\r';
        previous.eol = '';
      }
      rows.push({ kind: 'note', text: line });
    }
  }

  for (let index = 1; index < rows.length; index++) {
    const before = rows[index - 1];
    const after = rows[index];
    if (before.kind === 'delete' && after.kind === 'add'
      && rows[index - 2]?.kind !== 'delete' && rows[index + 1]?.kind !== 'add') {
      markReplacement(before, after);
    }
  }
  return rows;
}

function markReplacement(before, after) {
  const oldText = Array.from(before.text);
  const newText = Array.from(after.text);
  const length = Math.min(oldText.length, newText.length);
  let prefix = 0;
  let suffix = 0;
  while (prefix < length && oldText[prefix] === newText[prefix]) prefix++;
  while (suffix < length - prefix && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix++;
  if ((!prefix && !suffix) || (prefix === oldText.length && prefix === newText.length)) return;
  for (const [row, characters] of [[before, oldText], [after, newText]]) {
    const end = characters.length - suffix;
    row.parts = [
      { text: characters.slice(0, prefix).join(''), changed: false },
      { text: characters.slice(prefix, end).join(''), changed: true },
      { text: characters.slice(end).join(''), changed: false },
    ].filter(part => part.text);
  }
}
