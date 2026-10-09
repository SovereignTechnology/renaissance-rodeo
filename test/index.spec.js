import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const ORIGIN = 'http://example.com';
const API = `${ORIGIN}/api/subscribe`;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAILERLITE_URL = 'https://connect.mailerlite.com/api/subscribers';

/** Cloudflare's documented always-passes Turnstile test secret. Not a credential. */
const TEST_SECRET = '1x0000000000000000000000000000000AA';
/** Shaped unlike a test secret so the test-secret refusal does not fire. Not a credential. */
const FAKE_SECRET = 'unit-test-turnstile-secret-not-a-real-credential';
const GROUP = '111111111111111111';
const GROUP_ES = '222222222222222222';
/** Mirrors GROUP_ID_RE in src/index.js: a quoted 18-digit MailerLite group id. */
const GROUP_ID_RE = /^[1-9][0-9]{5,19}$/;

const SUCCESS = { ok: true, status: 'subscribed' };

/** Drive the Worker the way the runtime does, including background work. */
async function call(request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// When the runtime provides the SUBSCRIBE_LIMIT binding it counts 5 per 60 s
// per IP, and one address shared across this file would trip it part-way
// through. Every signup gets its own documentation-range address instead.
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 254) + 1}`;

/**
 * A form post from the page. `origin: null` sends no Origin header at all;
 * `url` moves the whole request to another host (see `at`).
 */
function signup(
  fields,
  { origin = ORIGIN, contentType = 'application/x-www-form-urlencoded', url = API } = {}
) {
  const headers = { 'content-type': contentType, 'cf-connecting-ip': nextIp() };
  if (origin !== null) headers.origin = origin;
  const body =
    contentType === 'application/json' ? JSON.stringify(fields) : new URLSearchParams(fields);
  return new Request(url, { method: 'POST', headers, body });
}

/** The same-origin post as it would arrive on a given production hostname. */
const at = (host) => ({ url: `https://${host}/api/subscribe`, origin: `https://${host}` });

const HOPEFUL = { email: 'hopeful@example.com', 'cf-turnstile-response': 'stub-token' };

// Outbound calls. Turnstile posts FormData, MailerLite posts JSON; both go
// through the global fetch, which is replaced per test. Never let the stub
// itself throw by accident: passesTurnstile catches fetch errors and fails
// closed, so a broken stub would look exactly like a rejected challenge.
let calls;
let realFetch;

function stubFetch(responder) {
  calls = [];
  if (!realFetch) realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init.body) {
      body = '[non-string body]';
    }
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body });
    return responder(String(url), init);
  };
}

const reply = (payload, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Turnstile passes; MailerLite answers whatever `mailerlite()` returns. */
function stubTurnstileThen(mailerlite) {
  stubFetch((url) => (url === SITEVERIFY ? reply({ success: true }) : mailerlite()));
}

const turnstileCalls = () => calls.filter((c) => c.url === SITEVERIFY);
const mailerliteCalls = () => calls.filter((c) => c.url.startsWith('https://connect.mailerlite.com'));

/**
 * Rule 2 in src/index.js: a subscriber address never reaches a log line. Every
 * test that drives a path which logs watches console.error and then asserts
 * that (a) something was logged, so the check is not vacuous, and (b) none of
 * it names the address — or contains an '@' at all. The original console.error
 * still runs, so the lines stay visible when a test fails.
 */
const watchErrorLog = () => vi.spyOn(console, 'error');
const logged = (spy) => spy.mock.calls.flat().map(String).join(' ');
function expectLogWithoutAddress(spy) {
  expect(spy).toHaveBeenCalled();
  expect(logged(spy)).not.toMatch(/hopeful|@/);
}

/** Everything a real signup needs: .dev.vars' two values plus a fake key and group. */
function configure() {
  env.DEV_MODE = 'true';
  env.TURNSTILE_SECRET = TEST_SECRET;
  env.MAILERLITE_API_KEY = 'fake-key-for-tests';
  env.MAILERLITE_GROUP_ID = GROUP;
}

const realLimiter = env.SUBSCRIBE_LIMIT;
const realAssets = env.ASSETS;

beforeEach(() => {
  // The pool seeds env from .dev.vars (DEV_MODE + the test secret) when that
  // file exists. Every test starts from nothing and sets only what it proves.
  delete env.DEV_MODE;
  delete env.TURNSTILE_SECRET;
  delete env.MAILERLITE_API_KEY;
  delete env.MAILERLITE_GROUP_ID;
  delete env.MAILERLITE_GROUP_ID_ES;
  if (realLimiter === undefined) delete env.SUBSCRIBE_LIMIT;
  else env.SUBSCRIBE_LIMIT = realLimiter;
  env.ASSETS = realAssets;
  // Default stub: nothing may leave the runtime. A call that tries is recorded
  // (so a test can assert zero) and refused.
  stubFetch(() => {
    throw new Error('unexpected outbound call');
  });
});

afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  // Puts console.error back after a watchErrorLog() test.
  vi.restoreAllMocks();
});

