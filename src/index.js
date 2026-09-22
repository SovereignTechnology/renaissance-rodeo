/**
 * Renaissance Rodeo — one Worker serving the static site plus the mailing-list API.
 *
 *   POST /api/subscribe   same-origin -> rate limit -> size cap -> honeypot
 *                         -> Turnstile -> email -> MailerLite -> {ok}
 *   everything else       the static assets in public/ (404.html for misses)
 *
 * Rules this file exists to enforce:
 *   1. The client-side email check in signup.js is a UX hint. This is the gate.
 *   2. Subscriber addresses never reach a log line or an error body.
 *   3. The response to a signup is identical whether or not the address was
 *      already on the list — and whether or not MailerLite refused it — so the
 *      form cannot be used to test membership or list history.
 *   4. Every security control fails CLOSED. DEV_MODE relaxes two of them and is
 *      set only in .dev.vars, which is gitignored and never deployed; on a
 *      production hostname it is a config error and refuses signups outright.
 *   5. MailerLite is the ONLY copy of the list — there is no local store. So
 *      the MailerLite call is awaited and a failure is answered as a retryable
 *      error: a background sync that quietly lost an address would be worse
 *      than an honest "try again in a minute".
 */

const SECURITY_HEADERS = {
  // HSTS is per-host, so every page already carries it via public/_headers;
  // repeating it here means the API and the Worker-served 404 do too.
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  // Must stay byte-identical to the Content-Security-Policy line in
  // public/_headers: the asset layer serves the pages with that file, this
  // object covers API and 404 responses. test/index.spec.js asserts equality.
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self'",
    // The page's own CSS is an external file, but 'unsafe-inline' stays on
    // style-src for the first deploy: Turnstile's widget injects inline styles
    // when it has to show a visible challenge. It comes off once the
    // forced-challenge sitekey (3x…FF) renders without a violation.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // No inline scripts anywhere (signup.js is a file), so script-src carries
    // no 'unsafe-inline'. Turnstile's loader and its challenge frame are the
    // only third-party origins on the whole site.
    'script-src \'self\' https://challenges.cloudflare.com',
    'frame-src https://challenges.cloudflare.com',
    "connect-src 'self'",
  ].join('; '),
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** Largest signup body we will even parse. A real one is a few hundred bytes. */
const MAX_BODY_BYTES = 4096;

const MAILERLITE_API = 'https://connect.mailerlite.com/api';

/**
 * The MailerLite call is awaited (rule 5), so this bounds how long a signup
 * can hang — after it the person sees a retryable error instead of a spinner.
 */
const MAILERLITE_TIMEOUT_MS = 10_000;

/**
 * Same idea for the siteverify hop before it. A timeout is a fetch error,
 * which passesTurnstile already treats as a failed challenge (closed).
 */
const TURNSTILE_TIMEOUT_MS = 10_000;

/** Cloudflare's documented Turnstile test secrets. All of them always pass. */
const TEST_SECRET_RE = /^[123]x0{10}/;

/**
 * MailerLite group ids are 18-digit numbers. Anything else — the placeholder
 * left in wrangler.jsonc, '0', a bare JSON number — is a config error, not a
 * group. It must not reach upstream, where it comes back as a 422 that reads
 * like a bad address. Strings only: String() of a number that JSON has already
 * rounded is a different group, silently.
 */
const GROUP_ID_RE = /^[1-9][0-9]{5,19}$/;
const isGroupId = (value) => typeof value === 'string' && GROUP_ID_RE.test(value);

/**
 * Hostnames the site is ever served on for real. DEV_MODE reaching one of
 * them (a vars entry, a --var flag, the dashboard) would switch off the
 * hostname check and the test-secret refusal with no log line, so on these it
 * is a config error and fails closed. `wrangler dev` answers on localhost or
 * a LAN address, which never matches.
 */
const PROD_HOST_RE = /(^|\.)renaissance\.rodeo$|\.workers\.dev$/i;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...SECURITY_HEADERS } });

/**
 * The one success body. Used for a new address, an address that was already
 * on the list, and a stuffed honeypot alike (rule 3).
 */
const subscribed = () => json({ ok: true, status: 'subscribed' });

/**
 * Deliberately stricter than the regex in signup.js: one @, no whitespace or
 * address-separator characters in the local part, a real dot-separated domain,
 * and an alphabetic TLD. Length is bounded separately so the regex never sees
 * an unbounded string.
 */
