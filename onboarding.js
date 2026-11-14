(() => {
  const byId = id => document.getElementById(id);
  const dialog = byId('onboarding-dialog');
  const form = byId('onboarding-form');
  const next = byId('onboarding-next');
  const back = byId('onboarding-back');
  const error = byId('onboarding-error');
  const languageStep = byId('onboarding-language');
  const themeStep = byId('onboarding-theme');
  let saving = false;
  let complete;
  const language = () => form.elements['welcome-language'].value;
  const translate = text => window.freepiLocale.inLanguage(language(), text);
  const terms = [
    [byId('onboarding-title'), 'Choose your language'],
    [languageStep.querySelector('p'), 'You can change it later in Settings.'],
    [languageStep.querySelector('legend'), 'Interface language'],
    [byId('onboarding-theme-title'), 'Choose your theme'],
    [themeStep.querySelector('p'), 'Pick a look for your workspace.'],
    [themeStep.querySelector('legend'), 'Color mode'],
    [back, 'Back'],
  ];
  const themeLabels = ['Graphite', 'Light', 'Follow Windows'];

  function showStep(theme, moveFocus = true) {
    languageStep.hidden = theme;
    themeStep.hidden = !theme;
    back.hidden = !theme;
    dialog.lang = language();
    const title = theme ? byId('onboarding-theme-title') : byId('onboarding-title');
    dialog.setAttribute('aria-labelledby', title.id);
    for (const [element, text] of terms) element.textContent = translate(text);
    themeStep.querySelectorAll('.settings-theme-option > span:last-child').forEach((label, index) => {
      label.lastChild.textContent = translate(themeLabels[index]);
    });
    next.textContent = translate(theme ? 'Get started' : 'Continue');
    error.hidden = true;
    if (moveFocus) title.focus({ preventScroll: true });
  }

  form.addEventListener('change', () => showStep(!themeStep.hidden, false));
  back.onclick = () => showStep(false);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!saving && !themeStep.hidden) showStep(false);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    if (themeStep.hidden) return showStep(true);
    saving = true;
    next.disabled = true;
    back.disabled = true;
    try {
      const selected = language();
      await window.desktop.finishOnboarding(selected);
      window.freepiAppearance.setTheme(form.elements['welcome-theme'].value);
      window.freepiLocale.persistLanguage(selected);
      const sameLanguage = selected === window.freepiLocale.language;
      if (!sameLanguage && !await window.restartForLanguage()) throw new Error('Cannot restart during setup');
      dialog.close();
      complete(sameLanguage);
    } catch {
      error.textContent = translate('Could not save the setup. Try again.');
      error.hidden = false;
    } finally {
      saving = false;
      next.disabled = false;
      back.disabled = false;
    }
  });

  window.freepiOnboarding = {
    async beforeStartup(preferences) {
      if (preferences.onboardingComplete) {
        if (preferences.language === window.freepiLocale.language) return true;
        await this.changeLanguage(preferences.language);
        return false;
      }
      form.elements['welcome-language'].value = preferences.language === 'ru' ? 'ru' : 'en';
      form.elements['welcome-theme'].value = window.freepiAppearance.theme;
      return new Promise(resolve => {
        complete = resolve;
        dialog.showModal();
        showStep(false);
      });
    },
    async changeLanguage(value) {
      window.freepiLocale.persistLanguage(value);
      return value === window.freepiLocale.language || window.restartForLanguage();
    },
  };
})();
