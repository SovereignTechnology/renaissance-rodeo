import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const ORIGIN = 'http://example.com';
const API = `${ORIGIN}/api/subscribe`;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const LISTMONK_URL = 'https://news.renaissance.rodeo/api/subscribers';

/** Cloudflare's documented always-passes Turnstile test secret. Not a credential. */
const TEST_SECRET = '1x0000000000000000000000000000000AA';
/** Shaped unlike a test secret so the test-secret refusal does not fire. Not a credential. */
const FAKE_SECRET = 'unit-test-turnstile-secret-not-a-real-credential';
/** Not credentials: shaped so a leak into a log line or body is easy to spot. */
const FAKE_TOKEN = 'unit-test-listmonk-token-not-a-real-credential';
const FAKE_HEADER = 'unit-test-worker-header-not-a-real-credential';
const LIST = '2';
const LIST_ES = '3';
/** Mirrors LIST_ID_RE in src/index.js: a quoted listmonk list id. */
const LIST_ID_RE = /^[1-9][0-9]{0,8}$/;

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

// Outbound calls. Turnstile posts FormData, listmonk gets JSON; both go
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

/** Turnstile passes; listmonk answers whatever `listmonk()` returns. */
function stubTurnstileThen(listmonk) {
  stubFetch((url) => (url === SITEVERIFY ? reply({ success: true }) : listmonk()));
}

const turnstileCalls = () => calls.filter((c) => c.url === SITEVERIFY);
const listmonkCalls = () => calls.filter((c) => c.url.startsWith('https://news.renaissance.rodeo/'));

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

/** Everything a real signup needs: .dev.vars' two values plus a fake token, header and list. */
function configure() {
  env.DEV_MODE = 'true';
  env.TURNSTILE_SECRET = TEST_SECRET;
  env.LISTMONK_API_TOKEN = FAKE_TOKEN;
  env.LISTMONK_WORKER_HEADER = FAKE_HEADER;
  env.LISTMONK_LIST_ID = LIST;
  env.LISTMONK_LIST_ID_ES = LIST_ES;
}

const realLimiter = env.SUBSCRIBE_LIMIT;
const realAssets = env.ASSETS;

beforeEach(() => {
  // The pool seeds env from .dev.vars (DEV_MODE + the test secret) when that
  // file exists. Every test starts from nothing and sets only what it proves.
  delete env.DEV_MODE;
  delete env.TURNSTILE_SECRET;
  delete env.LISTMONK_API_TOKEN;
  delete env.LISTMONK_WORKER_HEADER;
  delete env.LISTMONK_LIST_ID;
  delete env.LISTMONK_LIST_ID_ES;
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
    for (const forbidden of ['DEV_MODE', 'TURNSTILE_SECRET', 'LISTMONK_API_TOKEN', 'LISTMONK_WORKER_HEADER']) {
      expect(keys, `${forbidden} must never be a var`).not.toContain(forbidden);
    }
  });

  it('configures LISTMONK_LIST_ID as a quoted positive integer', () => {
    // Guard the guard: an absent binding would mean the config read failed.
    expect(typeof env.TEST_WRANGLER_LIST_ID).toBe('string');
    const id = JSON.parse(env.TEST_WRANGLER_LIST_ID);
    // Required: without it every signup is a 503.
    expect(id, 'LISTMONK_LIST_ID must be set in vars').not.toBeNull();
    expect(typeof id, 'LISTMONK_LIST_ID must be a quoted string').toBe('string');
    expect(id, 'LISTMONK_LIST_ID is not a list id').toMatch(LIST_ID_RE);
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
    stubTurnstileThen(() => reply({}, 200));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(listmonkCalls()).toHaveLength(1);
  });

  it('lets the signup through when the rate limiter binding is missing', async () => {
    configure();
    delete env.SUBSCRIBE_LIMIT;
    stubTurnstileThen(() => reply({}, 200));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(listmonkCalls()).toHaveLength(1);
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
      stubTurnstileThen(() => reply({}, 200));
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
    stubTurnstileThen(() => reply({}, 200));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);
    expect(listmonkCalls()).toHaveLength(1);
  });

  it('does not fire on a production hostname when DEV_MODE is off', async () => {
    configure();
    delete env.DEV_MODE;
    env.TURNSTILE_SECRET = FAKE_SECRET;
    stubFetch((url) =>
      url === SITEVERIFY ? reply({ success: true, hostname: 'renaissance.rodeo' }) : reply({}, 200)
    );
    const res = await call(signup(HOPEFUL, at('renaissance.rodeo')));

    expect(res.status).toBe(200);
    expect(listmonkCalls()).toHaveLength(1);
  });
});

