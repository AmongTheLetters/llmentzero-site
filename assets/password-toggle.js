/* Eye-icon show/hide toggle for every password field. Real <button type="button"> (never submits),
   It keeps one fixed accessible name, "Show password"; aria-pressed="true" means the password is visible.
   Without JavaScript the button stays hidden and the field works normally. */
(() => {
  for (const btn of document.querySelectorAll('.pw-toggle')) {
    const input = document.getElementById(btn.getAttribute('aria-controls'));
    if (!input) continue;
    btn.hidden = false;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
    });
  }
  // Switch fields back to hidden before submitting, so browsers don't save them as plain text fields.
  for (const form of document.querySelectorAll('form')) {
    form.addEventListener('submit', () => {
      for (const b of form.querySelectorAll('.pw-toggle[aria-pressed="true"]')) b.click();
    });
  }
})();
