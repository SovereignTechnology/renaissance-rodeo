import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { unstable_readConfig } from 'wrangler';

// The static-asset layer sends the CSP written in public/_headers; the Worker
// stamps SECURITY_HEADERS from src/index.js on API and 404 responses. They
// must be byte-identical, so the _headers value is read here (Node) and handed
// to the tests as a binding to compare against.
const headersFile = fs.readFileSync(path.join(import.meta.dirname, 'public', '_headers'), 'utf8');
const cspFromHeaders =
  headersFile
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('Content-Security-Policy:'))
    ?.replace(/^Content-Security-Policy:\s*/, '') ?? '';

// The same trick for wrangler.jsonc, so the suite can refuse a config that
// would deploy DEV_MODE or a secret as a var, an unedited group-id
// placeholder, or routes without workers_dev turned off. The pool seeds `env`
// from `vars` and every test deletes those keys first, so nothing in the
// tests themselves could notice a poisoned config — this is the only eye on
// it. wrangler's own reader is used rather than a hand-rolled comment
// stripper, so what the tests see is what `wrangler deploy` would send.
const wranglerConfig = unstable_readConfig({
  config: path.join(import.meta.dirname, 'wrangler.jsonc'),
});
const wranglerVars = wranglerConfig.vars ?? {};
// `routes` (plural) is what the cutover block uses; `route` (singular) is the
// other spelling wrangler accepts, counted so the guard cannot be sidestepped.
const routesCount = (wranglerConfig.routes ?? []).length + (wranglerConfig.route ? 1 : 0);

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // wrangler.jsonc pins 2026-09-20; the workerd bundled inside
        // vitest-pool-workers refuses dates newer than it knows. Tests run one
        // compatibility window behind production. Raise this to match
        // wrangler.jsonc as soon as the pool ships a newer runtime.
        compatibilityDate: '2026-08-22',
        // No real credentials here, ever: several tests exist to prove the
        // Worker refuses to run when a secret is missing, so secrets are set
        // per test. Everything below is a string, parsed on the test side.
        bindings: {
          TEST_HEADERS_CSP: cspFromHeaders,
          TEST_WRANGLER_VAR_KEYS: JSON.stringify(Object.keys(wranglerVars)),
          // The two group ids as configured, or null when absent (the
          // committed state: the whole vars block is a comment). Public
          // configuration, not credentials.
          TEST_WRANGLER_GROUP_IDS: JSON.stringify({
            MAILERLITE_GROUP_ID: wranglerVars.MAILERLITE_GROUP_ID ?? null,
            MAILERLITE_GROUP_ID_ES: wranglerVars.MAILERLITE_GROUP_ID_ES ?? null,
          }),
          TEST_WRANGLER_ROUTES_COUNT: String(routesCount),
          TEST_WRANGLER_WORKERS_DEV: String(wranglerConfig.workers_dev),
        },
      },
    }),
  ],
});
