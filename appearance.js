(() => {
  const dialog = document.getElementById('settings-panel');
  const trigger = document.getElementById('settings');
  const pages = [...dialog.querySelectorAll('.settings-page')];
  const navigation = [...dialog.querySelectorAll('[data-settings-page]')];
  const osTheme = matchMedia('(prefers-color-scheme: dark)');
  const osMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const baseColors = {
    dark: { background: '#141414', foreground: '#ededed', accent: '#c8c8c8' },
    light: { background: '#fafafa', foreground: '#1c1c1c', accent: '#454545' },
  };
  const uiFonts = {
    manrope: '"Manrope Variable", "Segoe UI", sans-serif',
    source: '"Source Sans 3 Variable", "Segoe UI", sans-serif',
    system: '"Segoe UI", system-ui, sans-serif',
  };
  const terminalFonts = {
    plex: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    cascadia: '"Cascadia Mono", Consolas, monospace',
    consolas: 'Consolas, monospace',
  };
  const uiSizes = { small: 13, default: 14, large: 16 };
  const colorKeys = ['background', 'foreground', 'accent'];
  const themeRadios = [...dialog.querySelectorAll('[name="settings-theme"]')];
  const custom = document.getElementById('theme-custom');
  const colorList = document.getElementById('theme-colors');
  const caution = document.getElementById('theme-contrast');
  const savedKey = 'freepi-appearance';
  const controls = [
    ['ui-font', 'uiFont', 'manrope'],
    ['ui-size', 'uiSize', 'default'],
    ['chat-size', 'chatSize', 'default'],
    ['chat-width', 'chatWidth', 'default'],
    ['chat-density', 'chatDensity', 'default'],
    ['ui-motion', 'motion', 'system'],
    ['terminal-font', 'terminalFont', 'plex'],
    ['terminal-size', 'terminalSize', '15'],
  ].map(([id, key, fallback]) => ({ element: document.getElementById(id), key, fallback }));
  const colorInputs = Object.fromEntries(colorKeys.map(key => [key, document.getElementById(`theme-${key}`)]));
  let state;
  let customTokens = [];
  let values = defaults();

  function defaults() {
    return { theme: 'dark', custom: false, colors: {}, ...Object.fromEntries(controls.map(({ key, fallback }) => [key, fallback])) };
  }

  try {
    const saved = JSON.parse(localStorage.getItem(savedKey)) || {};
    if (themeRadios.some(radio => radio.value === saved.theme)) values.theme = saved.theme;
    values.custom = saved.custom === true;
    for (const key of colorKeys) {
      if (typeof saved.colors?.[key] === 'string' && /^#[\da-f]{6}$/i.test(saved.colors[key])) values.colors[key] = saved.colors[key];
    }
    for (const { element, key } of controls) {
      const preference = saved[key] ?? localStorage.getItem(key);
      if ([...element.options].some(option => option.value === preference)) values[key] = preference;
    }
  } catch {
    // Use app defaults if this window cannot read its stored preferences.
  }

  function rgb(hex) {
    return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16));
  }

  function mix(color, other, amount) {
    const destination = rgb(other);
    return '#' + rgb(color).map((channel, index) =>
      Math.round(channel + (destination[index] - channel) * amount).toString(16).padStart(2, '0')).join('');
  }

  function luminance(color) {
    const [r, g, b] = rgb(color).map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrast(left, right) {
    const a = luminance(left);
    const b = luminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function readable(color, backgrounds, toward, minimum = 4.5) {
    for (let step = 0; step <= 20; step++) {
      const adjusted = mix(color, toward, step / 20);
      if (backgrounds.every(background => contrast(adjusted, background) >= minimum)) return adjusted;
    }
    return toward;
  }

  function resolveCustom({ background, foreground, accent }) {
    const toward = contrast(background, '#ffffff') >= contrast(background, '#000000') ? '#ffffff' : '#000000';
    const theme = toward === '#ffffff' ? 'dark' : 'light';
    let surfaces = [0.04, 0.08, 0.12, 0.16, 0.20].map(amount => mix(background, toward, amount));
    if (surfaces.some(surface => contrast(surface, toward) < 4.5)) {
      const away = theme === 'dark' ? '#000000' : '#ffffff';
      surfaces = [0.04, 0.08, 0.12, 0.16, 0.20].map(amount => mix(background, away, amount));
    }
    const [sidebar, surface, raised, hover, active] = surfaces;
    const backgrounds = [background, ...surfaces];
    const text = readable(foreground, backgrounds, toward);
    const accentColor = readable(accent, backgrounds, toward);
    const buttonForeground = contrast(accentColor, '#ffffff') >= contrast(accentColor, '#000000') ? '#ffffff' : '#000000';
    const standard = theme === 'dark'
      ? { positive: '#9bd8aa', negative: '#f5aeb3', warning: '#e7c494' }
      : { positive: '#17663d', negative: '#9d3149', warning: '#754610' };
    return {
      theme,
      colors: { background, foreground: text, accent: accentColor },
      tokens: {
        canvas: background, sidebar, surface, raised, hover,
        line: mix(raised, toward, 0.10), 'line-strong': mix(raised, toward, 0.22),
        muted: readable(mix(text, background, 0.32), backgrounds, toward),
        accent: accentColor, active, text, code: sidebar,
        'button-bg': accentColor, 'button-fg': buttonForeground,
        ...Object.fromEntries(Object.entries(standard).map(([key, value]) => [key, readable(value, backgrounds, toward)])),
      },
    };
  }

  function apply(save = true) {
    const base = values.theme === 'system' ? (osTheme.matches ? 'dark' : 'light') : values.theme;
    const colors = { ...baseColors[base], ...values.custom ? values.colors : {} };
    const resolved = values.custom ? resolveCustom(colors) : { theme: base, colors, tokens: {} };
    state = {
      theme: resolved.theme,
      motion: values.motion === 'reduced' || osMotion.matches ? 'reduced' : 'full',
      terminalFont: terminalFonts[values.terminalFont],
      terminalSize: Number(values.terminalSize),
      colors: resolved.colors,
    };
    const { dataset, style } = document.body;
    dataset.theme = state.theme;
    dataset.motion = state.motion;
    dataset.uiFont = values.uiFont;
    dataset.uiSize = values.uiSize;
    dataset.chatSize = values.chatSize;
    dataset.chatWidth = values.chatWidth;
    dataset.chatDensity = values.chatDensity;
    style.setProperty('--font-ui', uiFonts[values.uiFont]);
    style.setProperty('--ui-font-size', `${uiSizes[values.uiSize]}px`);
    style.setProperty('--mono', state.terminalFont);
    customTokens.forEach(key => style.removeProperty(`--${key}`));
    customTokens = Object.keys(resolved.tokens);
    for (const [key, color] of Object.entries(resolved.tokens)) style.setProperty(`--${key}`, color);

    themeRadios.forEach(radio => { radio.checked = radio.value === values.theme; });
    custom.checked = values.custom;
    colorList.hidden = !values.custom;
    for (const key of colorKeys) {
      colorInputs[key].value = colors[key];
      colorInputs[key].nextElementSibling.value = colors[key].toUpperCase();
    }
    for (const { element, key } of controls) element.value = values[key];
    const adjusted = resolved.colors.foreground !== colors.foreground || resolved.colors.accent !== colors.accent;
    caution.textContent = adjusted ? t("Text or accent color was adjusted for contrast.") : '';
    caution.hidden = !adjusted;
    if (save) {
      try {
        localStorage.setItem(savedKey, JSON.stringify(values));
      } catch {
        caution.textContent = t("Appearance settings could not be saved.");
        caution.hidden = false;
      }
    }
    document.dispatchEvent(new CustomEvent('freepi:appearance', { detail: state }));
  }

  function showPage(page) {
    const search = document.getElementById('settings-search');
    if (search?.value) {
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
    navigation.forEach(button => {
      if (button.dataset.settingsPage === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    pages.forEach(section => { section.hidden = section.id !== `settings-${page}`; });
    dialog.querySelector('.settings-main').scrollTop = 0;
    document.dispatchEvent(new CustomEvent('freepi:settings-page', { detail: page }));
  }

  function show(open, page) {
    if (page) showPage(page);
    if (open && !dialog.open) {
      dialog.showModal();
      trigger.setAttribute('aria-expanded', 'true');
      (page ? dialog.querySelector('[aria-current="page"]') : document.getElementById('settings-search')).focus({ preventScroll: true });
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }

  dialog.addEventListener('close', () => {
    if (!dialog.open) trigger.setAttribute('aria-expanded', 'false');
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) show(false);
  });
  document.addEventListener('keydown', event => {
    if (event.code === 'Comma' && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && !event.repeat
      && !document.querySelector('dialog[open]:not(#settings-panel)')) {
      event.preventDefault();
      event.stopPropagation();
      trigger.click();
    }
  }, true);
  navigation.forEach(button => { button.onclick = () => showPage(button.dataset.settingsPage); });
  themeRadios.forEach(radio => {
    radio.onchange = () => {
      values.theme = radio.value;
      values.custom = false;
      apply();
    };
  });
  custom.onchange = () => {
    values.custom = custom.checked;
    apply();
  };
  for (const [key, input] of Object.entries(colorInputs)) {
    // Persist when the picker closes instead of writing for every dragged color.
    input.oninput = () => { values.colors[key] = input.value; apply(false); };
    input.onchange = () => { values.colors[key] = input.value; apply(); };
  }
  for (const { element, key } of controls) {
    element.onchange = () => {
      values[key] = element.value;
      apply();
    };
  }
  document.getElementById('reset-appearance').onclick = () => { values = defaults(); apply(); };
  osTheme.addEventListener('change', () => apply(false));
  osMotion.addEventListener('change', () => apply(false));

  window.freepiAppearance = {
    show,
    setTheme(theme) {
      if (!themeRadios.some(radio => radio.value === theme)) return;
      values.theme = theme;
      values.custom = false;
      apply();
    },
    get theme() { return values.theme; },
    get state() { return state; },
  };
  showPage('general');
  apply(false);
})();
