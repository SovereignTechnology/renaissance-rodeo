# Renaissance Rodeo

One-page bilingual event site for **Renaissance Rodeo** — 13 November 2026 · Ilopango, El Salvador,
the day after Bitcoin Histórico (11–12 November 2026, Centro Histórico, San Salvador). Venue, times
and tickets are announced to the mailing list first, so the page exists to collect email addresses:
a form gated by Cloudflare Turnstile whose submissions go straight into a MailerLite group. There is
no database, no build step and no server beyond one Cloudflare Worker that serves the static files
and answers a single API route. Live at <https://renaissance.rodeo>, source in GitHub
`sovITxyz/renaissance-rodeo` (private). Pushing to `main` deploys it.

## Requests

| Request | Answered by |
|---|---|
| `GET /` | `public/index.html` (English) |
| `GET /es/` | `public/es/index.html` (Spanish); `/es` is a 307 to `/es/` from the assets layer |
| `POST /api/subscribe` | `src/index.js`: same-origin → per-IP rate limit (5/60 s, `SUBSCRIBE_LIMIT`, fails open) → 4 KB size cap → honeypot (`rr_ref`) → Turnstile siteverify (fails closed) → email normalise → MailerLite `POST /api/subscribers` → `{ok:true}` |
| everything else | `public/*` via the Worker's `ASSETS` binding (`style.css`, `signup.js`, `img/`, `fonts/`, `robots.txt`, `sitemap.xml`); unknown paths get `public/404.html` |

Static files never reach the Worker code, so their headers come from `public/_headers`; API and
404 responses get `SECURITY_HEADERS` from `src/index.js`. The two must stay byte-identical (tested).

The Worker answers the same `{ok:true}` for a new address, an address already on the list, an
address MailerLite refuses (422) and a honeypot hit — it is not a membership oracle. It never logs
the address and never echoes MailerLite's response body. When a secret is missing, the group id is
missing or malformed, or `DEV_MODE` is set on a production hostname, it returns `503 unavailable`
and logs, rather than silently accepting signups it cannot deliver or did not verify. MailerLite is
the only copy of the list; unsubscribes are MailerLite's own links in each campaign.

The honeypot input is `name="rr_ref"` — a name no browser autofill heuristic recognises. It used to
be `company`, which Chromium and Firefox map to *organization* and fill from a saved address profile
even with `autocomplete="off"`; an off-screen field is still fillable, so a visitor who autofilled
the email field could stuff the honeypot without knowing and be told they were on the list. A hit
is logged as `honeypot hit` (no address) so a spike from real people is visible, and still answered
with the plain success so a bot has nothing to learn.

## Local development

```sh
cp .dev.vars.example .dev.vars && chmod 600 .dev.vars   # first run only; see below
npm run dev                      # wrangler dev --ip 0.0.0.0 --port 8788
```

`npm run dev` binds all interfaces so the preview is reachable over the tailnet at
<http://100.64.0.3:8788> (this laptop is `latitude-5420`; the LAN address is firewalled).

### Local secrets and DEV_MODE

`.dev.vars` (gitignored, never deployed) holds:

```
DEV_MODE=true
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
MAILERLITE_API_KEY=...          # a throwaway key, NOT the production one
```

**Never put the production `MAILERLITE_API_KEY` in `.dev.vars`.** `npm run dev` binds all
interfaces and `DEV_MODE=true` disables the test-secret refusal, so anyone who can reach the dev
port could push auto-passing signups straight into the live MailerLite list. Leave the key unset to
exercise the form up to the `503 unavailable` the Worker returns without it.

`DEV_MODE` relaxes exactly two production checks, both of which would otherwise make local testing
impossible:

- the hostname Turnstile reports in its siteverify response must match the request host;
- a Cloudflare **test** secret (`1x…`, `2x…`, `3x…`) is refused outright.

In production `DEV_MODE` is unset, so both apply. That second check is the important one: a test
secret accepts *every* token, and deployed unnoticed it would leave the form completely unprotected
while still looking healthy. The Worker returns `503 unavailable` and logs instead.

Two guards keep `DEV_MODE` out of production, because a stray `"DEV_MODE": "true"` under `vars`
(or a `wrangler deploy --var`) would switch both checks off with no log line and no failing test:

