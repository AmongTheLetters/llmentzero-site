/* LlmentZero friendly licence reminder (ACCOUNTS_PLAN §4.2, Decisions Oct 16 2026).
   Only loaded for signed-in accounts with no Business Licence, on skill pages.
   Rotates three wordings. After dismissal: hidden for 7 days AND 5 page visits (whichever is later).
   Never more than once per browser session. Stored in localStorage only; nothing is sent anywhere. */
(() => {
  const mount = document.getElementById('lz-reminder');
  if (!mount) return;
  const KEY = 'lz_reminder_v1', SESSION_KEY = 'lz_reminder_shown';
  const WEEK = 7 * 24 * 3600 * 1000;
  let st;
  try { st = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { st = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };
  let seen = false;
  try { seen = sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) {}

  if (st.dismissedAt) { st.visits = (st.visits || 0) + 1; save(); }
  const due = !st.dismissedAt || (Date.now() - st.dismissedAt >= WEEK && (st.visits || 0) >= 5);
  if (!due || seen) return;

  const buy = mount.getAttribute('data-buy') || '/tiers';
  const where = mount.getAttribute('data-payhip') === '1' ? ' on Payhip' : '';
  // The "~" is hidden from screen readers so the link is read as "Grab a licence on Payhip".
  const href = buy.replace(/"/g, '&quot;');
  // The "~" is hidden from screen readers so links read as "Grab a licence on Payhip".
  const grab = (cap) => '<a href="' + href + '">' + (cap ? 'G' : 'g') + 'rab a licence<span aria-hidden="true">~</span>' + where + '</a>';
  const variants = [
    'Enjoying LlmentZero? <span aria-hidden="true">🌱</span> If you\u2019re using it for work, please ' + grab(false) + '. Personal use is always free.',
    'Hi there! <span aria-hidden="true">👋</span> These skills love helping out at work too. If yours is a business use, a licence keeps the lights on: ' + grab(false) + '. Just tinkering? It\u2019s free, carry on!',
    'Psst\u2026 using LlmentZero at work or for clients? <span aria-hidden="true">🛠️</span> A Business Licence makes it official (and makes us very happy). ' + grab(true) + '. Personal projects stay free forever.',
  ];
  const i = (st.next || 0) % variants.length;
  st.next = i + 1; st.dismissedAt = st.dismissedAt || 0; save();
  try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (e) {}

  // Insert on load (live region already exists in the page, so it's announced politely once).
  mount.innerHTML = '<p>' + variants[i] + '</p><button type="button" class="lz-dismiss" aria-label="Dismiss licence reminder"><span aria-hidden="true">×</span></button>';
  mount.classList.add('lz-in');
  const btn = mount.querySelector('.lz-dismiss');
  const dismiss = () => {
    const hadFocus = mount.contains(document.activeElement);
    st.dismissedAt = Date.now(); st.visits = 0; save();
    mount.classList.remove('lz-in');
    mount.textContent = '';
    if (hadFocus) {
      const h = document.querySelector('main h1');
      if (h) { h.setAttribute('tabindex', '-1'); h.focus(); }
    }
  };
  btn.addEventListener('click', dismiss);
  mount.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); } });
})();