describe('wrangler.jsonc guard', () => {
  // vitest.config.mjs reads wrangler.jsonc with wrangler's own parser and
  // hands the parts that matter over as TEST_WRANGLER_* strings. The pool
  // seeds env from `vars`, and beforeEach deletes exactly those keys, so
  // nothing else in this file could notice a poisoned config.
  it('carries no DEV_MODE or secret in vars', () => {
    // Guard the guard: an absent binding would mean the config read failed.
    expect(typeof env.TEST_WRANGLER_VAR_KEYS).toBe('string');
    const keys = JSON.parse(env.TEST_WRANGLER_VAR_KEYS);
    expect(Array.isArray(keys)).toBe(true);
    for (const forbidden of ['DEV_MODE', 'TURNSTILE_SECRET', 'MAILERLITE_API_KEY', 'MAILERLITE_WEBHOOK_SECRET']) {
      expect(keys, `${forbidden} must never be a var`).not.toContain(forbidden);
    }
  });

  it('has every configured group id as a quoted 18-digit id — the placeholder fails', () => {
    const ids = JSON.parse(env.TEST_WRANGLER_GROUP_IDS);
    expect(Object.keys(ids).sort()).toEqual(['MAILERLITE_GROUP_ID', 'MAILERLITE_GROUP_ID_ES']);
    for (const [name, value] of Object.entries(ids)) {
      // Absent is the committed state: the whole vars block is a comment.
      if (value === null) continue;
      expect(typeof value, `${name} must be a quoted string`).toBe('string');
      expect(value, `${name} is not a real group id (still the placeholder?)`).toMatch(GROUP_ID_RE);
    }
  });

  it('turns workers_dev off once routes are set', () => {
    const routes = Number(env.TEST_WRANGLER_ROUTES_COUNT);
    expect(Number.isInteger(routes)).toBe(true);
    expect(['true', 'false']).toContain(env.TEST_WRANGLER_WORKERS_DEV);
    if (routes > 0) {
      // The workers.dev hostname sits outside the zone's WAF and Always Use
      // HTTPS rules; once the custom domains are live it must be gone.
      expect(env.TEST_WRANGLER_WORKERS_DEV).toBe('false');
    }
  });
});