const EMAIL_RE =
  /^[^\s@,;:<>()[\]\\"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return null;
  return EMAIL_RE.test(email) ? email : null;
}

/**
 * Browsers attach Origin to every POST, including same-origin ones, so this
 * rejects cross-site form posts without needing a CORS preflight. There is no
 * Access-Control-Allow-Origin anywhere in this file on purpose.
 */
function isSameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    // The whole origin, scheme included. While http://renaissance.rodeo is
    // still served without a redirect, a plain-HTTP page must not be able to
    // post to the HTTPS API. `wrangler dev` is http on both sides and
    // production is https on both, so nothing legitimate changes.
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

/**
 * Throttling fails OPEN when the binding is unavailable — Turnstile is the real
 * gate, and a missing rate limiter should not take the form offline. Checked
 * before the body is parsed so a flood cannot make us do the expensive work.
 */
async function isRateLimited(env, key) {
  const limiter = env.SUBSCRIBE_LIMIT;
  if (!limiter || typeof limiter.limit !== 'function') return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

/**
 * Turnstile fails CLOSED: a missing secret, a network error, a non-200, and a
 * hostname that is missing or is not ours all count as failure.
 *
 * The hostname check matters because a token is only proof that *somebody*
 * solved a challenge for this sitekey. Verifying `hostname` ties it to this
 * site, so a token minted on an attacker-controlled page cannot be replayed
 * here even if the widget's domain allow-list is ever loosened. DEV_MODE
 * skips it because `wrangler dev` answers on whatever address it was bound to.
 */
async function passesTurnstile(token, secret, ip, expectedHostname, devMode) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;

  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    // Every refusal logs something address-free: a sitekey/secret mismatch
    // and a Turnstile outage otherwise look identical to a bot wave — a run
    // of 403s with nothing to explain them. The token itself is never logged.
    if (!res.ok) {
      console.error(`turnstile siteverify HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    if (data.success !== true) {
      // Only Cloudflare's documented, enumerable codes get through
      // (invalid-input-secret, timeout-or-duplicate, …); anything else is '?'.
      console.error(
        'turnstile siteverify rejected the token: ' +
          (Array.isArray(data['error-codes'])
            ? data['error-codes'].filter((c) => typeof c === 'string' && /^[a-z-]{1,40}$/.test(c)).join(',')
            : 'no-error-codes')
      );
      return false;
    }
    // An absent hostname is a mismatch too. Cloudflare sends the field on
    // every success today; if that ever changed, guarding on its presence
    // would make this check vanish silently instead of failing closed.
    if (!devMode && data.hostname !== expectedHostname) {
      console.error('turnstile hostname mismatch; token was minted elsewhere');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function readSubmission(request) {
  const declared = Number(request.headers.get('content-length') || '0');
  if (declared > MAX_BODY_BYTES) return null;

  const type = request.headers.get('content-type') || '';
  // Read the bytes first so an undeclared or chunked body is still bounded —
  // and bounded in BYTES: a string-length check counts UTF-16 units, so 4 KB
  // of three-byte characters would have passed as "4096 long".
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  const raw = new TextDecoder().decode(bytes);

  if (type.includes('application/json')) {
    return JSON.parse(raw);
  }
  if (type.includes('form')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return null;
}

/**
 * The key names of a MailerLite 422 body's "errors" object and nothing else.
 * The VALUES quote the offending input — the subscriber's address — so they
 * never come out of here (rule 2). Never throws.
 */
async function errorKeys(res) {
  try {
    const data = await res.json();
    const errors = data?.errors;
    if (!errors || typeof errors !== 'object') return 'none';
    const keys = Object.keys(errors).filter((k) => /^[a-z0-9_.]{1,40}$/.test(k));
    return keys.length > 0 ? keys.join(',') : 'none';
  } catch {
    return 'unparseable';
  }
}

/**
 * Upsert one address into MailerLite and turn its answer into ours. Never
 * throws, never logs the address, and reads the response body only on a 422
 * (see errorKeys).
 *
 * POST /subscribers is a non-destructive upsert: 201 for a new address, 200
 * for one MailerLite already knew. Both are "subscribed" to us (rule 3).
 *
 * `status` is deliberately NOT sent. With the account's "double opt-in for
 * API" toggle on, omitting it makes a NEW subscriber get the confirmation
 * email while an EXISTING active one is left alone; sending
 * status:"unconfirmed" would demote actives, and "active" would skip consent.
 */
async function subscribeToMailerLite(email, lang, env) {
  // Group ids are 18-digit numbers that JSON would round, so they travel as
  // strings. The main one was validated by the caller (isGroupId); the
  // Spanish one is optional, so a malformed value is logged and skipped
  // rather than taking every Spanish signup offline.
  const groups = [env.MAILERLITE_GROUP_ID];
  if (lang === 'es' && env.MAILERLITE_GROUP_ID_ES !== undefined) {
    if (isGroupId(env.MAILERLITE_GROUP_ID_ES)) {
      // Spanish-page signups ALSO join the Spanish group, so Spanish campaigns
      // can be targeted without custom fields. Everyone is in the main group.
      groups.push(env.MAILERLITE_GROUP_ID_ES);
    } else {
      console.error('MAILERLITE_GROUP_ID_ES is malformed (must be a quoted 18-digit id); ignoring it');
    }
  }

  let res;
  try {
    res = await fetch(`${MAILERLITE_API}/subscribers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.MAILERLITE_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      // The address travels in the body, never the URL, so a fetch error
      // message (which quotes the URL) cannot carry it into a log line.
      // resubscribe: typing your address into the form is consent, so an
      // address that unsubscribed earlier comes back on the list instead of
      // getting our "subscribed" while staying off it. MailerLite may still
      // refuse (abuse prevention) — that is a 422, and a 422 is a success to
      // the visitor, below.
      body: JSON.stringify({ email, groups, resubscribe: true }),
      signal: AbortSignal.timeout(MAILERLITE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('mailerlite: network failure:', err?.message ?? 'unknown error');
    return json({ ok: false, error: 'unavailable' }, 503);
  }

  if (res.status === 200 || res.status === 201) {
    return subscribed();
  }
  if (res.status === 422) {
    // MailerLite refused the address: a domain with no MX, say — or one the
    // account has history with (blocked, junk, a refused resubscribe). The
    // second kind is exactly what rule 3 forbids revealing, so this is the
    // SUCCESS body, not a 400; the visitor loses only a message the
    // client-side hint already gives. The body is read here and only here,
    // and only the key names of its "errors" object reach the log — the
    // values quote the offending input, i.e. the address (rule 2).
    console.error(
      `mailerlite: HTTP 422 (upstream refused the address); error keys: ${await errorKeys(res)}`
    );
    return subscribed();
  }
  if (res.status === 401 || res.status === 403) {
    // Wrong or revoked key. The person cannot fix this, so it is "unavailable"
    // to them and a loud line for us.
    console.error(`mailerlite: the API key was rejected (HTTP ${res.status})`);
    return json({ ok: false, error: 'unavailable' }, 503);
  }
  if (res.status === 429) {
    // 120 requests/min upstream. Only a plain number is echoed from the header.
    const retryAfter = res.headers.get('retry-after') ?? '';
    console.error(
      `mailerlite: throttled; retry-after=${/^[0-9]{1,6}$/.test(retryAfter) ? retryAfter : '?'}`
    );
    return json({ ok: false, error: 'unavailable' }, 503);
  }
  console.error(`mailerlite: HTTP ${res.status}`);
  return json({ ok: false, error: 'unavailable' }, 503);
}

async function handleSubscribe(request, env, url) {
  const devMode = env.DEV_MODE === 'true';

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }
  if (!isSameOrigin(request, url)) {
    return json({ ok: false, error: 'bad_origin' }, 403);
  }

  // Throttle before doing any parsing, so a flood costs us as little as possible.
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (await isRateLimited(env, ip || 'anonymous')) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  let payload;
  try {
    payload = await readSubmission(request);
  } catch {
    // JSON.parse quotes a snippet of its input in the error message, which
    // could be the address — so the error is dropped here, never logged.
    payload = null;
  }
  if (!payload || typeof payload !== 'object') {
    return json({ ok: false, error: 'invalid' }, 400);
  }

  // Honeypot. Real browsers leave this empty because it is off-screen and
  // aria-hidden; scripted stuffers fill every field they find. Answer with the
  // plain success so the bot has nothing to learn, and call nobody.
  //
  // It is named rr_ref, not "company": Chromium fills a company/organization
  // input when a visitor autofills their postal address, which produced silent
  // false positives. Logged (without the address) so a run of hits from real
  // people would at least be visible.
  if (typeof payload.rr_ref === 'string' && payload.rr_ref.trim() !== '') {
    console.error('honeypot hit');
    return subscribed();
  }

  // Config errors from here on answer 503. They sit below the origin, throttle
  // and honeypot checks so a misconfigured deploy still refuses cross-origin
  // and stuffed posts the same way a configured one does — and fails loudly.
  if (devMode && PROD_HOST_RE.test(url.hostname)) {
    // DEV_MODE would relax the two Turnstile checks below. On a real hostname
    // that is never intended, so it is treated as a broken deploy, not a mode.
    console.error('DEV_MODE is set on a production hostname; refusing signups');
    return json({ ok: false, error: 'unavailable' }, 503);
  }
  if (!env.TURNSTILE_SECRET) {
    // Loud failure beats silently accepting unverified signups.
    console.error('TURNSTILE_SECRET is not configured; refusing signups');
    return json({ ok: false, error: 'unavailable' }, 503);
  }
  if (!devMode && TEST_SECRET_RE.test(env.TURNSTILE_SECRET)) {
    // A test secret accepts every token. Deployed to production that is an open
    // door which nothing would report, so refuse instead of quietly passing.
    console.error(
      'TURNSTILE_SECRET is a Cloudflare test value; refusing signups — set DEV_MODE=true in .dev.vars for local testing'
    );
    return json({ ok: false, error: 'unavailable' }, 503);
  }
  const verified = await passesTurnstile(
    payload['cf-turnstile-response'],
    env.TURNSTILE_SECRET,
    ip,
    url.hostname,
    devMode
  );
  if (!verified) {
    return json({ ok: false, error: 'challenge_failed' }, 403);
  }

  const email = normaliseEmail(payload.email);
  if (!email) {
    return json({ ok: false, error: 'invalid' }, 400);
  }

  // Both are needed to do anything at all. Checked after the challenge so an
  // unverified post never learns which of them is missing.
  if (!env.MAILERLITE_API_KEY) {
    console.error('MAILERLITE_API_KEY is not configured; refusing signups');
    return json({ ok: false, error: 'unavailable' }, 503);
  }
  if (!isGroupId(env.MAILERLITE_GROUP_ID)) {
    // Shape, not truthiness: the wrangler.jsonc placeholder, '0' and a bare
    // number all pass a truthiness check and then come back from MailerLite
    // as a 422 that blames the visitor. The value is never logged.
    console.error(
      `MAILERLITE_GROUP_ID is ${env.MAILERLITE_GROUP_ID === undefined ? 'not configured' : 'malformed (must be a quoted 18-digit id)'}; refusing signups`
    );
    return json({ ok: false, error: 'unavailable' }, 503);
  }

  // The form says which page it is on. Anything but exactly 'es' is English:
  // the value is user-controlled and only ever compared, never stored or
  // echoed, so there is nothing to sanitise.
  const lang = payload.lang === 'es' ? 'es' : 'en';

  // Awaited on purpose — see rule 5.
  return subscribeToMailerLite(email, lang, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/subscribe') {
      try {
        return await handleSubscribe(request, env, url);
      } catch (err) {
        // Every expected failure above answers with its own code, so this is
        // only ever a bug. Without it the runtime answers with its own HTML
        // error page, which signup.js cannot parse. Message only, never the
        // stack — and nothing on this path throws with request data in its
        // message: body parsing and both outbound calls catch their own.
        console.error('subscribe: unhandled error:', err?.message ?? 'unknown error');
        return json({ ok: false, error: 'server_error' }, 500);
      }
    }

    // Requests that match a file in public/ are served by the asset layer and
    // never reach this Worker, so their headers come from public/_headers.
    // This path runs for misses, which the asset layer answers with 404.html,
    // and for every request during tests — either way the same headers go on.
    if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
      // A renamed or dropped binding would otherwise throw here, outside any
      // try/catch, and the runtime's HTML error page would stand in for 404s.
      console.error('ASSETS binding is missing');
      return json({ ok: false, error: 'server_error' }, 500);
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  },
};