describe('Turnstile fails closed', () => {
  it('returns 503 when TURNSTILE_SECRET is unset', async () => {
    env.LISTMONK_API_TOKEN = FAKE_TOKEN;
    env.LISTMONK_WORKER_HEADER = FAKE_HEADER;
    env.LISTMONK_LIST_ID = LIST;
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
    expect(listmonkCalls()).toHaveLength(0);
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
    expect(listmonkCalls()).toHaveLength(0);
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
    stubTurnstileThen(() => reply({}, 200));
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
      url === SITEVERIFY ? reply({ success: true, hostname: 'evil.test' }) : reply({}, 200)
    );
    const elsewhere = await call(signup(HOPEFUL));
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(listmonkCalls()).toHaveLength(0);

    // No hostname at all is a mismatch too: the check must fail closed, not
    // vanish, if siteverify ever stops sending the field.
    stubFetch((url) => (url === SITEVERIFY ? reply({ success: true }) : reply({}, 200)));
    const nowhere = await call(signup(HOPEFUL));
    expect(nowhere.status).toBe(403);
    expect(await nowhere.json()).toEqual({ ok: false, error: 'challenge_failed' });
    expect(listmonkCalls()).toHaveLength(0);
    expectLogWithoutAddress(spy);

    stubFetch((url) =>
      url === SITEVERIFY ? reply({ success: true, hostname: 'example.com' }) : reply({}, 200)
    );
    const here = await call(signup(HOPEFUL));
    expect(here.status).toBe(200);
    expect(listmonkCalls()).toHaveLength(1);
  });
});

