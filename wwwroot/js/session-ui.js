// Client side of the stateless session-expiry flow.
// Reads the auth_exp cookie (unix seconds) written by the server whenever the
// auth cookie is issued or renewed, warns before expiry, blocks the UI after it,
// and lets the user sign in again in a popup without reloading the page.
(() => {
  const cfg = document.body.dataset;
  const WARN_SECONDS = Number(cfg.warnSeconds ?? 45);
  const KEEPALIVE_MS = Number(cfg.keepaliveSeconds ?? 20) * 1000;
  const TICK_MS = 1000;

  // Clock skew between this browser and the server, refined from Date response headers.
  let skewMs = Number(cfg.serverNow ?? Date.now()) - Date.now();
  const serverNowMs = () => Date.now() + skewMs;
  const trackSkew = r => {
    const d = r.headers.get('Date');
    if (d) skewMs = new Date(d).getTime() - Date.now();
  };

  const readExp = () => Number(document.cookie.match(/(?:^|;\s*)auth_exp=(\d+)/)?.[1] ?? 0);

  const $ = id => document.getElementById(id);
  const ui = {
    warning: $('session-warning'), warningText: $('session-warning-text'),
    overlay: $('session-expired'), overlayMsg: $('session-expired-msg'),
    state: $('dbg-state'), exp: $('dbg-exp'), left: $('dbg-left'),
    log: $('dbg-log'), activity: $('dbg-activity'),
  };

  let state = 'ok';
  let serverRejected = false;      // server said 401 even though auth_exp looks valid
  let lastActivity = 0;
  let lastPing = Date.now();
  const waiters = [];

  function log(msg) {
    console.debug('[session]', msg);
    if (!ui.log) return;
    const li = document.createElement('li');
    li.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    ui.log.prepend(li);
  }

  const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ---- activity → keep-alive ------------------------------------------------
  for (const ev of ['keydown', 'pointerdown', 'input', 'wheel']) {
    addEventListener(ev, () => { if (state !== 'expired') lastActivity = Date.now(); },
      { passive: true, capture: true });
  }
  const activityCounts = () => ui.activity ? ui.activity.checked : true;

  // ---- main loop ------------------------------------------------------------
  function tick() {
    const exp = readExp();
    const left = exp ? Math.floor(exp - serverNowMs() / 1000) : 0;

    if (ui.exp) ui.exp.textContent = exp ? new Date(exp * 1000 - skewMs).toLocaleTimeString() : '(no auth_exp cookie)';
    if (ui.left) ui.left.textContent = `${Math.max(left, 0)} s`;

    if (serverRejected) return setState('expired', 'server');
    if (left <= 0) return setState('expired', 'inactivity');

    if (activityCounts() && lastActivity > lastPing && Date.now() - lastPing >= KEEPALIVE_MS) {
      keepAlive('activity');
    }
    setState(left <= WARN_SECONDS ? 'warning' : 'ok', left);
  }

  function setState(next, info) {
    if (next === 'warning') {
      ui.warningText.textContent = `You'll be signed out in ${fmt(info)} due to inactivity.`;
    }
    if (next === state) return;

    log(`state ${state} → ${next}${typeof info === 'string' ? ` (${info})` : ''}`);
    state = next;
    if (ui.state) ui.state.textContent = next;
    ui.warning.hidden = next !== 'warning';

    if (next === 'expired') {
      ui.overlayMsg.textContent = info === 'server'
        ? 'The server no longer accepts your sign-in.'
        : 'You were signed out because of inactivity.';
      if (!ui.overlay.open) ui.overlay.showModal();
    } else if (ui.overlay.open) {
      ui.overlay.close();
    }
  }

  // Esc must not dismiss the expired overlay.
  ui.overlay.addEventListener('cancel', e => e.preventDefault());

  async function keepAlive(reason) {
    lastPing = Date.now();
    try {
      const r = await fetch('/session/keepalive', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      trackSkew(r);
      if (r.status === 401) { serverRejected = true; log(`keep-alive (${reason}) → 401`); }
      else log(`keep-alive (${reason}) → ${r.status}`);
    } catch (e) {
      log(`keep-alive failed: ${e.message}`);
    }
    tick();
  }

  // ---- signing in again -----------------------------------------------------
  function signInAgain() {
    const w = window.open('/session/reauth', 'session-reauth', 'width=520,height=680');
    if (!w) {
      ui.overlayMsg.textContent = 'The sign-in popup was blocked. Allow popups for this site, or use "Sign in with redirect".';
      log('popup blocked');
      return;
    }
    log('sign-in popup opened');
  }

  function signInWithRedirect() {
    // Page scripts keep drafts in sessionStorage; give them a last chance to flush.
    document.dispatchEvent(new CustomEvent('session:before-redirect'));
    location.href = '/session/reauth?returnUrl=' + encodeURIComponent(location.pathname + location.search);
  }

  addEventListener('message', async e => {
    if (e.origin !== location.origin || e.data !== 'session:reauthenticated') return;
    log('signed in again');
    serverRejected = false;
    lastPing = Date.now();
    await refreshAntiforgery();
    tick();
    waiters.splice(0).forEach(resolve => resolve());
  });

  async function refreshAntiforgery() {
    try {
      const r = await fetch('/session/antiforgery', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!r.ok) return log(`antiforgery refresh → ${r.status}`);
      const { token } = await r.json();
      document.querySelectorAll('input[name="__RequestVerificationToken"]').forEach(i => i.value = token);
      log('antiforgery token refreshed');
    } catch (e) {
      log(`antiforgery refresh failed: ${e.message}`);
    }
  }

  const waitForSignIn = () => new Promise(resolve => waiters.push(resolve));

  // ---- fetch wrapper for app code ------------------------------------------
  function authHeaders() {
    return {
      'X-Requested-With': 'XMLHttpRequest',
      'RequestVerificationToken':
        document.querySelector('input[name="__RequestVerificationToken"]')?.value ?? '',
    };
  }

  async function authFetch(url, opts = {}) {
    const send = async () => {
      const r = await fetch(url, { ...opts, headers: { ...opts.headers, ...authHeaders() } });
      trackSkew(r);
      return r;
    };

    if (state === 'expired') {
      log(`${url}: waiting for sign-in`);
      await waitForSignIn();
    }

    let r = await send();
    if (r.status === 401) {
      log(`${url} → 401, waiting for sign-in`);
      serverRejected = true;
      tick();
      await waitForSignIn();
      log(`${url}: retrying`);
      r = await send();
    }
    if (r.status !== 401) lastPing = Date.now();   // an authenticated request also slides the cookie
    return r;
  }

  // ---- wiring ---------------------------------------------------------------
  $('session-stay')?.addEventListener('click', () => keepAlive('stay signed in'));
  $('session-signin')?.addEventListener('click', signInAgain);
  $('session-signin-redirect')?.addEventListener('click', signInWithRedirect);
  $('dbg-ping')?.addEventListener('click', () => keepAlive('manual'));
  $('dbg-kill')?.addEventListener('click', async () => {
    const r = await fetch('/debug/kill-auth-cookie', {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    log(`auth cookie removed by the server (→ ${r.status}); auth_exp kept, so the UI still shows "ok" until a request fails`);
  });

  setInterval(tick, TICK_MS);
  addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();

  window.SessionUI = { authFetch, keepAlive, log };
})();
