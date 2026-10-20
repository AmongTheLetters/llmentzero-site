/* LlmentZero account button (top right of every page).
   Without JavaScript it's a plain link to /account (which sends signed-out visitors to /signin).
   With JavaScript it becomes a disclosure button (aria-expanded / aria-controls) with a small menu:
   Arrow keys / Home / End move between items, Escape closes and returns focus, Tab away closes.
   Signed-in state: Worker-rendered pages say so in data-state. Static pages use a hint in this
   browser's localStorage (initial + email, never sent anywhere), confirmed once per browser session
   with /api/me so an expired session doesn't show as signed in. */
(() => {
  const root = document.querySelector('.acct');
  if (!root) return;
  const HINT = 'lz_acct', CHECKED = 'lz_acct_checked';
  const ls = {
    get() { try { return JSON.parse(localStorage.getItem(HINT) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(HINT, JSON.stringify(v)); } catch (e) {} },
    clear() { try { localStorage.removeItem(HINT); } catch (e) {} },
  };
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = '<svg class="acct-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c.8-3.9 3.9-6 7.5-6s6.7 2.1 7.5 6"/></svg>';

  let info = null;
  const state = root.getAttribute('data-state');
  if (state === 'in') { info = { i: root.getAttribute('data-initial'), e: root.getAttribute('data-email') }; ls.set(info); }
  else if (state === 'out') { ls.clear(); }
  else {
    info = ls.get();
    let checked = false;
    try { checked = sessionStorage.getItem(CHECKED) === '1'; } catch (e) {}
    if (info && !checked) {
      fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => {
          try { sessionStorage.setItem(CHECKED, '1'); } catch (e) {}
          if (d && d.signedIn) { info = { i: d.initial, e: d.email }; ls.set(info); } else { info = null; ls.clear(); }
          render();
        })
        .catch(() => {});
    }
  }

  let btn, menu;
  function items() { return menu ? [...menu.querySelectorAll('a, button')] : []; }
  function open(focusFirst) {
    btn.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    if (focusFirst) { const f = items()[0]; f && f.focus(); }
  }
  function close(returnFocus) {
    if (!menu || menu.hidden) return;
    btn.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    if (returnFocus) btn.focus();
  }

  function render() {
    const signedIn = !!(info && info.i);
    const links = signedIn
      ? [['/account', 'Account'], ['/account#licences', 'My licences'], ['/account/team', 'Team'], ['/account#downloads', 'Downloads']]
      : [['/signin', 'Sign in'], ['/signup', 'Create account']];
    root.innerHTML =
      '<button type="button" class="acct-btn' + (signedIn ? ' is-in' : '') + '" aria-expanded="false" aria-controls="acct-menu">' +
      (signedIn ? '<span class="acct-initial" aria-hidden="true">' + esc(String(info.i).slice(0, 1).toUpperCase()) + '</span>' : ICON) +
      '<span class="visually-hidden">' + (signedIn ? 'Account menu, signed in' : 'Account menu, not signed in') + '</span></button>' +
      '<div id="acct-menu" class="acct-menu" hidden>' +
      (signedIn && info.e ? '<p class="acct-who">Signed in as <strong>' + esc(info.e) + '</strong></p>' : '') +
      '<ul>' + links.map(([h, t]) => '<li><a href="' + h + '">' + t + '</a></li>').join('') +
      (signedIn ? '<li><form method="post" action="/signout"><button type="submit" class="acct-signout">Sign out</button></form></li>' : '') +
      '</ul></div>';
    btn = root.querySelector('.acct-btn');
    menu = root.querySelector('.acct-menu');
    btn.addEventListener('click', () => (btn.getAttribute('aria-expanded') === 'true' ? close(false) : open(false)));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); open(false);
        const list = items(); const t = e.key === 'ArrowDown' ? list[0] : list[list.length - 1]; t && t.focus();
      }
    });
    menu.addEventListener('keydown', (e) => {
      const list = items(); const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) close(false); });
    const so = menu.querySelector('form[action="/signout"]');
    if (so) so.addEventListener('submit', () => { ls.clear(); });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu && !menu.hidden) { e.preventDefault(); close(true); }
  });
  document.addEventListener('click', (e) => { if (menu && !menu.hidden && !root.contains(e.target)) close(false); });
  root.addEventListener('focusout', (e) => { if (e.relatedTarget && !root.contains(e.relatedTarget)) close(false); });
  render();
})();