- **Runtime.** `handleSubscribe` refuses signups — `503 unavailable`, and
  `DEV_MODE is set on a production hostname; refusing signups` in the logs — whenever `DEV_MODE` is
  set and the request host is `renaissance.rodeo`, any subdomain of it, or any `*.workers.dev`
  hostname. `wrangler dev` answers on `localhost` or a LAN/tailnet address, so local runs are
  untouched; the smoke deploy on `workers.dev` is production for this purpose.
- **Tests.** `vitest.config.mjs` reads `wrangler.jsonc` and the suite fails if `vars` contains
  `DEV_MODE` or any secret name (see *Tests*). A poisoned config cannot pass CI.

## MailerLite

Two things come from MailerLite, and they live in different places:

| What | Where | Why |
|---|---|---|
| API key | Cloudflare secret `MAILERLITE_API_KEY` (see *Secrets*) | credential |
| group id(s) | `wrangler.jsonc` → `vars` | public configuration, inert without the key |

**API key.** MailerLite → Integrations → API → generate a token. Store and set it as described under
*Secrets*. The Worker sends it as `Authorization: Bearer` to `connect.mailerlite.com`.

**Group ids.** Create the group (or two) in MailerLite, then uncomment the `vars` block in
`wrangler.jsonc` and replace the placeholders:

```jsonc
"vars": {
  "MAILERLITE_GROUP_ID": "REPLACE_WITH_18_DIGIT_GROUP_ID",     // required — the Worker answers 503 without it
  "MAILERLITE_GROUP_ID_ES": "REPLACE_WITH_18_DIGIT_GROUP_ID"   // optional — Spanish-page signups join it too
}
```

A group id is an 18-digit number and must reach the Worker as a **quoted string** matching
`GROUP_ID_RE = /^[1-9][0-9]{5,19}$/` (`src/index.js`). A JSON number loses precision above 2^53,
so a bare number is refused rather than rounded; so are a leading zero, whitespace, and the
placeholder. `MAILERLITE_GROUP_ID` failing the check → `503 unavailable` and a log line naming the
variable (never its value). `MAILERLITE_GROUP_ID_ES` failing it → a log line and the variable is
ignored, so a typo in the optional group never blocks signups. The placeholder fails on purpose: a
block that was uncommented but not edited is refused loudly instead of sending every signup to a
group of zeros and blaming the visitor's address.

Every signup joins `MAILERLITE_GROUP_ID`; a signup from `/es/` additionally joins
`MAILERLITE_GROUP_ID_ES` when it is set, so Spanish campaigns can be targeted without custom fields.
`scripts/mailerlite-groups.sh` lists the account's groups with their ids; it reads the API key from
a `0600` file (made as shown under *Secrets*) and never prints it. Ids are public and committed.
The live groups are **Renaissance Rodeo** `199289599917295168` and **Renaissance Rodeo (ES)**
`199289600360843046` (created 2026-09-22 through the API with the same key file).

**`vars` live only in `wrangler.jsonc`.** `wrangler deploy` replaces the Worker's plain-text
bindings with the file's (`keep_vars` defaults to false), so a group id typed into the dashboard's
Variables UI is deleted by the next deploy — loudly, as a 503 with a log line, but deleted. Nothing
about this Worker is configured in the dashboard.

**Double opt-in.** MailerLite has a separate account toggle for API signups: *Account settings →
Subscribe settings → "Double opt-in for API and integrations"*. The Worker never sends a `status`
field, so the toggle alone decides what happens to a new address — and the page's success message
must match it. The message is a page string (`#signup-ok`) in both HTML files:

| Toggle | Subscriber | English success string | Spanish success string |
|---|---|---|---|
| **ON** (recommended) | gets MailerLite's confirmation email; an existing active subscriber is left alone | Almost there — check your inbox and confirm your email address. | Ya casi: revise su bandeja de entrada y confirme su correo electrónico. |
| OFF | active immediately | You're on the list. We'll write when there's news. | ¡Ya está en la lista! Le escribiremos en cuanto haya novedades. |

`status` must stay absent from the request: sending `status:"unconfirmed"` would demote existing
active subscribers on every repeat signup. The Worker's JSON is identical for new and existing
addresses in either mode; only the page copy changes.

The request does carry `resubscribe: true`: typing your address into the form is consent, so an
address that unsubscribed earlier comes back on the list instead of getting our success while
staying off it. MailerLite may still refuse such an address (its abuse prevention) — that is a
422, which the visitor sees as success, below.

