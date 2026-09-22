// Renaissance Rodeo — mailing-list signup. Loaded with `defer` by / and /es/,
// BEFORE the Turnstile loader (also deferred, so they run in document order):
// the loader resolves the data-*-callback names on the .cf-turnstile div
// against window when it renders the widget and silently drops any it cannot
// find, so the rrTurnstile* functions below must exist first.
// Posts form-encoded to /api/subscribe on this origin; the Worker checks the
// Turnstile token and forwards the address to MailerLite. Cloudflare's loader
// renders the widget itself; this script only reads the token from it and
// resets it when the server rejects a submission or the widget itself fails.
(function () {
  'use strict';

  // Widget state, set by the callbacks the .cf-turnstile div names. The CSP has
  // no inline script, so they must be plain globals defined here.
  let widgetFailed = false;   // error-callback or timeout-callback fired
  let tokenExpired = false;   // expired-callback fired; cleared once a fresh token is seen

  window.rrTurnstileError = function rrTurnstileError() {
    widgetFailed = true;
    // Returning nothing keeps Turnstile's own console line for the error code.
  };
  window.rrTurnstileTimeout = function rrTurnstileTimeout() {
    widgetFailed = true;
  };
  window.rrTurnstileExpired = function rrTurnstileExpired() {
    tokenExpired = true;
    // Turnstile leaves the dead token in its hidden field; drop it so the
    // fallback in turnstileToken() cannot resend it.
    const hidden = document.querySelector('form.signup input[name="cf-turnstile-response"]');
    if (hidden) hidden.value = '';
  };

  const form = document.querySelector('form.signup');
  if (!form) return;

  const input = form.querySelector('input[type="email"]');
  const button = form.querySelector('button[type="submit"]');
  // Named rr_ref, not like an address-book field (organisation and the like):
  // browser autofill recognises those and fills them, which the Worker would
  // read as a bot. Keep in step with the Worker and the tests.
  const honeypot = form.querySelector('input[name="rr_ref"]');
  const widget = form.querySelector('.cf-turnstile');
  const msg = document.getElementById('signup-msg');
  const okBox = document.getElementById('signup-ok');
  if (!input || !button || !msg || !okBox) return;

  // Per-language strings from the JSON block in the page (the only inline
  // script the CSP permits, and it is data, not code).
  let i18n = {};
  try {
    const block = document.getElementById('signup-i18n');
    i18n = JSON.parse(block ? block.textContent : '{}') || {};
  } catch (_) {
    i18n = {};
  }
  const text = (key) => (typeof i18n[key] === 'string' ? i18n[key] : '');

  const idleLabel = button.textContent;
  const TOKEN_WAIT_MS = 4000;
  const TOKEN_POLL_MS = 250;

  // JS is running, so this script owns the messages. Without JS the browser's
  // own validation still applies (the attribute is deliberately not in the markup).
  form.noValidate = true;

  // A hint for the typist; the Worker does the real validation.
  const EMAIL_HINT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function turnstileToken() {
    if (window.turnstile && widget) {
      try {
        // getResponse() still hands back the old token after it expires (and
        // logs a warning), so ask first; with refresh-expired=auto the widget
        // is already fetching a new one and the poll below picks it up.
        if (typeof window.turnstile.isExpired === 'function' && window.turnstile.isExpired(widget)) return '';
        const t = window.turnstile.getResponse(widget);
        if (t) {
          tokenExpired = false;
          return t;
        }
      } catch (_) { /* widget not rendered yet */ }
    }
    if (tokenExpired) return '';
    const hidden = form.querySelector('input[name="cf-turnstile-response"]');
    return hidden && hidden.value ? hidden.value : '';
  }

  function resetWidget() {
    if (window.turnstile && widget) {
      try { window.turnstile.reset(widget); } catch (_) { /* nothing to reset */ }
    }
  }

  // Resolves with a token, or with '' when the widget has reported failure
  // (at once — there is nothing to wait for) or the deadline passes.
  function waitForToken() {
    return new Promise((resolve) => {
      const deadline = Date.now() + TOKEN_WAIT_MS;
      const poll = () => {
        const t = turnstileToken();
        if (t || widgetFailed || Date.now() >= deadline) return resolve(t);
        setTimeout(poll, TOKEN_POLL_MS);
      };
      poll();
    });
  }

  function setBusy(busy) {
    button.disabled = busy;
    button.textContent = busy ? (text('sending') || idleLabel) : idleLabel;
  }

  function showError(key) {
    msg.textContent = text(key) || text('server_error');
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = (input.value || '').trim();
    msg.textContent = '';

    if (!EMAIL_HINT.test(email)) {
      showError('invalid');
      input.focus();
      return;
    }

    setBusy(true);
    try {
      const token = await waitForToken();
      if (!token) {
        if (widgetFailed) {
          // The widget errored or timed out, so no token is coming. Reset it
          // so the next click starts a fresh challenge; the flag is cleared
          // first because the callback re-arms it if the reset fails too.
          widgetFailed = false;
          showError('unavailable');
          resetWidget();
          return;
        }
        if (!window.turnstile) {
          // The loader never ran (blocked by an extension, a proxy or a
          // network that cannot reach challenges.cloudflare.com), so no
          // challenge will ever appear — do not tell the visitor to wait for one.
          showError('unavailable');
          return;
        }
        // The widget is most likely still showing its challenge. Resetting it
        // here would throw that challenge away, so it is left alone.
        showError('challenge_pending');
        return;
      }

      const body = new URLSearchParams();
      body.set('email', email);
      body.set('rr_ref', honeypot ? honeypot.value : '');
      body.set('lang', form.dataset.lang || 'en');
      body.set('cf-turnstile-response', token);

      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data && data.ok) {
        form.hidden = true;
        okBox.hidden = false;
        okBox.focus();
        return;
      }

      // Server said no: the token is spent either way, so get a fresh one.
      showError(data && data.error && text(data.error) ? data.error : 'server_error');
      resetWidget();
    } catch (err) {
      // fetch() rejects with a TypeError when the network is down.
      showError(err instanceof TypeError ? 'network' : 'server_error');
      resetWidget();
    } finally {
      setBusy(false);
      // Disabling a focused button drops focus to <body> in Chromium; put it back
      // so a keyboard user can retry without tabbing through the whole form.
      if (!form.hidden && document.activeElement === document.body) button.focus();
    }
  });
})();