describe('request gate', () => {
  it('refuses a non-POST with 405 and the site headers', async () => {
    const res = await call(new Request(API, { method: 'GET' }));

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ ok: false, error: 'method_not_allowed' });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('rejects a cross-origin post before anything else', async () => {
    configure();
    const res = await call(signup(HOPEFUL, { origin: 'https://evil.test' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_origin' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a post with no Origin header at all', async () => {
    configure();
    const res = await call(signup(HOPEFUL, { origin: null }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_origin' });
  });

  it('rejects an Origin whose host matches but whose scheme does not', async () => {
    // The API is reached over http:// here; an https:// page on the same host
    // is a different origin, and the reverse (a plain-http page posting to the
    // https API) is the case that matters in production.
    configure();
    const res = await call(signup(HOPEFUL, { origin: 'https://example.com' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_origin' });
    expect(calls).toHaveLength(0);
  });

  it('answers 429 when the rate limiter says no, keyed on the client IP', async () => {
    configure();
    const seen = [];
    env.SUBSCRIBE_LIMIT = {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: false };
      },
    };
    const req = signup(HOPEFUL);
    const res = await call(req);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect(seen).toEqual([req.headers.get('cf-connecting-ip')]);
    expect(calls).toHaveLength(0);
  });

  // Throttling fails OPEN on purpose (src/index.js, isRateLimited): Turnstile
  // is the real gate, and a misbehaving limiter must not take the form
  // offline. These two pin that so a well-meant "harden to fail closed" is
  // caught in CI rather than by the first signup after the binding hiccups.
  it('lets the signup through when the rate limiter throws', async () => {
    configure();
    env.SUBSCRIBE_LIMIT = {
      limit: async () => {
        throw new Error('limiter down');
      },
    };
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(mailerliteCalls()).toHaveLength(1);
  });

  it('lets the signup through when the rate limiter binding is missing', async () => {
    configure();
    delete env.SUBSCRIBE_LIMIT;
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(mailerliteCalls()).toHaveLength(1);
  });

  it('refuses a body over the size cap without parsing it', async () => {
    configure();
    const res = await call(signup({ ...HOPEFUL, note: 'x'.repeat(5000) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('caps the body in bytes, not in UTF-16 units', async () => {
    configure();
    // 2100 × '€' is 2100 UTF-16 units — comfortably under 4096 — but three
    // bytes each, 6300 bytes on the wire. A string-length check would let it
    // through. JSON keeps the characters as-is (a form encoding would
    // percent-escape them and prove nothing).
    const fields = { ...HOPEFUL, note: '€'.repeat(2100) };
    const text = JSON.stringify(fields);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(4096);

    const res = await call(signup(fields, { contentType: 'application/json' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a body it cannot parse', async () => {
    configure();
    for (const [contentType, body] of [
      ['text/plain', 'email=hopeful@example.com'],
      ['application/json', '{not json'],
      ['application/json', '"just a string"'],
    ]) {
      const res = await call(
        new Request(API, {
          method: 'POST',
          headers: { 'content-type': contentType, origin: ORIGIN, 'cf-connecting-ip': nextIp() },
          body,
        })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('honeypot', () => {
  it('answers a stuffed honeypot with the real success body, calls nobody, and logs a hit', async () => {
    // Nothing configured on purpose: the honeypot branch runs before every
    // secret is looked at, so a bot learns nothing even from a broken deploy.
    const spy = watchErrorLog();
    const res = await call(signup({ ...HOPEFUL, rr_ref: 'Acme Widgets' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(calls).toHaveLength(0);
    expect(logged(spy)).toContain('honeypot hit');
    expect(logged(spy)).not.toContain('Acme');
    expectLogWithoutAddress(spy);
  });

  it('ignores the old field name, so an autofilled "company" is not a hit', async () => {
    // The field was renamed away from "company" because Chromium fills that
    // name from a visitor's saved postal address. A stray value there must
    // now go through the normal path (here: refused for the missing secret).
    const res = await call(signup({ ...HOPEFUL, company: 'Acme Widgets' }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('DEV_MODE production guard', () => {
  for (const host of ['renaissance.rodeo', 'www.renaissance.rodeo', 'renaissance-rodeo.example.workers.dev']) {
    it(`refuses signups with 503 when DEV_MODE is set on ${host}`, async () => {
      configure();
      const spy = watchErrorLog();
      stubTurnstileThen(() => reply({}, 201));
      const res = await call(signup(HOPEFUL, at(host)));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
      // Refused before the challenge is even checked: nothing goes out.
      expect(calls).toHaveLength(0);
      expect(logged(spy)).toContain('DEV_MODE is set on a production hostname');
      expectLogWithoutAddress(spy);
    });
  }

  it('still relaxes the checks on a non-production hostname', async () => {
    configure();
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(mailerliteCalls()).toHaveLength(1);
  });

  it('does not fire on a production hostname when DEV_MODE is off', async () => {
    configure();
    delete env.DEV_MODE;
    env.TURNSTILE_SECRET = FAKE_SECRET;
    stubFetch((url) =>
      url === SITEVERIFY ? reply({ success: true, hostname: 'renaissance.rodeo' }) : reply({}, 201)
    );
    const res = await call(signup(HOPEFUL, at('renaissance.rodeo')));

    expect(res.status).toBe(200);
    expect(mailerliteCalls()).toHaveLength(1);
  });
});

describe('Turnstile fails closed', () => {
  it('returns 503 when TURNSTILE_SECRET is unset', async () => {
    env.MAILERLITE_API_KEY = 'fake-key-for-tests';
    env.MAILERLITE_GROUP_ID = GROUP;
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('returns 503 for a Cloudflare test secret outside DEV_MODE', async () => {
    configure();
    delete env.DEV_MODE;
    const spy = watchErrorLog();
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(calls).toHaveLength(0);
    expect(logged(spy)).toContain('set DEV_MODE=true in .dev.vars');
    expect(logged(spy)).not.toContain(TEST_SECRET);
  });

  it('returns 403 when siteverify says success:false, and logs the codes but not the token', async () => {
    configure();
    const spy = watchErrorLog();
    stubFetch(() => reply({ success: false, 'error-codes': ['invalid-input-response', 'bad value@x'] }));
    const res = await call(
      signup({ email: 'hopeful@example.com', 'cf-turnstile-response': 'token-that-must-not-be-logged' })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(turnstileCalls()).toHaveLength(1);
    expect(mailerliteCalls()).toHaveLength(0);
    // Only Cloudflare-shaped codes get through; the free-text one is dropped.
    expect(logged(spy)).toContain('turnstile siteverify rejected the token: invalid-input-response');
    expect(logged(spy)).not.toContain('bad value');
    expect(logged(spy)).not.toContain('must-not-be-logged');
    expectLogWithoutAddress(spy);
  });

  it('logs "no-error-codes" when siteverify rejects without a codes array', async () => {
    configure();
    const spy = watchErrorLog();
    stubFetch(() => reply({ success: false }));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(403);
    expect(logged(spy)).toContain('rejected the token: no-error-codes');
    expectLogWithoutAddress(spy);
  });

  it('returns 403 when siteverify is down, and logs the status but not the token', async () => {
    configure();
    const spy = watchErrorLog();
    stubFetch(() => new Response('upstream error', { status: 502 }));
    const res = await call(
      signup({ email: 'hopeful@example.com', 'cf-turnstile-response': 'token-that-must-not-be-logged' })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(mailerliteCalls()).toHaveLength(0);
    expect(logged(spy)).toContain('turnstile siteverify HTTP 502');
    expect(logged(spy)).not.toContain('must-not-be-logged');
    expectLogWithoutAddress(spy);
  });

  it('returns 403 when the token is missing, without calling siteverify', async () => {
    configure();
    stubFetch(() => reply({ success: true }));
    const res = await call(signup({ email: 'hopeful@example.com' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'challenge_failed' });
    // No token, no call: nothing to verify.
    expect(calls).toHaveLength(0);
  });

  it('refuses a token longer than 2048 characters with zero outbound calls', async () => {
    configure();
    stubFetch(() => reply({ success: true }));
    const res = await call(
      signup({ email: 'hopeful@example.com', 'cf-turnstile-response': 'x'.repeat(2049) })
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(calls).toHaveLength(0);

    // The boundary itself is verified, so the cap is exactly where it says.
    stubTurnstileThen(() => reply({}, 201));
    const edge = await call(
      signup({ email: 'hopeful@example.com', 'cf-turnstile-response': 'x'.repeat(2048) })
    );
    expect(edge.status).toBe(200);
    expect(turnstileCalls()).toHaveLength(1);
  });

  it('ties the token to this hostname outside DEV_MODE', async () => {
    configure();
    delete env.DEV_MODE;
    env.TURNSTILE_SECRET = FAKE_SECRET;
    const spy = watchErrorLog();

    stubFetch((url) =>
      url === SITEVERIFY ? reply({ success: true, hostname: 'evil.test' }) : reply({}, 201)
    );
    const elsewhere = await call(signup(HOPEFUL));
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(mailerliteCalls()).toHaveLength(0);

    // No hostname at all is a mismatch too: the check must fail closed, not
    // vanish, if siteverify ever stops sending the field.
    stubFetch((url) => (url === SITEVERIFY ? reply({ success: true }) : reply({}, 201)));
    const nowhere = await call(signup(HOPEFUL));
    expect(nowhere.status).toBe(403);
    expect(await nowhere.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(mailerliteCalls()).toHaveLength(0);
    expectLogWithoutAddress(spy);

    stubFetch((url) =>
      url === SITEVERIFY ? reply({ success: true, hostname: 'example.com' }) : reply({}, 201)
    );
    const here = await call(signup(HOPEFUL));
    expect(here.status).toBe(200);
    expect(mailerliteCalls()).toHaveLength(1);
  });
});

describe('email validation', () => {
  it('returns 400 on a bad address only after Turnstile has passed', async () => {
    configure();
    for (const email of ['not-an-email', 'two@@example.com', 'a@b', 'x y@example.com', '']) {
      stubTurnstileThen(() => reply({}, 201));
      const res = await call(signup({ email, 'cf-turnstile-response': 'stub-token' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
      // The challenge is checked first, so a bad address still costs a
      // solved challenge — and MailerLite never hears about it.
      expect(turnstileCalls()).toHaveLength(1);
      expect(mailerliteCalls()).toHaveLength(0);
    }
  });
});

describe('group id shape', () => {
  // Truthiness is not a check: every one of these is truthy and every one is
  // wrong. Upstream they would come back as a 422 that blames the visitor.
  for (const [label, value] of [
    ["'0'", '0'],
    ['the old all-zero placeholder', '000000000000000000'],
    ['the wrangler.jsonc placeholder', 'REPLACE_WITH_18_DIGIT_GROUP_ID'],
    ['a whitespace-padded id', ` ${GROUP} `],
    ['a small JSON number', 123],
    ['an 18-digit JSON number', 123456789012345678],
  ]) {
    it(`refuses MAILERLITE_GROUP_ID = ${label} with 503 and no MailerLite call`, async () => {
      configure();
      env.MAILERLITE_GROUP_ID = value;
      const spy = watchErrorLog();
      stubTurnstileThen(() => reply({}, 201));
      const res = await call(signup(HOPEFUL));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
      expect(turnstileCalls()).toHaveLength(1);
      expect(mailerliteCalls()).toHaveLength(0);
      expect(logged(spy)).toContain('MAILERLITE_GROUP_ID is malformed');
      // The var is named, its value is not.
      if (String(value).length > 3) expect(logged(spy)).not.toContain(String(value).trim());
      expectLogWithoutAddress(spy);
    });
  }

  it('ignores a malformed MAILERLITE_GROUP_ID_ES, logs it, and still sends the main group', async () => {
    configure();
    env.MAILERLITE_GROUP_ID_ES = 'REPLACE_WITH_18_DIGIT_GROUP_ID';
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup({ ...HOPEFUL, lang: 'es' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(mailerliteCalls()[0].body.groups).toEqual([GROUP]);
    expect(logged(spy)).toContain('MAILERLITE_GROUP_ID_ES is malformed');
    expect(logged(spy)).not.toContain('REPLACE_WITH');
    expectLogWithoutAddress(spy);
  });

  it('sends a number-typed MAILERLITE_GROUP_ID_ES nowhere, not even stringified', async () => {
    configure();
    env.MAILERLITE_GROUP_ID_ES = 222222222222222222;
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup({ ...HOPEFUL, lang: 'es' }));

    expect(res.status).toBe(200);
    expect(mailerliteCalls()[0].body.groups).toEqual([GROUP]);
    expect(logged(spy)).toContain('MAILERLITE_GROUP_ID_ES is malformed');
  });
});

describe('MailerLite', () => {
  it('makes exactly one POST with the normalised address, the group, resubscribe and no status', async () => {
    configure();
    stubTurnstileThen(() => reply({ data: { id: '1' } }, 201));

    const res = await call(
      signup({ email: '  NewPerson@Example.COM ', lang: 'en', 'cf-turnstile-response': 'stub-token' })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);

    const ml = mailerliteCalls();
    expect(ml).toHaveLength(1);
    expect(ml[0].method).toBe('POST');
    expect(ml[0].url).toBe(MAILERLITE_URL);
    // The address must never appear in the URL — a fetch error message carries
    // the URL straight into Workers Logs.
    expect(ml[0].url).not.toContain('@');
    expect(ml[0].headers.authorization).toBe('Bearer fake-key-for-tests');
    expect(ml[0].headers['content-type']).toBe('application/json');
    expect(ml[0].body).toEqual({ email: 'newperson@example.com', groups: [GROUP], resubscribe: true });
    // `status` is deliberately absent (double opt-in is decided upstream).
    expect(ml[0].body).not.toHaveProperty('status');
    expect(typeof ml[0].body.groups[0]).toBe('string');
  });

  it('accepts a JSON body the same way as a form post', async () => {
    configure();
    stubTurnstileThen(() => reply({}, 201));

    const res = await call(
      signup({ email: 'Json@Example.com', 'cf-turnstile-response': 'stub-token' }, { contentType: 'application/json' })
    );

    expect(res.status).toBe(200);
    expect(mailerliteCalls()[0].body).toEqual({ email: 'json@example.com', groups: [GROUP], resubscribe: true });
  });

  it('adds the Spanish group for lang=es when it is configured', async () => {
    configure();
    env.MAILERLITE_GROUP_ID_ES = GROUP_ES;
    stubTurnstileThen(() => reply({}, 201));

    const res = await call(signup({ ...HOPEFUL, lang: 'es' }));

    expect(res.status).toBe(200);
    expect(mailerliteCalls()[0].body.groups).toEqual([GROUP, GROUP_ES]);
  });

  it('adds nothing for lang=es when the Spanish group is unset', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({}, 201));

    const res = await call(signup({ ...HOPEFUL, lang: 'es' }));

    expect(res.status).toBe(200);
    expect(mailerliteCalls()[0].body.groups).toEqual([GROUP]);
    // Unset is not malformed: an optional var that is simply absent is quiet.
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats anything but exactly "es" as English', async () => {
    configure();
    env.MAILERLITE_GROUP_ID_ES = GROUP_ES;
    for (const lang of ['ES', 'es-SV', 'fr', '', undefined]) {
      stubTurnstileThen(() => reply({}, 201));
      const fields = lang === undefined ? HOPEFUL : { ...HOPEFUL, lang };
      const res = await call(signup(fields));

      expect(res.status).toBe(200);
      expect(mailerliteCalls()[0].body.groups).toEqual([GROUP]);
    }
  });

  it('answers byte-identically for a new (201) and an existing (200) address', async () => {
    configure();
    stubTurnstileThen(() => reply({ data: { id: '1', status: 'unconfirmed' } }, 201));
    const created = await call(signup(HOPEFUL));
    stubTurnstileThen(() => reply({ data: { id: '1', status: 'active' } }, 200));
    const existing = await call(signup(HOPEFUL));

    expect(created.status).toBe(200);
    expect(existing.status).toBe(200);
    expect(await existing.text()).toBe(await created.text());
  });

  it('answers a 422 with the same success body as a 201, logging only the error keys', async () => {
    // Rule 3: MailerLite may 422 for account-state reasons (blocked, junk, a
    // refused resubscribe), so a visible difference would be a list-history
    // oracle. The body is the byte-identical success; the log names the keys
    // of the upstream "errors" object and never their values.
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({ data: { id: '1' } }, 201));
    const created = await call(signup(HOPEFUL));

    stubTurnstileThen(() =>
      reply(
        {
          message: 'The email must be a valid email address.',
          errors: { email: ['The email hopeful@example.com is not deliverable.'] },
        },
        422
      )
    );
    const refused = await call(signup(HOPEFUL));

    expect(refused.status).toBe(200);
    const text = await refused.text();
    expect(JSON.parse(text)).toEqual(SUCCESS);
    expect(text).toBe(await created.text());
    expect(text).not.toContain('hopeful');
    expect(text).not.toContain('deliverable');
    expect(logged(spy)).toContain('mailerlite: HTTP 422 (upstream refused the address); error keys: email');
    expect(logged(spy)).not.toContain('deliverable');
    expectLogWithoutAddress(spy);
  });

  it('logs "none" for a 422 whose keys are not MailerLite-shaped, and survives a non-JSON 422', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() =>
      reply({ errors: { 'hopeful@example.com': ['x'], 'Bad Key': ['y'] } }, 422)
    );
    const odd = await call(signup(HOPEFUL));
    expect(odd.status).toBe(200);
    expect(logged(spy)).toContain('error keys: none');

    stubTurnstileThen(() => new Response('<html>not json</html>', { status: 422 }));
    const html = await call(signup(HOPEFUL));
    expect(html.status).toBe(200);
    expect(await html.json()).toEqual(SUCCESS);
    expect(logged(spy)).toContain('error keys: unparseable');
    expectLogWithoutAddress(spy);
  });

  it('maps a rejected key (401) to 503', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({ message: 'Unauthenticated.' }, 401));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expectLogWithoutAddress(spy);
  });

  it('maps upstream throttling (429) to 503', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(
      () => new Response('{"message":"Too Many Attempts."}', { status: 429, headers: { 'retry-after': '30' } })
    );
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(logged(spy)).toContain('retry-after=30');
    expectLogWithoutAddress(spy);
  });

  it('never lets a non-numeric retry-after header into the log', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(
      () =>
        new Response('{"message":"Too Many Attempts."}', {
          status: 429,
          headers: { 'retry-after': 'hopeful@example.com' },
        })
    );
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(logged(spy)).toContain('retry-after=?');
    expectLogWithoutAddress(spy);
  });

  it('maps an upstream 500 to 503', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() => new Response('Server Error', { status: 500 }));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expectLogWithoutAddress(spy);
  });

  it('maps a network failure to 503 instead of a crash', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() => {
      throw new TypeError('Network connection lost.');
    });
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expectLogWithoutAddress(spy);
  });

  it('returns 503 when MAILERLITE_GROUP_ID is unset, after the challenge and before any call', async () => {
    configure();
    delete env.MAILERLITE_GROUP_ID;
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(turnstileCalls()).toHaveLength(1);
    expect(mailerliteCalls()).toHaveLength(0);
    expect(logged(spy)).toContain('MAILERLITE_GROUP_ID is not configured');
  });

  it('returns 503 when MAILERLITE_API_KEY is unset, before any call', async () => {
    configure();
    delete env.MAILERLITE_API_KEY;
    stubTurnstileThen(() => reply({}, 201));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(mailerliteCalls()).toHaveLength(0);
  });
});

describe('security headers', () => {
  it('sends the same Content-Security-Policy as public/_headers, byte for byte', async () => {
    // TEST_HEADERS_CSP is read out of public/_headers by vitest.config.mjs.
    // Guard the guard: an empty binding would mean the line went missing there.
    expect(env.TEST_HEADERS_CSP).toMatch(/^default-src 'self'; /);

    const res = await call(new Request(API, { method: 'GET' }));
    expect(res.status).toBe(405);
    expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);
  });
});

describe('static pages', () => {
  it('serves the English page at /', async () => {
    const res = await call(new Request(`${ORIGIN}/`));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    // The root element only: 'lang="en"' also occurs inside the Spanish page
    // (the EN switch link, the footer link), so it cannot tell them apart.
    expect(await res.text()).toContain('<html lang="en">');
    expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);
  });

  it('serves the Spanish page at /es/', async () => {
    const res = await call(new Request(`${ORIGIN}/es/`));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('<html lang="es">');
  });

  it('ships the opening sequence on request, never on load', async () => {
    const js = await call(new Request(`${ORIGIN}/intro.js`));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const src = await js.text();
    // No once-per-session memory and no autoplay gate left: the only way in is the button.
    expect(src).not.toContain('sessionStorage');
    expect(src).toContain('.intro-replay');

    for (const path of ['/', '/es/']) {
      const html = await (await call(new Request(`${ORIGIN}${path}`))).text();
      // Deferred on purpose now: nothing plays before first paint, so nothing may block it.
      expect(html).toContain('<script src="/intro.js" defer></script>');
      expect(html).not.toContain('<script src="/intro.js"></script>');
      expect(html).toContain('<section class="intro"');
      // Five text frames written for the screen, and the replay button (README, "The opening sequence").
      expect(html.match(/class="intro-text"/g)?.length).toBe(5);
      expect(html).toContain('class="intro-replay" hidden>');
    }

    const bull = await call(new Request(`${ORIGIN}/img/bull.png`));
    expect(bull.status).toBe(200);
    expect(bull.headers.get('content-type')).toBe('image/png');
  });

  it('links X and Instagram from every page, and credits the share card to @rodeo_sv', async () => {
    for (const path of ['/', '/es/', '/team', '/es/team']) {
      const res = await call(new Request(`${ORIGIN}${path}`));
      const html = await res.text();

      expect(html).toContain('<a href="https://x.com/rodeo_sv" rel="me noopener"');
      expect(html).toContain('<a href="https://www.instagram.com/rodeo_sv" rel="me noopener"');
      expect(html).toContain('<meta name="twitter:site" content="@rodeo_sv">');
      // The home pages' top-left bull mark was removed on purpose; the corner stays blank there.
      // The team pages have no hero logo, so they carry the small mark (tested under "team page").
      if (!path.endsWith('team')) expect(html).not.toContain('class="mark"');
      // Inline SVG, not an image load: the CSP stays exactly as it was.
      expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);
    }
  });

  it('ends both pages with a share bar that works without JS, and keeps "No spam" by the input', async () => {
    const js = await call(new Request(`${ORIGIN}/share.js`));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);

    for (const [path, page] of [['/', 'https%3A%2F%2Frenaissance.rodeo%2F'], ['/es/', 'https%3A%2F%2Frenaissance.rodeo%2Fes%2F']]) {
      const res = await call(new Request(`${ORIGIN}${path}`));
      const html = await res.text();

      expect(html).toContain('<script src="/share.js" defer></script>');
      // Each network's share page gets this page's own address, and opens in a new tab.
      for (const prefix of ['https://wa.me/?text=', 'https://x.com/intent/post?text=', 'https://www.facebook.com/sharer/sharer.php?u=', 'https://t.me/share/url?url=']) {
        const link = html.match(new RegExp(`<a href="(${prefix.replace(/[.?/]/g, '\\$&')}[^"]*)"([^>]*)>`));
        expect(link, prefix).not.toBeNull();
        expect(link[1]).toContain(page);
        expect(link[2]).toContain('target="_blank" rel="noopener"');
      }
      expect(html).toMatch(new RegExp(`<a href="mailto:\\?subject=[^"]*&amp;body=${page}"`));
      // The JS-only buttons ship hidden, so a visitor without JS never sees a dead control.
      expect(html).toMatch(/class="share-copy"[^>]* hidden>/);
      expect(html).toMatch(/class="share-native"[^>]* hidden>/);

      // "No spam" sits inside the form, under the input row and above the Turnstile widget.
      const form = html.slice(html.indexOf('<form class="signup"'), html.indexOf('</form>'));
      expect(form.indexOf('class="fine"')).toBeGreaterThan(form.indexOf('type="submit"'));
      expect(form.indexOf('class="fine"')).toBeLessThan(form.indexOf('class="cf-turnstile"'));

      expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);
    }
  });

  it('answers an unknown path with 404 and the 404 page', async () => {
    const page = await (await call(new Request(`${ORIGIN}/404.html`))).text();
    const res = await call(new Request(`${ORIGIN}/nope`));

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toBe(page);
    expect(page).not.toContain('class="mark"');
    expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('answers 500 JSON, not a runtime error page, when the ASSETS binding is missing', async () => {
    delete env.ASSETS;
    const spy = watchErrorLog();
    const res = await call(new Request(`${ORIGIN}/nope`));

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ ok: false, error: 'server_error' });
    expect(logged(spy)).toContain('ASSETS binding is missing');

    // A misnamed binding (an object without fetch) is the same failure.
    env.ASSETS = {};
    const misnamed = await call(new Request(`${ORIGIN}/nope`));
    expect(misnamed.status).toBe(500);
  });
});

// README, "The team page". Two hand-written files carry the same cards, so most of what can go
// wrong is drift between them: a person, a link or an order changed in one language only.
describe('team page', () => {
  const PAGES = { en: '/team', es: '/es/team' };

  async function page(path) {
    const res = await call(new Request(`${ORIGIN}${path}`));
    return { res, html: await res.text() };
  }
  /** The cards and nothing else: from the grid's opening tag to the sponsorship line after it. */
  const grid = (html) =>
    html.slice(html.indexOf('<ul class="team-grid">'), html.indexOf('<p class="team-contact">'));
  const names = (html) => [...grid(html).matchAll(/<h2 class="member-name">([^<]*)<\/h2>/g)].map((m) => m[1]);
  const hrefs = (html) => [...grid(html).matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);

  it('serves /team in English and /es/team in Spanish, with the site headers', async () => {
    for (const [lang, path] of Object.entries(PAGES)) {
      const { res, html } = await page(path);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toContain(`<link rel="canonical" href="https://renaissance.rodeo${path}">`);
      expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);
    }
  });

  it('redirects the trailing-slash and .html spellings to the one address', async () => {
    for (const path of Object.values(PAGES)) {
      for (const variant of [`${path}/`, `${path}.html`]) {
        const res = await call(new Request(`${ORIGIN}${variant}`, { redirect: 'manual' }));

        expect(res.status, variant).toBe(307);
        expect(new URL(res.headers.get('location'), ORIGIN).pathname, variant).toBe(path);
      }
    }
  });

  it('lists the same people, in the same order, with the same links, in both languages', async () => {
    const en = (await page(PAGES.en)).html;
    const es = (await page(PAGES.es)).html;

    expect(names(en).length).toBeGreaterThan(0);
    expect(names(es)).toEqual(names(en));
    expect(hrefs(es)).toEqual(hrefs(en));
  });

  it('puts the initials of the first two words of the name in each square, hidden from screen readers', async () => {
    for (const path of Object.values(PAGES)) {
      const html = (await page(path)).html;
      const cards = [
        ...grid(html).matchAll(
          /<span class="avatar" aria-hidden="true">([^<]*)<\/span>\s*<div class="member-body">\s*<h2 class="member-name">([^<]*)<\/h2>/g
        ),
      ];

      // Every card matched, so none has an avatar that screen readers would read out.
      expect(cards.length, path).toBe(names(html).length);
      for (const [, initials, name] of cards) {
        const expected = name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
        expect(initials, name).toBe(expected);
      }
    }
  });

  it('sends every outbound link over https with rel="noopener", and names every icon-only link', async () => {
    for (const [lang, path] of Object.entries(PAGES)) {
      const html = (await page(path)).html;
      const outbound = [...html.matchAll(/<a href="(https?:[^"]*)"([^>]*)>/g)];

      expect(outbound.length).toBeGreaterThan(0);
      for (const [, href, attrs] of outbound) {
        expect(href).toMatch(/^https:\/\//);
        expect(attrs, href).toMatch(/rel="(me )?noopener"/);
      }
      // An X icon has no text of its own: its aria-label is all a screen reader gets.
      for (const [, href, attrs] of grid(html).matchAll(/<a href="(https:\/\/x\.com\/[^"]*)"([^>]*)>/g)) {
        expect(attrs, href).toMatch(lang === 'en' ? /aria-label="[^"]+ on X"/ : /aria-label="[^"]+ en X"/);
      }
    }
  });

  it('carries the small bull-and-rider mark top left, leading to the home page in its language', async () => {
    for (const [path, home] of [[PAGES.en, '/'], [PAGES.es, '/es/']]) {
      const html = (await page(path)).html;
      const header = html.slice(html.indexOf('<header class="top wrap">'), html.indexOf('</header>'));

      // First thing in the header, so it sits at the left edge; the big wordmark is gone.
      expect(header).toMatch(
        new RegExp(`^<header class="top wrap">\\s*<a class="mark" href="${home}" aria-label="[^"]+"><img src="/img/mark.png" width="36" height="36" alt=""></a>`)
      );
      expect(html).not.toContain('/img/logo.png');
    }
  });

  it('is linked from both home pages and the sitemap, needs no script, and gives the sponsorship address', async () => {
    expect((await page('/')).html).toContain('<a href="/team">Team</a>');
    expect((await page('/es/')).html).toContain('<a href="/es/team">Equipo</a>');

    for (const path of Object.values(PAGES)) {
      const html = (await page(path)).html;

      expect(html).toContain('<a href="mailto:sponsors@renaissance.rodeo">sponsors@renaissance.rodeo</a>');
      expect(html).not.toContain('<script');
    }

    const sitemap = await (await call(new Request(`${ORIGIN}/sitemap.xml`))).text();
    expect(sitemap).toContain('<loc>https://renaissance.rodeo/team</loc>');
    expect(sitemap).toContain('<loc>https://renaissance.rodeo/es/team</loc>');
  });
});