**Response mapping** (`src/index.js`): 200, 201 **and 422** → `{ok:true}`; 401/403 → `503` and
`the API key was rejected` in the logs; 429 (MailerLite allows 120 requests/min) and anything
else → `503 unavailable`. The MailerLite call is awaited, so a failure is shown to the person as a
real error to retry, never swallowed.

422 is a success on purpose. MailerLite documents 422 as "invalid data" but does not promise it is
state-independent — an address the account has blocked or marked as junk may draw a 422 too — so
answering `400 invalid` would let a submitter learn that an address has history with this list, at
one Turnstile solve per probe. Rule 3 (no membership oracle) wins: the visitor loses only a message
the client-side email check already gives. The trade-off is that a bad group id also produces a 422
and is now invisible to visitors, which is why the shape check above exists: a malformed id is
caught before deploy by the test and at runtime by the 503, not reported by visitors as "my email
was rejected". The Worker logs
`mailerlite: HTTP 422 (upstream refused the address); error keys: …` listing only the **key names**
of MailerLite's `errors` object (`email`, `groups.0`, …, each filtered to `[a-z0-9_.]{1,40}`), never a
value — the values quote the address. A well-formed id that belongs to no group in the account
shows up there as `groups.0`, and as a group whose subscriber count stays at zero after the cutover
signup (checklist step 3).

