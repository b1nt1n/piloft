// Read the rendered screen, not the byte stream. ConPTY sends partial rewrites and cursor moves.
function readAds(term, lines, buffer) {
  const ads = [];
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row].trim();
    const plain = /^AD ▚ (.*)$/.exec(line);
    const framed = /^┌ AD ░▒▓ ─+┐$/.test(line);
    if (!plain && !framed) continue;
    const cells = buffer.getLine(buffer.baseY + row);
    const marker = lines[row].search(/\S/);
    // xterm 6 stores parsed OSC 8 targets with the buffer cells.
    const linkId = cells?.getCell(marker)?.extended?.urlId;
    const url = term._core?._oscLinkService?.getLinkData(linkId)?.uri;
    if (!/^https?:\/\//i.test(url ?? '')) continue;
    if (plain) {
      ads.push({ lines: [plain[1]], url });
      continue;
    }
    const copy = [];
    for (let j = row + 1; j < Math.min(lines.length, row + 9); j++) {
      const content = lines[j].trim();
      if (/^└─+┘$/.test(content)) {
        if (copy.length) ads.push({ lines: copy, url });
        break;
      }
      if (!content.startsWith('│')) break;
      copy.push(content.slice(1).replace(/│$/, '').trim());
    }
  }
  return ads;
}