describe('email validation', () => {
  it('returns 400 on a bad address only after Turnstile has passed', async () => {
    configure();
    for (const email of ['not-an-email', 'two@@example.com', 'a@b', 'x y@example.com', '']) {
      stubTurnstileThen(() => reply({}, 200));
      const res = await call(signup({ email, 'cf-turnstile-response': 'stub-token' }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid' });
      // The challenge is checked first, so a bad address still costs a
      // solved challenge — and listmonk never hears about it.
      expect(turnstileCalls()).toHaveLength(1);
      expect(listmonkCalls()).toHaveLength(0);
    }
  });
});

describe('list id shape', () => {
  // Truthiness is not a check: every one of these is truthy and every one is
  // wrong. Upstream they would come back as a 400, which is answered as
  // success (rule 3) — every signup silently lost.
  for (const [label, value] of [
    ["'0'", '0'],
    ['a leading zero', '02'],
    ['a whitespace-padded id', ` ${LIST} `],
    ['a placeholder', 'REPLACE_WITH_LIST_ID'],
    ['a ten-digit id', '1234567890'],
    ['a negative id', '-2'],
    ['a bare JSON number', 2],
  ]) {
    it(`refuses LISTMONK_LIST_ID = ${label} with 503 and no listmonk call`, async () => {
      configure();
      env.LISTMONK_LIST_ID = value;
      const spy = watchErrorLog();
      stubTurnstileThen(() => reply({}, 200));
      const res = await call(signup(HOPEFUL));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
      expect(turnstileCalls()).toHaveLength(1);
      expect(listmonkCalls()).toHaveLength(0);
      expect(logged(spy)).toContain('LISTMONK_LIST_ID is malformed');
      // The var is named, its value is not.
      if (String(value).trim().length > 3) expect(logged(spy)).not.toContain(String(value).trim());
      expectLogWithoutAddress(spy);
    });
  }

  it('returns 503 when LISTMONK_LIST_ID is unset, after the challenge and before any call', async () => {
    configure();
    delete env.LISTMONK_LIST_ID;
    const spy = watchErrorLog();
    stubTurnstileThen(() => reply({}, 200));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(turnstileCalls()).toHaveLength(1);
    expect(listmonkCalls()).toHaveLength(0);
    expect(logged(spy)).toContain('LISTMONK_LIST_ID is not configured');
    expectLogWithoutAddress(spy);
  });
});

describe('listmonk credentials', () => {
  for (const name of ['LISTMONK_API_TOKEN', 'LISTMONK_WORKER_HEADER']) {
    for (const [label, apply] of [
      ['unset', () => delete env[name]],
      ['empty', () => (env[name] = '')],
    ]) {
      it(`returns 503 when ${name} is ${label}, after the challenge and before any call`, async () => {
        configure();
        apply();
        const spy = watchErrorLog();
        stubTurnstileThen(() => reply({}, 200));
        const res = await call(signup(HOPEFUL));

        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
        expect(turnstileCalls()).toHaveLength(1);
        expect(listmonkCalls()).toHaveLength(0);
        expect(logged(spy)).toContain(`${name} is not configured`);
        // Named, never valued: the other credential must not leak either.
        expect(logged(spy)).not.toContain(FAKE_TOKEN);
        expect(logged(spy)).not.toContain(FAKE_HEADER);
        expectLogWithoutAddress(spy);
      });
    }
  }
});

describe('listmonk', () => {
  it('makes exactly one POST with the normalised address, the list as a number, status enabled and lang', async () => {
    configure();
    stubTurnstileThen(() => reply({ data: { id: 1 } }, 200));

    const res = await call(
      signup({ email: '  NewPerson@Example.COM ', lang: 'en', 'cf-turnstile-response': 'stub-token' })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUCCESS);

    const lm = listmonkCalls();
    expect(lm).toHaveLength(1);
    expect(lm[0].method).toBe('POST');
    expect(lm[0].url).toBe(LISTMONK_URL);
    // The address must never appear in the URL — a fetch error message carries
    // the URL straight into Workers Logs.
    expect(lm[0].url).not.toContain('@');
    expect(lm[0].body).toEqual({
      email: 'newperson@example.com',
      lists: [2],
      status: 'enabled',
      attribs: { lang: 'en' },
    });
    expect(typeof lm[0].body.lists[0]).toBe('number');
    // The list is single opt-in, so there is nothing to preconfirm. And
    // listmonk derives the name itself.
    expect(lm[0].body).not.toHaveProperty('preconfirm_subscriptions');
    expect(lm[0].body).not.toHaveProperty('name');
  });

  it('sends the gateway header, the token for the rodeo-worker API user, and JSON headers', async () => {
    configure();
    stubTurnstileThen(() => reply({}, 200));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(200);
    const { headers } = listmonkCalls()[0];
    expect(headers['x-rodeo-worker']).toBe(FAKE_HEADER);
    expect(headers.authorization).toBe(`token rodeo-worker:${FAKE_TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
  });

  it('accepts a JSON body the same way as a form post', async () => {
    configure();
    stubTurnstileThen(() => reply({}, 200));

    const res = await call(
      signup({ email: 'Json@Example.com', 'cf-turnstile-response': 'stub-token' }, { contentType: 'application/json' })
    );

    expect(res.status).toBe(200);
    expect(listmonkCalls()[0].body).toEqual({
      email: 'json@example.com',
      lists: [2],
      status: 'enabled',
      attribs: { lang: 'en' },
    });
  });

  it('sends attribs.lang "es" for lang=es', async () => {
    configure();
    stubTurnstileThen(() => reply({}, 200));

    const res = await call(signup({ ...HOPEFUL, lang: 'es' }));

    expect(res.status).toBe(200);
    expect(listmonkCalls()[0].body.attribs).toEqual({ lang: 'es' });
    // The Spanish list INSTEAD of the main one: the two are disjoint.
    expect(listmonkCalls()[0].body.lists).toEqual([3]);
    expect(typeof listmonkCalls()[0].body.lists[0]).toBe('number');
  });

  it('puts a Spanish signup on the main list when no Spanish list is configured', async () => {
    configure();
    delete env.LISTMONK_LIST_ID_ES;
    stubTurnstileThen(() => reply({}, 200));
    const res = await call(signup({ ...HOPEFUL, lang: 'es' }));

    expect(res.status).toBe(200);
    expect(listmonkCalls()[0].body.lists).toEqual([2]);
    expect(listmonkCalls()[0].body.attribs).toEqual({ lang: 'es' });
  });

  for (const [label, value] of [
    ['empty', ''],
    ['zero', '0'],
    ['a placeholder', 'REPLACE_WITH_LIST_ID'],
    ['a bare JSON number', 3],
    ['the main list again', LIST],
  ]) {
    it(`refuses LISTMONK_LIST_ID_ES = ${label} with 503 and no listmonk call, on either page`, async () => {
      configure();
      env.LISTMONK_LIST_ID_ES = value;
      for (const lang of ['en', 'es']) {
        const spy = watchErrorLog();
        stubTurnstileThen(() => reply({}, 200));
        const res = await call(signup({ ...HOPEFUL, lang }));

        expect(res.status).toBe(503);
        expect(listmonkCalls()).toHaveLength(0);
        expect(logged(spy)).toContain('LISTMONK_LIST_ID_ES is malformed');
        expectLogWithoutAddress(spy);
      }
    });
  }

  it('treats anything but exactly "es" as English', async () => {
    configure();
    for (const lang of ['ES', 'es-SV', 'fr', '', undefined]) {
      stubTurnstileThen(() => reply({}, 200));
      const fields = lang === undefined ? HOPEFUL : { ...HOPEFUL, lang };
      const res = await call(signup(fields));

      expect(res.status).toBe(200);
      expect(listmonkCalls()[0].body.attribs).toEqual({ lang: 'en' });
      expect(listmonkCalls()[0].body.lists).toEqual([2]);
    }
  });

  it('answers byte-identically for a new address (200) and an existing one (409)', async () => {
    configure();
    stubTurnstileThen(() => reply({ data: { id: 1 } }, 200));
    const created = await call(signup(HOPEFUL));
    stubTurnstileThen(() => reply({ message: 'E-mail already exists.' }, 409));
    const existing = await call(signup(HOPEFUL));

    expect(created.status).toBe(200);
    expect(existing.status).toBe(200);
    expect(await existing.text()).toBe(await created.text());
  });

  for (const status of [400, 422]) {
    it(`answers a ${status} with the same success body as a 200, never reading or logging the upstream body`, async () => {
      // Rule 3: listmonk may refuse an address for account-state reasons (a
      // blocklisted domain), so a visible difference would be a list-history
      // oracle. Rule 2: its message can quote the address, so the body is
      // not read at all — only the status reaches the log.
      configure();
      const spy = watchErrorLog();
      stubTurnstileThen(() => reply({ data: { id: 1 } }, 200));
      const created = await call(signup(HOPEFUL));

      let upstream;
      stubTurnstileThen(() => {
        upstream = reply({ message: 'Invalid email: hopeful@example.com is not deliverable.' }, status);
        return upstream;
      });
      const refused = await call(signup(HOPEFUL));

      expect(refused.status).toBe(200);
      const text = await refused.text();
      expect(JSON.parse(text)).toEqual(SUCCESS);
      expect(text).toBe(await created.text());
      expect(text).not.toContain('deliverable');
      expect(upstream.bodyUsed, 'the listmonk error body must never be read').toBe(false);
      expect(logged(spy)).toContain(`listmonk: HTTP ${status} (upstream refused the address)`);
      expect(logged(spy)).not.toContain('deliverable');
      expectLogWithoutAddress(spy);
    });
  }

  for (const status of [401, 403]) {
    it(`maps a rejected token or gateway header (${status}) to 503`, async () => {
      configure();
      const spy = watchErrorLog();
      stubTurnstileThen(() => reply({ message: 'invalid API credentials' }, status));
      const res = await call(signup(HOPEFUL));

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
      expect(logged(spy)).toContain(`listmonk: credentials or gateway header rejected (HTTP ${status})`);
      expect(logged(spy)).not.toContain(FAKE_TOKEN);
      expect(logged(spy)).not.toContain(FAKE_HEADER);
      expectLogWithoutAddress(spy);
    });
  }

  it('maps a gateway refusal (404) to 503', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(() => new Response('Not Found', { status: 404 }));
    const res = await call(signup(HOPEFUL));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(logged(spy)).toContain('listmonk: the gateway refused the request');
    expect(logged(spy)).not.toContain(FAKE_HEADER);
    expectLogWithoutAddress(spy);
  });

  it('maps upstream throttling (429) to 503', async () => {
    configure();
    const spy = watchErrorLog();
    stubTurnstileThen(
      () => new Response('{"message":"Too many requests"}', { status: 429, headers: { 'retry-after': '30' } })
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
        new Response('{"message":"Too many requests"}', {
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
    expect(logged(spy)).toContain('listmonk: HTTP 500');
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
    expect(logged(spy)).toContain('listmonk: network failure: Network connection lost.');
    expectLogWithoutAddress(spy);
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
    for (const path of ['/', '/es/', '/team', '/es/team', '/tickets', '/es/tickets', '/sponsors', '/es/sponsors']) {
      const res = await call(new Request(`${ORIGIN}${path}`));
      const html = await res.text();

      expect(html).toContain('<a href="https://x.com/rodeo_sv" rel="me noopener"');
      expect(html).toContain('<a href="https://www.instagram.com/rodeo_sv" rel="me noopener"');
      expect(html).toContain('<meta name="twitter:site" content="@rodeo_sv">');
      // The home pages' top-left bull mark was removed on purpose: the hero logo carries the name.
      // Every other page has no hero logo, so it carries the small mark (tested under "navigation").
      if (path === '/' || path === '/es/') expect(html).not.toContain('class="mark"');
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

  it('gives the same people a bio in both languages, never an empty one', async () => {
    const withBio = (html) =>
      grid(html)
        .split('<li class="member">')
        .slice(1)
        .map((card) => [card.match(/<h2 class="member-name">([^<]*)<\/h2>/)[1], card.match(/<p class="member-bio">([^<]*)<\/p>/)?.[1]])
        .filter(([, bio]) => bio !== undefined);
    const en = withBio((await page(PAGES.en)).html);
    const es = withBio((await page(PAGES.es)).html);

    expect(en.length).toBeGreaterThan(0);
    expect(es.map(([name]) => name)).toEqual(en.map(([name]) => name));
    for (const [name, bio] of [...en, ...es]) expect(bio.trim(), name).not.toBe('');
  });

  it('gives every card a square: the person\'s photo, or their initials hidden from screen readers', async () => {
    for (const path of Object.values(PAGES)) {
      const html = (await page(path)).html;
      const cards = grid(html).split('<li class="member">').slice(1);

      // Every card has a square, so none is missing an avatar that screen readers would read out.
      expect(cards.length, path).toBe(names(html).length);
      for (const card of cards) {
        const name = card.match(/<h2 class="member-name">([^<]*)<\/h2>/)[1];
        const avatar = card.match(/<span class="avatar" aria-hidden="true">([\s\S]*?)<\/span>/);
        expect(avatar, name).not.toBeNull();
        const inner = avatar[1];
        const img = inner.match(/^<img src="(\/img\/[a-z-]+\.jpg(?:\?v=2)?)" width="(\d+)" height="(\d+)" alt="">$/);
        if (img) {
          // A photo: self-hosted, square, empty alt (the aria-hidden square already hides it).
          const [, src, width, height] = img;
          expect(src, name).toMatch(/^\/img\/team-[a-z]+\.jpg(?:\?v=2)?$/);
          expect(width, name).toBe(height);
          expect(Number(width), name).toBeGreaterThanOrEqual(128);
        } else {
          const expected = name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
          expect(inner, name).toBe(expected);
        }
      }
    }
  });

  it('serves every team photo as a self-hosted JPEG', async () => {
    for (const src of ['/img/team-andrea.jpg', '/img/team-cam.jpg', '/img/team-tom.jpg', '/img/team-zack.jpg']) {
      const res = await call(new Request(`${ORIGIN}${src}`));
      expect(res.status, src).toBe(200);
      expect(res.headers.get('content-type'), src).toBe('image/jpeg');
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
        new RegExp(`^<header class="top wrap">\\s*<a class="mark" href="${home}" aria-label="[^"]+"><img src="/img/mark\\.png(?:\\?v=2)?" width="36" height="36" alt=""></a>`)
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

// README, "Navigation", "The tickets page", "The sponsors page". Eight hand-written pages carry
// the same page links twice each (header and footer), two of them copy the home page's signup
// form and two its partner row, so most of what can go wrong is drift between copies.
describe('navigation, tickets and sponsors', () => {
  const PAGES = {
    en: { home: '/', team: '/team', tickets: '/tickets', sponsors: '/sponsors' },
    es: { home: '/es/', team: '/es/team', tickets: '/es/tickets', sponsors: '/es/sponsors' },
  };
  const LINKS = {
    en: [['/team', 'Team'], ['/tickets', 'Tickets'], ['/sponsors', 'Sponsors']],
    es: [['/es/team', 'Equipo'], ['/es/tickets', 'Boletos'], ['/es/sponsors', 'Patrocinadores']],
  };
  const ALL = Object.values(PAGES).flatMap((pages) => Object.values(pages));
  const other = (lang) => (lang === 'en' ? 'es' : 'en');

  async function page(path) {
    const res = await call(new Request(`${ORIGIN}${path}`));
    return { res, html: await res.text() };
  }
  /** From the first `open` to the next `close` after it; '' when `open` is absent. */
  function block(html, open, close) {
    const start = html.indexOf(open);
    return start < 0 ? '' : html.slice(start, html.indexOf(close, start) + close.length);
  }
  /** Markup compared across files: indentation differs between them, nothing else may. */
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  /** The page links in one <nav>: plain internal links only (X and Instagram carry a rel). */
  const navLinks = (html, open) =>
    [...block(html, open, '</nav>').matchAll(/<a href="([^"]*)"( aria-current="page")?>([^<]*)<\/a>/g)].map(
      ([, href, current, text]) => ({ href, current: Boolean(current), text })
    );

  it('serves /tickets, /sponsors and their Spanish twins in their language, with the site headers', async () => {
    for (const [lang, pages] of Object.entries(PAGES)) {
      for (const path of [pages.tickets, pages.sponsors]) {
        const { res, html } = await page(path);

        expect(res.status, path).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/^text\/html/);
        expect(html).toContain(`<html lang="${lang}">`);
        expect(html).toContain(`<link rel="canonical" href="https://renaissance.rodeo${path}">`);
        expect(res.headers.get('content-security-policy')).toBe(env.TEST_HEADERS_CSP);

        for (const variant of [`${path}/`, `${path}.html`]) {
          const moved = await call(new Request(`${ORIGIN}${variant}`, { redirect: 'manual' }));
          expect(moved.status, variant).toBe(307);
          expect(new URL(moved.headers.get('location'), ORIGIN).pathname, variant).toBe(path);
        }
      }
    }
  });

  it('puts the same page links in the header and the footer of every page, marking only the current one', async () => {
    for (const [lang, pages] of Object.entries(PAGES)) {
      for (const [key, path] of Object.entries(pages)) {
        const html = (await page(path)).html;

        for (const open of ['<nav class="site"', '<nav class="foot-nav"']) {
          const found = navLinks(html, open);
          expect(found.map(({ href, text }) => [href, text]), `${path} ${open}`).toEqual(LINKS[lang]);
          expect(found.filter((l) => l.current).map((l) => l.href), `${path} ${open}`).toEqual(
            key === 'home' ? [] : [path]
          );
        }
        const foot = block(html, '<nav class="foot-nav"', '</nav>');
        expect(foot).toContain('<a href="https://x.com/rodeo_sv" rel="me noopener">X</a>');
        expect(foot).toContain('<a href="https://www.instagram.com/rodeo_sv" rel="me noopener">Instagram</a>');
      }
    }
  });

  it('opens the page links and icons from one menu button: a popover nav, no script', async () => {
    for (const [lang, pages] of Object.entries(PAGES)) {
      for (const path of Object.values(pages)) {
        const html = (await page(path)).html;
        const header = block(html, '<header class="top wrap">', '</header>');
        const nav = block(header, '<nav class="site"', '</nav>');

        // The nav is the popover; the browser hides it below 64rem until the button opens it.
        expect(nav, path).toMatch(/^<nav class="site" id="site-nav" popover aria-label="[^"]+">/);
        // Links and icons both live in it, so the menu panel carries both.
        expect(nav, path).toContain('<ul class="site-links">');
        expect(nav, path).toContain('<ul class="social">');
        // The button comes right after it and before the language switch. On screen that is
        // [mark][menu] … EN | ES: the hidden nav takes no room, and the switch is pushed right.
        expect(header, path).toMatch(
          new RegExp(`</nav>\\s*<button type="button" class="menu-btn" popovertarget="site-nav" aria-label="${lang === 'en' ? 'Menu' : 'Menú'}">`)
        );
        expect(header.indexOf('class="menu-btn"'), path).toBeLessThan(header.indexOf('<nav class="lang"'));
        // One target, one invoker: a second id="site-nav" would leave the button opening the wrong one.
        expect(html.match(/id="site-nav"/g), path).toHaveLength(1);
        expect(html.match(/popovertarget=/g), path).toHaveLength(1);
      }
    }
  });

  it('starts every subpage header with the mark leading home, and switches language to the same page', async () => {
    for (const [lang, pages] of Object.entries(PAGES)) {
      for (const [key, path] of Object.entries(pages)) {
        const html = (await page(path)).html;
        const header = block(html, '<header class="top wrap">', '</header>');
        const twin = PAGES[other(lang)][key];

        if (key === 'home') {
          expect(header, path).not.toContain('class="mark"');
        } else {
          expect(header, path).toMatch(
            new RegExp(`^<header class="top wrap">\\s*<a class="mark" href="${pages.home}" aria-label="[^"]+"><img src="/img/mark\\.png(?:\\?v=2)?"`)
          );
        }
        expect(block(header, '<nav class="lang"', '</nav>'), path).toContain(`<a href="${twin}" lang="${other(lang)}"`);
        expect(block(html, '<footer', '</footer>'), path).toContain(`<a href="${twin}" lang="${other(lang)}"`);
      }
    }
  });

  it('sends every outbound link on every page over https with rel="noopener"', async () => {
    for (const path of ALL) {
      const html = (await page(path)).html;
      const outbound = [...html.matchAll(/<a href="(https?:[^"]*)"([^>]*)>/g)];

      expect(outbound.length, path).toBeGreaterThan(0);
      for (const [, href, attrs] of outbound) {
        expect(href, path).toMatch(/^https:\/\//);
        expect(attrs, `${path} ${href}`).toMatch(/rel="(me )?noopener"/);
      }
    }
  });

  it('carries the Turnstile sitekey on exactly the four signup pages: one key, never a test key', async () => {
    const keys = {};
    for (const path of ALL) {
      const found = [...(await page(path)).html.matchAll(/data-sitekey="([^"]*)"/g)].map((m) => m[1]);
      if (found.length > 0) keys[path] = found;
    }

    expect(Object.keys(keys).sort()).toEqual(['/', '/es/', '/es/tickets', '/tickets']);
    const all = Object.values(keys).flat();
    expect(all).toHaveLength(4);
    // Replacing the key in some files only is the failure that hides: the widget renders either way.
    expect(new Set(all).size).toBe(1);
    // Cloudflare's documented test sitekeys start 1x0, 2x0 or 3x0 and pass (or fail) every visitor.
    expect(all[0]).not.toMatch(/^[123]x0/);
  });

  it('gives the tickets pages "coming soon" and the home page signup form, word for word', async () => {
    for (const [lang, pages] of Object.entries(PAGES)) {
      const home = (await page(pages.home)).html;
      const html = (await page(pages.tickets)).html;

      expect(html).toContain(lang === 'en' ? '<p class="soon">Coming soon</p>' : '<p class="soon">Próximamente</p>');
      expect(html).toContain(`<form class="signup" method="post" action="/api/subscribe" data-lang="${lang}">`);
      // Same fields, honeypot, widget and messages as the home page; only indentation differs.
      expect(squash(block(html, '<form class="signup"', '</form>'))).toBe(squash(block(home, '<form class="signup"', '</form>')));
      expect(block(html, '<p class="success" id="signup-ok"', '</p>')).toBe(block(home, '<p class="success" id="signup-ok"', '</p>'));
      const i18n = (h) => JSON.parse(block(h, '<script type="application/json" id="signup-i18n">', '</script>').replace(/^<script[^>]*>|<\/script>$/g, ''));
      expect(i18n(html)).toEqual(i18n(home));
      // signup.js must run before the Turnstile loader resolves the callback names it defines.
      expect(html).toContain('<script src="/signup.js" defer></script>');
      expect(html.indexOf('<script src="/signup.js"')).toBeLessThan(html.indexOf('turnstile/v0/api.js'));
    }
  });

  it('tells Bitcoin Histórico ticket holders the rodeo is included, and puts VIP under "coming soon"', async () => {
    const copy = {
      en: ['Have a Bitcoin Histórico ticket?', 'It includes your entry to Renaissance Rodeo', 'VIP tickets'],
      es: ['¿Tiene boleto para Bitcoin Histórico?', 'Incluye su entrada a Renaissance Rodeo', 'Boletos VIP'],
    };
    for (const [lang, pages] of Object.entries(PAGES)) {
      const html = (await page(pages.tickets)).html;
      const [question, answer, vip] = copy[lang];
      const included = block(html, '<section class="included"', '</section>');

      expect(included, lang).toContain(`<h2 id="included-h">${question}</h2>`);
      expect(included, lang).toContain(answer);
      expect(included, lang).toContain('<a href="https://bitcoinhistorico.com/" rel="noopener">Bitcoin Histórico</a>');
      // The VIP heading, then "coming soon", then the signup form: in that order, after the box.
      const signup = block(html, '<section id="signup"', '</section>');
      expect(signup, lang).toMatch(new RegExp(`^<section id="signup" aria-labelledby="signup-h">\\s*<h2 id="signup-h">${vip}</h2>\\s*<p class="soon">`));
      expect(html.indexOf('<section class="included"'), lang).toBeLessThan(html.indexOf('<section id="signup"'));
    }
  });

  it('sets the date and the place as two lines under the home page logo, before the poster thumbnail', async () => {
    for (const [lang, pages] of Object.entries(PAGES)) {
      const html = (await page(pages.home)).html;
      const date = lang === 'en' ? '13 November 2026' : '13 de noviembre de 2026';

      expect(html, lang).toContain(
        `<p class="when"><time class="when-date" datetime="2026-11-13">${date}</time> <span class="when-place">Ilopango, El Salvador</span></p>`
      );
      expect(html.indexOf('<p class="when">'), lang).toBeGreaterThan(html.indexOf('<h1 id="hero-h">'));
      expect(html.indexOf('<p class="when">'), lang).toBeLessThan(html.indexOf('class="poster-thumb"'));
    }
  });

  it('gives the sponsors pages the home page partner row and the sponsorship address', async () => {
    for (const pages of Object.values(PAGES)) {
      const home = (await page(pages.home)).html;
      const html = (await page(pages.sponsors)).html;

      expect(squash(block(html, '<ul class="partners">', '</ul>'))).toBe(squash(block(home, '<ul class="partners">', '</ul>')));
      expect(html).toContain('<a href="mailto:sponsors@renaissance.rodeo">sponsors@renaissance.rodeo</a>');
      expect(html).not.toContain('<script');
    }
  });

  it('lists every page in the sitemap', async () => {
    const sitemap = await (await call(new Request(`${ORIGIN}/sitemap.xml`))).text();
    for (const path of ALL) expect(sitemap, path).toContain(`<loc>https://renaissance.rodeo${path}</loc>`);
  });
});