**Sender domain (browser-only).** Sending from `@renaissance.rodeo` needs the domain authenticated
in MailerLite: a DKIM CNAME, an SPF TXT and a verification TXT on the `renaissance.rodeo` zone, added
in the Cloudflare dashboard (wrangler's token is zone-read only). The SPF part shares one record with
Email Routing: see *Email* before editing it. MailerLite's own unsubscribe and tracking links stay on
MailerLite's domain unless their paid domain alignment is bought.

## Turnstile

The form uses the production widget **`renaissance-rodeo-signup`** (Managed, hostnames
`renaissance.rodeo` and `www.renaissance.rodeo`), sitekey `0x4AAAAAAE_nBKxDHDJBj9OH` in both
`public/index.html` and `public/es/index.html`. Its secret is the Worker secret `TURNSTILE_SECRET`,
with the recoverable copy in Bitwarden `sovtech/shared` as `renaissance-rodeo-turnstile-secret`.
Both were set on 2026-09-22.

**Local development** needs Cloudflare's test sitekey, because `localhost` is not one of the
widget's hostnames and the real widget refuses to render there. Swap it in both files for the
session and **do not commit it**. The test suite does not check this, the launch check below does:

```sh
sed -i 's/data-sitekey="0x4AAAAAAE_nBKxDHDJBj9OH"/data-sitekey="1x00000000000000000000AA"/' public/index.html public/es/index.html
git checkout -- public/index.html public/es/index.html   # afterwards
```

The launch check, before any deploy:

```sh
grep -rl 'data-sitekey="1x0' public/ | wc -l   # must be 0
grep -rl data-sitekey public/ | wc -l          # must be 2
```

Replacing the sitekey in only one file is the failure that hides. Turnstile renders a widget with a
wrong sitekey without complaint, so that page looks normal while every submission from it is
rejected as `challenge_failed`.

**Recreating or rotating the widget is done in the terminal.** Wrangler 4.135+ has
`wrangler turnstile widget create|list|get|update|delete`, and its OAuth login includes the
`challenge-widgets.write` scope. A login older than that lacks the scope, and `wrangler whoami`
names it as missing; `npx wrangler login` fixes it. `create --json` prints the secret, so never
let that output reach a terminal: pipe it through `jq -er .secret` into a `0600` file and hand
that file to `scripts/set-secret.sh TURNSTILE_SECRET --from-file`. Print only `.sitekey`, which
is public.

Every rejected siteverify is logged, address-free: a non-200 answer logs its HTTP status, a
`success:false` answer logs the `error-codes` Cloudflare returned (`invalid-input-secret`,
`invalid-input-response`, `timeout-or-duplicate`, …), and a hostname mismatch logs as such. So a
wrong sitekey on one page, a secret that belongs to another widget, and a Turnstile outage each
show up in Workers Logs as a run of named rejections rather than as unexplained 403s and visitors
giving up.

`3x00000000000000000000FF` is a second test sitekey that forces a visible challenge; use it locally
to see the widget render (and for the CSP proof below). Test secret and test sitekeys are documented
public values, not credentials.

## Secrets

Exactly two: `TURNSTILE_SECRET` and `MAILERLITE_API_KEY`. Neither is in this repo, `.dev.vars` is
gitignored, and none may ever be added to `vars` in `wrangler.jsonc` — **a `vars` entry shadows the
secret binding of the same name on deploy**, silently substituting the configured string. The test
suite refuses a `wrangler.jsonc` that puts either name (or `DEV_MODE`) under `vars`, so the mistake
cannot reach `main` green.

`npx wrangler secret put` **fails if the Worker does not exist yet**, so run `npm run deploy` once
(the smoke configuration, no routes) before setting anything.

**Never type a secret into a command line.** `printf %s 'the-value' > file`, `echo`, `export X=…`,
`wrangler secret put --value …` — every one of them is recorded verbatim in `~/.bash_history` (or
zsh's), in terminal loggers and in tmux scrollback: the same permanence as an agent transcript, one
layer down. Earlier revisions of this README recommended exactly that `printf` recipe. If it has
already happened, delete the line from the running shell's history (`history -d <n>`) *and* from
the history file, then **rotate the key** — a deleted history line is not a rotated secret.

The recipe is one script, run in your own terminal, never inside an agent session:

```sh
scripts/set-secret.sh TURNSTILE_SECRET
scripts/set-secret.sh MAILERLITE_API_KEY
```

It accepts only those two names. Without `--from-file` it prompts `value: ` and reads with
`IFS= read -rs` — nothing is echoed, nothing is on a command line, and an empty or
whitespace-containing value is refused. The value goes into a `0600` temp file under `$HOME`
(`mktemp "$HOME/.rr-secret.XXXXXX"`) and from there through three steps, each run only if the one
before it succeeded:

1. `sudo -n /usr/local/bin/secret-store renaissance-rodeo-<name> <file>` — a copy into the
   Bitwarden `sovtech/shared` collection, item **`renaissance-rodeo-turnstile-secret`** or
   **`renaissance-rodeo-mailerlite-api-key`**, so the value survives the laptop. Cloudflare is
   write-only (`wrangler secret list` prints names, nothing prints values), which is why this step
   comes first: a value that exists only in Cloudflare can never be read back, only replaced.
2. `npx wrangler secret put <NAME> < <file>` — the Worker must already exist (above). `read` strips
   the newline, so the trailing-newline trap of older wrangler versions (Turnstile answering
   `invalid-input-secret` on every signup) does not arise; the siteverify log line would show it if
   it did.
3. `rm -f` the temp file — and, with `--from-file`, the source file too. Plain `rm`: `shred` is
   pointless on ZFS and btrfs (copy-on-write keeps the old blocks), so the script does not pretend.

On any failure the script prints which step failed, **keeps the `0600` temp file**, prints its path
and exits non-zero. Nothing is removed until both the store and the put have succeeded, so the
value is never lost between them, and a failed `secret-store` (no `sudo -n`, vault locked, another
operator's machine) never leaves Cloudflare holding the only copy. The script never prints the
value and runs under `set +x` and `umask 077`.

`--from-file PATH` takes the value from an existing file instead of prompting. The file must be a
regular file (not a symlink), owned by you, mode `0600`; it is removed alongside the temp file in
step 3. This is how the MailerLite key flows, because the same file also feeds the group listing:

```sh
(umask 077; IFS= read -rs -p 'key: ' k && printf %s "$k" > ~/.rr-mailerlite)   # subshell: k dies with it
scripts/mailerlite-groups.sh ~/.rr-mailerlite                  # ids for wrangler.jsonc
scripts/set-secret.sh MAILERLITE_API_KEY --from-file ~/.rr-mailerlite
```

That `printf` is safe: `"$k"` is expanded inside the subshell, and the history line holds the
literal `"$k"`, not the value.

`npm run secrets` (`wrangler secret list`) prints names only and must show exactly the two above.

## Assets

`brand/` holds the **sources** under stable names (see `brand/README.md`); everything under
`public/img/` and `public/favicon.ico` is **derived** from them by `scripts/build-assets.sh`
(`npm run assets`, idempotent). Never edit a derived file. The script:

- re-inks every brand PNG from black to the page ink `#0e1d2d` (the page is literally two colours),
  trims, resizes: `logo.png` 1200×591 + `logo.webp` (hero), `mark.png` 144×144 (header), favicons
  `favicon-32.png` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png` and `favicon.ico` on an
  opaque cream disc so they read on dark tab strips;
- renders `og-en.png` / `og-es.png` (1200×630 share images) with a Bevan TTF fetched at build time and
  not shipped;
- recolours `partners/origen-ganadero.svg` to ink and widens its hairline strokes, and re-inks
  `partners/bitcoin-historico-white.png` to `bitcoin-historico.png` and `partners/bitpoker-black.png`
  to `bitpoker.png`;
- re-inks `bull-black.png` to `bull.png` at its 500×510 canvas (the intro's closing card, where CSS
  inverts it to cream on black; the same trick turns the three partner marks cream, so the intro
  ships no second copy of any image);
- encodes the announcement poster `poster.jpg` (1080×1920) as `poster.jpg` + `poster.webp` (the desktop
  column and the tap-to-open viewer) and `poster-thumb.jpg` (320 wide, the phone thumbnail beside the
  hero lines), each under a byte ceiling. The viewer is a native `<dialog>` driven by `public/poster.js`;
  without JavaScript the same links open the JPEG;
- fetches the three fonts and their licences from fontsource and checks their byte counts.

Scratch downloads stay under `.scratch/` (gitignored) and never land in `public/`. Each re-inked
PNG is asserted to have one opaque colour with alpha intact.

### Replacing an asset

There is no build step, so a replaced image or font keeps its file name — and the `Cache-Control:
public, max-age=604800` blocks in `public/_headers` mean browsers keep the old bytes for a week
unless the URL changes.

1. Copy the new file over the **same** `brand/` name (an `.svg` may replace a `.png` of the same
   stem; the script prefers SVG and then emits icons at every size without upscaling — ask the
   designer for SVG).
2. `npm run assets`, then look at the outputs at 1×.
3. Bump the `?v=` query on every reference to the changed file — in **both** HTML files (`src`,
   `srcset`, icons, preload, `og:image`) **and** in `style.css` (`@font-face url()`). **Today no
   reference carries `?v=` at all** — the shipped URLs are the implicit `v1`, and the `_headers`
   and `style.css` comments describe the convention, not the current state. So the first
   replacement must **add** `?v=2` to every `img/` and `fonts/` reference in both HTML files and
   `style.css` (all of them, in that one commit, so the whole tree is on the scheme from then on);
   later replacements increment the number on the changed file's references only. The asset layer
   ignores the query when matching a file, so nothing else changes.

   ```sh
   grep -rn 'fonts/\|img/' public/     # lists every reference
   ```

4. Commit `brand/`, `public/img/`, `public/favicon.ico` and the bumped references together.

## The opening sequence

`/` and `/es/` open on a black screen: five short text frames fade in front and centre, then the
three partner marks, then a quick cut to the bull-and-rider with **Join the waitlist** (lands on
the form with the email field focused) and **Continue to the site**. That last card holds until
the visitor acts. Skip (top right) or Esc ends it; a tap, a horizontal swipe or the ← → keys step
through the frames, forward and back. A **View
intro** pill at the bottom right of the page replays it on request (motion preference or not —
that is an explicit ask); it is `hidden` until `intro.js` unhides it.

- `public/intro.js` is loaded **synchronously in `<head>`** so it can put `.has-intro` on `<html>`
  before first paint — deferred, the cream page would flash before the black. It plays only when
  motion is allowed (`prefers-reduced-motion: no-preference`), **once per browser session**
  (`sessionStorage` key `rr-intro`, set at start so a reload mid-sequence skips it; storage that
  throws means play-and-forget) and never on a URL with a fragment (`#signup` from a mail goes
  straight to the form). Without JS the overlay is `display:none`.
- The text frames are static markup in `section.intro` (right after the skip link in each page):
  copy written for the screen, shorter than the About section, one `.intro-slide` per frame with
  `<br>` for the line breaks. Then the `.partners` marks are cloned in, then the closing card.
- Timing lives at the top of `intro.js`: a text frame holds `800 ms + 170 ms × words` between a
  0.9 s fade-in and a 0.6 s fade-out, the marks hold 3.2 s, the cut to the closing card is 0.25 s.
  The CSS durations in `style.css` ("intro" block and the motion query) mirror those constants.
- While it plays, everything else in `<body>` is `inert` and `theme-color` is black; both are
  restored as it leaves. A replay hands focus back to the View intro button when it ends.

## Fonts and licences

| Font | Use | Licence |
|---|---|---|
| Bevan 400 | date, signup heading, 404 numeral | OFL 1.1 — `public/fonts/LICENSE-bevan.txt` |
| Cormorant Garamond 400 / 600 | body and the intro frames / button, label, language switch, `<strong>` | OFL 1.1 — `public/fonts/LICENSE-cormorant-garamond.txt` |
| Dust West | the wordmark, **inside the logo images only** | personal-use only; forbids conversion — never installed, shipped or embedded as a font |

The WOFF2 files are fontsource 5.3.0 latin subsets (Bevan 21,008 B; Cormorant Garamond 400 22,876 B;
Cormorant Garamond 600 23,396 B), self-hosted from `public/fonts/`, declared once in `style.css` with `font-display:swap`
and fontsource's latin `unicode-range`. The subset covers the Spanish accents and ¿ ¡ but not ₿ —
no page text uses it (it appears only inside the poster and partner images), and U+20BF is never typed.

## Deploying

**Pushing to `main` deploys.** The Worker is connected to this GitHub repository with Cloudflare
**Workers Builds**: every push to `main` runs the build command (`npm test`) and then the deploy
command (`npx wrangler deploy`) on Cloudflare's build servers, using an API token Cloudflare
creates for the purpose. No Cloudflare credential lives in this repository or in GitHub. A failing
test stops the deploy, because the build command runs first.

The connection is made once in the dashboard: *Workers & Pages → `renaissance-rodeo` → Settings →
Builds → Connect*, which installs the Cloudflare GitHub App (grant it this repository only).

| Field | Value |
|---|---|
| Git repository | `sovITxyz/renaissance-rodeo` |
| Branch | `main` |
| Build command | `npm test` |
| Deploy command | `npx wrangler deploy` (the default) |
| Root directory | empty |
| Builds for non-production branches | off — pull requests are tested by GitHub Actions instead |

The Worker name in the dashboard must equal `name` in `wrangler.jsonc` (`renaissance-rodeo`) or the
build fails. The Node version comes from `.node-version` (22), which the build image honours;
without it the image uses its own default (Node 24).

**A Workers Builds deploy is non-interactive, so it auto-confirms.** wrangler answers its own
*"Update them to point to this script instead?"* prompt with yes when stdout is not a TTY, so every
deploy re-asserts the two custom domains in `wrangler.jsonc` without asking. That is intended while
the routes are live; it also means a `routes` change merged to `main` takes effect on push.

A manual deploy still works, for example while Workers Builds is unavailable:

```sh
npx wrangler login     # once; account RenaissanceRodeo
npm run deploy         # wrangler deploy
```

Deploy manually only from a clean, up-to-date `main`. Anything else puts code in production that is
not in `main`, and the next push to `main` silently replaces it.

### CI

`.github/workflows/test.yml` runs `npm test` on every pull request and on pushes to `main`, on
GitHub Actions, with `contents: read` and no secrets. The actions are pinned to commit SHAs and the
Node version comes from the same `.node-version`. It is the pull-request signal; the deploy gate is
the Workers Builds build command above.

### Source history

The site was first built in the private GitLab project `sovtech/renaissance-rodeo` on sovit.xyz
(merge request !1 built the site, !2 cut the domain over). GitHub has been the canonical remote since
2026-09-21 because Workers Builds cannot watch a self-hosted GitLab; the GitLab project is no longer
pushed to and may lag behind.

### Smoke configuration vs cutover

Since the 2026-09-21 cutover `wrangler.jsonc` is in **live** configuration: two `routes` entries
with `custom_domain: true` for `renaissance.rodeo` and `www.renaissance.rodeo`, plus
`workers_dev: false`. Before that it shipped in **smoke** configuration (`workers_dev: true`, no
`routes`), which created the Worker `renaissance-rodeo` on its workers.dev hostname so it could be
tested in production, and so `wrangler secret put` had a Worker to write to.

Deploying with those routes **takes the two hostnames over** from whichever Worker holds them (the
old `bitcoin-rodeo`). wrangler asks *"Update them to point to this script instead?"* in a terminal
and **overrides silently when stdout is not a TTY** — a piped or CI deploy claims the domains with
no prompt. There is no `--force` and no dry run, so the routes are added only when the takeover is
intended. The test suite refuses a `wrangler.jsonc` with routes and `workers_dev: true` together,
so the site cannot end up on two public hostnames, one of them outside the zone's settings.

Order matters: **deploy the new Worker first, let it take the domains, then delete the old one.**
Deleting a Worker that still holds custom domains leaves orphaned, locked DNS records (error 1043).
The old Worker's Advanced Certificate is not removed automatically; it is harmless.

Cutover checklist (done 2026-09-21; kept for any future domain move):

1. Add the two `routes`, set `workers_dev: false`, `npm run deploy`. In a terminal wrangler asks
   before taking the hostnames; a piped shell takes them without asking.
2. `curl -sI https://renaissance.rodeo/`, `https://www.renaissance.rodeo/` and
   `https://renaissance.rodeo/es/` — new page, `content-security-policy` present; `/es` → 307.
3. One real signup lands in the MailerLite group (check the count, not the address).
4. From the old checkout: `npx wrangler delete --name bitcoin-rodeo`, then
   `npx wrangler d1 delete rodeo-list -y` (0 rows, verified), then archive the old GitHub repo.
   Each step confirmed by hand first.
5. Fill in the *Cutover record* below.

## Tests

```sh
npm test
```

Runs in `workerd` via `@cloudflare/vitest-pool-workers` against the real `wrangler.jsonc`, with
`fetch` stubbed — no network, no credentials. The suite deliberately covers only the paths where a
mistake fails *open* or fails *silently*:

- **fail-closed**: 503 with no `TURNSTILE_SECRET`; 503 with a test secret outside `DEV_MODE`; 403
  when siteverify says `success:false`; 503 when `MAILERLITE_API_KEY` is unset or
  `MAILERLITE_GROUP_ID` is unset or malformed (the placeholder, a leading zero, a number); 503 on
  MailerLite 429, 500 or a thrown `fetch`; 405 on `GET`; 403 cross-origin; 400 on a bad email after
  Turnstile passes;
- **the request shape**: the happy path makes exactly one POST to `connect.mailerlite.com/api/subscribers`
  with the email lowercased, the group id as a string, **no `status` field** and no `@` in the URL;
  `lang=es` adds `MAILERLITE_GROUP_ID_ES` when it is set and well-formed, and nothing when it is
  not;
- **no membership oracle**: a MailerLite 200 (existing), 201 (new) and 422 (refused upstream)
  produce byte-identical bodies, and the 422 log line carries key names only; the honeypot
  (`rr_ref`) returns 200 with zero outbound calls;
- **CSP equality**: the `content-security-policy` on a Worker response equals the line in
  `public/_headers` (read by `vitest.config.mjs` and passed in as `TEST_HEADERS_CSP`);
- **configuration**: `vitest.config.mjs` reads `wrangler.jsonc` with wrangler's own config reader
  (`unstable_readConfig`, so comments are handled) and passes the result in as `TEST_WRANGLER_*`
  bindings; the tests assert that `vars` contains none of `DEV_MODE`, `TURNSTILE_SECRET`,
  `MAILERLITE_API_KEY`, `MAILERLITE_WEBHOOK_SECRET`; that any group id present is a string matching
  `GROUP_ID_RE` (the committed file has the block commented out, which passes; an uncommented
  placeholder fails); and that non-empty `routes` implies `workers_dev: false`;
- **static**: `/` is `lang="en"`, `/es/` is `lang="es"`, an unknown path returns the 404 page.

The test runtime pins an older `compatibilityDate` than `wrangler.jsonc` because the `workerd`
bundled with the pool refuses newer dates; see the comment in `vitest.config.mjs`.

## CSP

`style-src` carries `'unsafe-inline'` **for now**. Turnstile's widget injects styles, and the safe
way to find out whether it needs the allowance is to watch it render a challenge: load the page
locally with the forced-challenge sitekey `3x00000000000000000000FF` and check the console for a
`style-src` violation. None → drop `'unsafe-inline'` from the CSP line in `public/_headers` **and**
from `SECURITY_HEADERS` in `src/index.js` (the test fails if only one changes). Everything else is
already tight: `script-src 'self' https://challenges.cloudflare.com`, no `data:`, no CDN, no inline
scripts — the form script is `public/signup.js`.

## Email

Cloudflare **Email Routing** receives mail for `renaissance.rodeo`. The catch-all forwards every
address to `rodeo@sovit.xyz`. That address has no mailbox of its own on sovit.xyz; the sovit.xyz
domain catch-all delivers it to the `cameron` mailbox. A destination must be verified by clicking
the link Cloudflare mails to it before any rule can forward there.

The login wrangler uses carries `email_routing (write)`, so routing is managed from here:

```sh
npx wrangler email routing settings renaissance.rodeo          # enabled? status?
npx wrangler email routing dns get renaissance.rodeo           # records Cloudflare expects
npx wrangler email routing addresses list                      # destinations and verification
npx wrangler email routing rules get renaissance.rodeo catch-all
npx wrangler email routing rules update renaissance.rodeo catch-all \
  --action-type forward --action-value rodeo@sovit.xyz --enabled true
```

DNS records themselves are edited in the dashboard: the wrangler login can only read the zone.

**One SPF record, two senders.** The apex must carry exactly one `v=spf1` TXT record, with both
includes:

```
v=spf1 include:_spf.mx.cloudflare.net include:_spf.mlsend.com ~all
```

Cloudflare's include covers Email Routing, which rewrites the envelope sender of forwarded mail to
`renaissance.rodeo`; MailerLite's covers campaigns. A second `v=spf1` record makes SPF fail for
both. MailerLite's own setup writes `v=spf1 a mx include:_spf.mlsend.com ~all`; the `a` and `mx`
terms authorise the Worker's addresses and Cloudflare's inbound mail servers, neither of which sends
mail, so they are left out. Re-running MailerLite's automatic domain setup can put its record back:
check for a single `v=spf1` afterwards with `dig +short TXT renaissance.rodeo`.

DKIM keys coexist: `cf2024-1._domainkey` for Cloudflare, added from *Email → Email Routing →
Settings*, and `litesrv._domainkey`, MailerLite's CNAME. There is no DMARC record yet. When
MailerLite sending starts, add `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@renaissance.rodeo`,
and the reports arrive through the catch-all.

## Cutover record

- `2026-09-21` — smoke deploy of `renaissance-rodeo` on
  `renaissance-rodeo.bitcoin-rodeo.workers.dev` verified (pages, `/es` → 307, 404, headers, every
  API gate; signups fail closed with `unavailable` because no secret is set yet).
- `2026-09-21` — domains `renaissance.rodeo` + `www` moved from Worker `bitcoin-rodeo` to
  `renaissance-rodeo`; workers.dev hostname switched off. Signups stay `unavailable` until
  `TURNSTILE_SECRET`, `MAILERLITE_API_KEY` and `MAILERLITE_GROUP_ID` exist and the real sitekey
  replaces the test one.
- `2026-09-22` — Turnstile widget `renaissance-rodeo-signup` created from the terminal, real sitekey
  in both pages, `TURNSTILE_SECRET` set (Bitwarden copy first).
- `2026-09-22` — MailerLite groups created, ids in `wrangler.jsonc` `vars`, `MAILERLITE_API_KEY`
  set (Bitwarden `renaissance-rodeo-mailerlite-api-key` first). Every signup prerequisite exists.
- `2026-09-21` — old Worker `bitcoin-rodeo` and its D1 `rodeo-list` (0 subscribers) deleted. There
  is no second Worker to fall back to any more: roll back with `npx wrangler rollback` to an earlier
  version of `renaissance-rodeo`.
- **Pending:** delete the old GitHub repository `sovITxyz/bitcoin-rodeo` (needs a `gh` token with the
  `delete_repo` scope). Its full history stays in the local checkout `~/Projects/bitcoin-rodeo`.

## Still browser-only

Nothing here is automated; each is a few minutes in a dashboard.

- **MailerLite sender-domain authentication** — the DKIM CNAME, SPF TXT and verification TXT on the
  `renaissance.rodeo` zone (see *MailerLite*).
- **Workers Builds connection** — once, see *Deploying*. Until it exists, `main` is deployed by hand.
- **SPF merge and Cloudflare DKIM** for Email Routing — see *Email*.