function readScreen(term, folder) {
  const buffer = term.buffer.active;
  const lines = Array.from({ length: term.rows }, (_, i) =>
    (buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').replace(/ {2,}[│┃]$/, ''));
  const header = lines.find(line => /^\s*›π free-pi v\S+ · /.test(line))?.split(' · ').slice(1);
  const title = header?.[0].replace(/^🔥\s*/u, '');
  const free = header?.includes('Free Unlimited: limited time') ?? false;
  const bottom = lines.slice(-6);
  const editor = bottom.findIndex(line => /^\s*Try "explain this repo" · \/help for (?:commands|…|\.{3})\s*$/.test(line));
  const border = line => /^─{8,}$/.test(line?.trim() ?? '');
  const folderLine = bottom.findIndex(line => {
    if (!folder) return false;
    const shown = line.replace(/ {2,}(?=\d[\d,]*\b|🔥).*$/u, '').trimEnd().toLowerCase();
    const cwd = folder.toLowerCase();
    const matches = candidate => candidate.startsWith('~\\')
      ? cwd.endsWith(candidate.slice(1)) || (candidate.endsWith('...') && cwd.includes(candidate.slice(1, -3)))
      : candidate === cwd || (candidate.endsWith('...') && cwd.startsWith(candidate.slice(0, -3)));
    return matches(shown) || matches(shown.replace(/ \([^()\r\n]*\)$/, ''));
  });
  const nextLine = bottom[folderLine + 1]?.trim();
  const footer = folderLine < 0 ? undefined : /^\d[\d,]*.*credits left|^🔥/u.test(nextLine ?? '')
    ? `${bottom[folderLine]}  ${nextLine}`
    : bottom[folderLine];
  const emptyEditor = editor > 0 && border(bottom[editor - 1]) && border(bottom[editor + 1]);
  const ready = Boolean(footer && emptyEditor);
  const busy = Boolean(footer && bottom.some(line =>
    /^─{2,}\s*(?:[⠁-⣿]|Working|Retrying|Compacting|Auto-compacting|Context overflow detected|Summarizing branch)/u.test(line)));
  const modelStatus = lines.findLast(line =>
    /^\s*(?:(?:Default model: |Model: )\S+|✓ New session started|Resumed session)\s*$/.test(line));
  const selected = modelStatus?.trim().match(/^(?:Default model: |Model: )(?:\S+\/)?([^/\s]+)$/)?.[1];
  const lifecycle = modelStatus && !selected ? modelStatus.trim() : undefined;
  const sessionHeader = lines.findLastIndex(line => line.trim() === 'Session Info');
  const sessionLines = sessionHeader < 0 ? [] : lines.slice(sessionHeader + 1, sessionHeader + 11);
  const fileRow = sessionLines.findIndex(line => /^\s*File:(?:\s|$)/.test(line));
  const idRow = sessionLines.findIndex(line => /^\s*ID: [a-z0-9][a-z0-9_-]{0,127}\s*$/i.test(line));
  const candidateId = idRow > fileRow && fileRow >= 0 ? sessionLines[idRow].trim().slice(4) : undefined;
  const reportedFile = candidateId && sessionLines.slice(fileRow, idRow).map(line => line.trim()).join('').slice(5).trim();
  const reportedSessionId = reportedFile === 'In-memory' || reportedFile?.endsWith(`_${candidateId}.jsonl`)
    ? candidateId : undefined;
  const sessionStats = lines.some(line => line.trim() === 'Cache Warming')
    && lines.some(line => /^\s*Tools: \d+ calls, \d+ results\s*$/.test(line));
  const thinkingStatus = lines.findLastIndex(line => /^\s*(?:Default thinking level: |Thinking level: )\S+\s*$/.test(line));
  const thinking = thinkingStatus > (modelStatus ? lines.lastIndexOf(modelStatus) : -1)
    ? lines[thinkingStatus].trim().split(' ').at(-1)
    : undefined;
  const footerModel = footer?.match(/(?:·|\s)\s*🔥\s*(.+?)\s*· free\s*$/u)?.[1];
  const balance = footer?.match(/ {2,}(\d[\d,]*(?: \([^()]+\))? credits left(?:[^·]*(?:·\s*resets[^·]*)?)?)/i)?.[1].trim();

  // The hint can scroll off the bottom in a short window.
  const hint = lines.findLastIndex(line => /to select · .*to set as default · .*to cancel/.test(line));
  const heading = lines.findLastIndex((line, i) => (hint < 0 || i < hint) && (
    (line.trim() === 'Scope: all | scoped' && /scope \(all\/scoped\)/.test(lines[i + 1] ?? ''))
    || (line.trim() === 'Thinking Level' && /cycles thinking levels in-session/.test(lines[i + 2] ?? ''))
  ));
  let menu;
  if (heading >= 0) {
    const kind = lines[heading].trim() === 'Thinking Level' ? 'thinking' : 'model';
    const rows = lines.slice(heading + 1, hint < 0 ? undefined : hint);
    const entries = [];
    for (const line of rows) {
      const model = /^\s*(→)?\s*(✓)?\s*(.*?)\s+\[([\w-]+)\](?: · default)?\s*$/u.exec(line);
      const level = /^\s*(→)?\s*(✓)?\s*(off|minimal|low|medium|high|xhigh|max)\s{2,}(.*)$/u.exec(line);
      const match = kind === 'model' ? model : level;
      if (!match) continue;
      const [, pointer, current, label, detail] = match;
      const id = kind === 'model' ? label.replace(/^[^\w]+/u, '') : label;
      if (!/^[\w.-]+$/.test(id) || (kind === 'model' && !/^free-pi(?:-|$)/.test(detail))) continue;
      entries.push({ id, detail, label, key: `${detail}/${id}`, selected: Boolean(pointer), current: Boolean(current) });
    }
    const position = rows.map(line => /^\s*\((\d+)\/(\d+)\)\s*$/.exec(line)).find(Boolean);
    const modelName = rows.find(line => /^\s*Model Name: /.test(line))?.trim().slice(12);
    const query = rows.find(line => line.startsWith('> '))?.slice(2).trim();
    if (hint >= 0 || (query !== undefined && entries.some(entry => entry.selected))) menu = {
      kind, entries, modelName, query, refreshing: rows.some(line => line.trim() === 'Refreshing model catalogs…'),
      position: position ? Number(position[1]) : entries.findIndex(entry => entry.selected) + 1,
      total: position ? Number(position[2]) : entries.length,
    };
  }
  const customQuestion = !emptyEditor && lines.some(line => /left\/right compare\s+enter select\s+o something else/.test(line));
  const visible = lines.map(line => line.trim());
  const dismissibleMenu = !emptyEditor && !customQuestion && (
    Boolean(menu)
    || visible.some(line => /^(?:Type to search\s*·\s*)?Enter\/Space to change\s*·\s*Esc to cancel$|^enter manage\s*•\s*escape\/ctrl\+c close$/i.test(line))
    || (visible.includes('Session Tree') && visible.some(line => line.startsWith('Type to search:')))
    || (visible.includes('Model Configuration') && visible.some(line => /^Session-only\. .+ to save to settings\.$/.test(line)))
    || (visible.includes('Fork from Message') && visible.some(line => line.startsWith('Select a user message to copy the active path')))
    || (visible.some(line => /^Resume Session \((?:Current Folder|All)\).*\bName:.*\bSort:/.test(line))
      && !visible.some(line => /^Delete session\?|^Rename Session$/.test(line)))
    || (visible.includes('Project trust') && visible.some(line => line.startsWith('Saved decision:'))
      && visible.some(line => /^Current session: (?:un)?trusted$/.test(line)))
  );
  return { ready, emptyEditor, busy, title, free, selected, lifecycle, reportedSessionId, sessionStats, customQuestion, thinking,
    footer, footerModel, balance, menu, dismissibleMenu, lines, ads: readAds(term, lines, buffer) };
}

function readStartupStep(lines = []) {
  const content = lines.filter(line => line.trim()).slice(-24);
  for (let i = content.length - 1; i >= 0; i--) {
    const line = content[i].trim();
    if (/^OK, free-pi won't start\./i.test(line)) return 'declined';
    if (/sign-in (?:timed out|was cancel(?:l)?ed)/i.test(line)) return 'sign-in-ended';
    if (/Trust this folder\? \[y\/N\]/i.test(line)) return 'trust';
    if (/^Tell free-pi what to build, fix, or explain\./i.test(line)) return 'loading';
    if (/Waiting for (?:browser sign-in|GitHub)|Confirmation code:|Enter the code on GitHub/i.test(line)) return 'sign-in';
    if (/Type a number, or press Enter to skip:/i.test(line)) return 'referral';
    if (/^Accept\? \[y\/N\]\s*$/i.test(line)) return 'consent';
  }
  return 'loading';
}
