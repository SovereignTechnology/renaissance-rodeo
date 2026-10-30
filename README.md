# Renaissance Rodeo

> **Source of truth:** [`nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.sovit.xyz/renaissance-rodeo`](https://gitworkshop.dev/npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.sovit.xyz/renaissance-rodeo) — issues and pull requests live there. This GitHub repository is the deploy mirror; push to the Nostr remote, not here.

Bilingual event site for **Renaissance Rodeo** — 13 November 2026 · Ilopango, El Salvador, the day
after Bitcoin Histórico (11–12 November 2026, Centro Histórico, San Salvador): a short home page
plus About, Tickets and Sponsors pages, each in English and Spanish. Times, transport and
directions are announced to the mailing list first, so the home and tickets pages collect email addresses: a form
gated by Cloudflare Turnstile whose submissions go straight into a listmonk list. There is
no database, no build step and no server beyond one Cloudflare Worker that serves the static files
and answers a single API route. Live at <https://renaissance.rodeo>. The canonical source is on
Nostr (see *Source history*); GitHub `SovereignTechnology/renaissance-rodeo` (public) is the deploy
mirror, and pushing to its `main` deploys the site.

## Requests

| Request | Answered by |
|---|---|
| `GET /` | `public/index.html` (English) |
| `GET /es/` | `public/es/index.html` (Spanish); `/es` is a 307 to `/es/` from the assets layer |
| `GET /about`, `GET /es/about` | `public/about.html`, `public/es/about.html` (see *The about page*); `/about/` and `/about.html` are 307s to `/about` from the assets layer, likewise for `/es/about` |
| `GET /team`, `GET /es/team` | 301 to `/about#team`, `/es/about#team` (`public/_redirects`), with their `/` and `.html` spellings: the team page became the About page's team section on 2026-10-24 |
| `GET /tickets`, `GET /es/tickets` | `public/tickets.html`, `public/es/tickets.html` (see *The tickets page*); slash and `.html` spellings redirect the same way |
| `GET /sponsors`, `GET /es/sponsors` | `public/sponsors.html`, `public/es/sponsors.html` (see *The sponsors page*); likewise |
| `POST /api/subscribe` | `src/index.js`: same-origin → per-IP rate limit (5/60 s, `SUBSCRIBE_LIMIT`, fails open) → 4 KB size cap → honeypot (`rr_ref`) → Turnstile siteverify (fails closed) → email normalise → listmonk `POST /api/subscribers` → `{ok:true}` |
| everything else | `public/*` via the Worker's `ASSETS` binding (`style.css`, `signup.js`, `img/`, `fonts/`, `robots.txt`, `sitemap.xml`); unknown paths get `public/404.html` |

Static files never reach the Worker code, so their headers come from `public/_headers`; API and
404 responses get `SECURITY_HEADERS` from `src/index.js`. The two must stay byte-identical (tested).

The Worker answers the same `{ok:true}` for a new address, an address already on the list, an
address listmonk refuses (400/422) and a honeypot hit — it is not a membership oracle. It never
logs the address and never reads listmonk's response body. When a secret is missing, the list id
is missing or malformed, or `DEV_MODE` is set on a production hostname, it returns `503 unavailable`
and logs, rather than silently accepting signups it cannot deliver or did not verify. The list lives
in listmonk at `news.renaissance.rodeo` and is its only copy; the unsubscribe link is in each
campaign.

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

`npm run dev` binds all interfaces so the preview is reachable from other machines on your private
network at `http://<this-machine>:8788`.

### Local secrets and DEV_MODE

`.dev.vars` (gitignored, never deployed) holds:

```
DEV_MODE=true
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
```

**Never put the production `LISTMONK_API_TOKEN` or `LISTMONK_WORKER_HEADER` in `.dev.vars`.**
`npm run dev` binds all interfaces and `DEV_MODE=true` disables the test-secret refusal, so anyone
who can reach the dev port could push auto-passing signups straight into the live list. Leave both
unset to exercise the form up to the `503 unavailable` the Worker returns without them.

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

## listmonk

The list lives in listmonk at `news.renaissance.rodeo` (it replaced MailerLite in October 2026).
The Worker posts each signup to `https://news.renaissance.rodeo/api/subscribers` with two
credentials, both Cloudflare secrets set only through `scripts/set-secret.sh` (see *Secrets*):

| What | Where | Why |
|---|---|---|
| `LISTMONK_API_TOKEN` | secret; sent as `Authorization: token rodeo-worker:<token>` | API token of a listmonk API user that may only manage subscribers |
| `LISTMONK_WORKER_HEADER` | secret; sent as `x-rodeo-worker` | shared header the gateway in front of listmonk requires before anything reaches it |
| `LISTMONK_LIST_ID` | `wrangler.jsonc` → `vars` (`"2"`) | public configuration, inert without the token |
| `LISTMONK_LIST_ID_ES` | `wrangler.jsonc` → `vars` (`"3"`), optional | the Spanish list; same shape, must differ from `LISTMONK_LIST_ID` |

`LISTMONK_LIST_ID` must be a **quoted string** matching `LIST_ID_RE = /^[1-9][0-9]{0,8}$/`
(`src/index.js`); it is sent as a number once it passes. A missing token or header, or a missing or
malformed list id, answers `503 unavailable` with a log line naming the variable (never its value),
and nothing is sent. `vars` live only in `wrangler.jsonc`: `wrangler deploy` replaces the Worker's
plain-text bindings with the file's (`keep_vars` defaults to false), so a value typed into the
dashboard is deleted by the next deploy.

**The list is single opt-in (Cameron, 2026-10-11).** listmonk sends no confirmation mail; an address
added by the Worker receives the next campaign. Turnstile stops scripted signups, but nothing stops a
person typing someone else's address.

**Two lists, disjoint (Cameron, 2026-10-11).** A signup from a Spanish page goes on "Renaissance Rodeo
(ES)" (`LISTMONK_LIST_ID_ES`) *instead of* "Renaissance Rodeo" (`LISTMONK_LIST_ID`), so a campaign sent in
each language reaches everyone once; pick both lists to reach everyone with one mail. Someone already
subscribed who signs up again on the other language's page stays where they are (listmonk answers 409).
The request body is `{email, lists: [id], status: "enabled", attribs: {lang}}`, `lang` being
`es` for signups from the Spanish pages and `en` otherwise, so Spanish campaigns can be targeted with
a subscriber query. `preconfirm_subscriptions` is never sent (a single opt-in list does not need it), and neither is
`name` (listmonk derives one).

**Response mapping** (`src/index.js`): 200 and 409 (address already exists) → `{ok:true}`; 400 and
422 (listmonk refused the address) → `{ok:true}` too, logging only the status — the body is never
read, because listmonk's messages can quote the address; 401/403 → `503` and `credentials or gateway
header rejected` in the logs; 404 → `503` and `the gateway refused the request` (a header mismatch);
429 and anything else → `503`; a network error or the 10 s timeout → `503`, logging the error message
only. The call is awaited, so a failure is shown to the person as a real error to retry, never
swallowed. Answering a refusal as success is rule 3: a refusal can reflect the address's history with
the list, and a visible difference would be a membership oracle.

## Turnstile

The form uses the production widget **`renaissance-rodeo-signup`** (Managed, hostnames
`renaissance.rodeo` and `www.renaissance.rodeo`), sitekey `0x4AAAAAAE_nBKxDHDJBj9OH` in the four
pages with a signup form: `public/index.html`, `public/es/index.html`, `public/tickets.html` and
`public/es/tickets.html`. Its secret is the Worker secret `TURNSTILE_SECRET`,
with the recoverable copy in Bitwarden `sovtech/shared` as `renaissance-rodeo-turnstile-secret`.
Both were set on 2026-09-22.

**Local development** needs Cloudflare's test sitekey, because `localhost` is not one of the
widget's hostnames and the real widget refuses to render there. Swap it in all four files for the
session and **do not commit it**: the test suite fails on a test sitekey, on a key that differs
between the four files, and on a widget in any other page, and Workers Builds runs the suite
before every deploy, so a swapped key cannot ship.

```sh
sed -i 's/data-sitekey="0x4AAAAAAE_nBKxDHDJBj9OH"/data-sitekey="1x00000000000000000000AA"/' public/index.html public/es/index.html public/tickets.html public/es/tickets.html
git checkout -- public/index.html public/es/index.html public/tickets.html public/es/tickets.html   # afterwards
```

The same check by hand, before any deploy:

```sh
grep -rl 'data-sitekey="1x0' public/ | wc -l   # must be 0
grep -rl data-sitekey public/ | wc -l          # must be 4
```

Replacing the sitekey in only some of the files is the failure that hides. Turnstile renders a widget with a
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

Exactly three: `TURNSTILE_SECRET`, `LISTMONK_API_TOKEN` and `LISTMONK_WORKER_HEADER`. None is in this repo, `.dev.vars` is
gitignored, and none may ever be added to `vars` in `wrangler.jsonc` — **a `vars` entry shadows the
secret binding of the same name on deploy**, silently substituting the configured string. The test
suite refuses a `wrangler.jsonc` that puts any of them (or `DEV_MODE`) under `vars`, so the mistake
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
scripts/set-secret.sh LISTMONK_API_TOKEN
scripts/set-secret.sh LISTMONK_WORKER_HEADER
```

It accepts only those three names. Without `--from-file` it prompts `value: ` and reads with
`IFS= read -rs` — nothing is echoed, nothing is on a command line, and an empty or
whitespace-containing value is refused. The value goes into a `0600` temp file under `$HOME`
(`mktemp "$HOME/.rr-secret.XXXXXX"`) and from there through three steps, each run only if the one
before it succeeded:

1. `sudo -n /usr/local/bin/secret-store renaissance-rodeo-<name> <file>` — a copy into the
   Bitwarden `sovtech/shared` collection, item **`renaissance-rodeo-turnstile-secret`**,
   **`renaissance-rodeo-listmonk-api-token`** or **`renaissance-rodeo-listmonk-worker-header`**, so
   the value survives the laptop. Cloudflare is
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
step 3. For example:

```sh
(umask 077; IFS= read -rs -p 'token: ' k && printf %s "$k" > ~/.rr-listmonk)   # subshell: k dies with it
scripts/set-secret.sh LISTMONK_API_TOKEN --from-file ~/.rr-listmonk
```

That `printf` is safe: `"$k"` is expanded inside the subshell, and the history line holds the
literal `"$k"`, not the value.

`npm run secrets` (`wrangler secret list`) prints names only and must show exactly the three above.

## Assets

`brand/` holds the **sources** under stable names (see `brand/README.md`); everything under
`public/img/` and `public/favicon.ico` is **derived** from them by `scripts/build-assets.sh`
(`npm run assets`, idempotent). Never edit a derived file. The script:

- re-inks every brand PNG from black to the page ink `#0e1d2d` (the page is literally two colours),
  trims, resizes: `logo.png` 1200×591 + `logo.webp` (hero), `mark.png` 144×144 (no longer shown on the pages since the header mark was removed; kept as a brand asset), favicons
  `favicon-32.png` / `apple-touch-icon.png` / `icon-192.png` / `icon-512.png` and `favicon.ico` on an
  opaque cream disc so they read on dark tab strips;
- renders `og-en.png` / `og-es.png` (1200×630 share images) with a Bevan TTF fetched at build time and
  not shipped;
- recolours `partners/origen-ganadero.svg` to ink and widens its hairline strokes, and re-inks
  `partners/bitcoin-historico-white.png` to `bitcoin-historico.png` and `partners/bitpoker-black.png`
  to `bitpoker.png`; and, for the second sponsor tier, `partners/tbhs.png` to `tbhs.png` (357×192),
  `partners/bitdriver-black.png` to `bitdriver.png` (480×120) and `partners/beefbackbetter-black.png` to
  `beefbackbetter.png` (277×288); and `partners/clubcocal.png` to `clubcocal.png` (287×288), the
  circle emblem of the main sponsor Club Cocal;
- re-inks `bull-black.png` to `bull.png` at its 500×510 canvas (it was the opening sequence's closing
  card; the sequence was removed on 2026-10-24 and the file is kept as a brand asset, like `mark.png`);
- encodes the announcement poster `poster.jpg` (1080×1920) as `poster.jpg` + `poster.webp` (the desktop
  column and the tap-to-open viewer) and `poster-thumb.jpg` (480 wide, the phone and tablet thumbnail
  beside the activity list), each under a byte ceiling. The viewer is a native `<dialog>` driven by `public/poster.js`;
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
3. Bump the `?v=` query on the changed file's references — in every HTML file (`src`, `srcset`,
   icons, preload, `og:image`) **and** in `style.css` (`@font-face url()`). The tree went onto the
   scheme on 2026-10-14 (the team-photo change added `?v=2` to every `img/` and `fonts/` reference),
   so **increment the number on the changed file's references only** — a second replacement of
   `team-tom.jpg` becomes `?v=3`. The asset layer ignores the query when matching a file, so nothing
   else changes. `/favicon.ico` is not under `img/` and keeps its bare URL.

   ```sh
   grep -rn 'fonts/\|img/' public/     # lists every reference
   ```

4. Commit `brand/`, `public/img/`, `public/favicon.ico` and the bumped references together.

## Navigation

Every page except `404.html` has the same header and footer, in its language:

```
desktop   [mark]  ABOUT  TICKETS  SPONSORS  [X] [Instagram]               EN | ES
phone     [mark] [menu]                                                  EN | ES
```

- **Header** (`.top`): the small bull-and-rider mark (`img/mark.png`, 36px, linking home) on every
  page but `/` and `/es/`, which open with the hero logo instead; then `nav.site` (the page links
  and the X and Instagram icons); then the language switch, pushed right. The switch links to
  **the same page** in the other language.
- **Below 1024px** the links and icons do not fit beside the switch (the Spanish links alone are
  about 335px), so the bar stays one row and a **menu button** (three bars, a cross while open,
  labelled Menu / Menú) sits right after the bull mark (at the left edge on `/` and `/es/`, which
  have no mark), with `EN | ES` on the right. It opens `nav.site` as a panel under the bar:
  the page links one per line, then the icons. `nav.site` is an HTML **popover**
  (`<nav … popover>` + `<button popovertarget="site-nav">`), so it opens, closes on Esc, on a tap
  outside or on the button again, with **no script**. The browser hides a popover until it is
  opened; from 1024px `style.css` shows it in the bar instead, and hides the button. A browser
  without popovers never hides it, gets no button, and shows the links on a row under the bar.
- **Footer** (`.foot-nav`): the same page links in the header's voice (uppercase), then the copyright
  line with the other-language link. No X or Instagram there (Cameron, 2026-10-26); they stay in the
  header. From 1024px the links and the copyright share **one line**, links left and copyright right;
  on phones they stack (Cameron, 2026-10-27).
- **One navigation voice** (Cameron, 2026-10-27): the header links, the language switch, the footer links
  and the About page's jump links all set their text from `--nav-size` and `--nav-track` in `style.css`
  (Cormorant 600, uppercase, tracked), go red on hover and underline the page or section you are on, so the
  three navs cannot drift apart.
- The page you are on is marked `aria-current="page"` (underlined) in both lists. The home pages
  mark none.
- Spanish labels: **Acerca de**, **Boletos**, **Patrocinadores**; the Spanish pages are `/es/about`,
  `/es/tickets`, `/es/sponsors`.

**Adding a page to the list** means editing the header and the footer of all eight pages. The
tests fail unless every page of a language carries the same links in the same order, in both
places, with only the current one marked, and unless every page has exactly one popover nav with
one button pointing at it.

## The venue map

Every place name on the eight pages opens the venue in the visitor's own maps app (Cameron,
2026-10-28). The venue is at **13.676983, -89.095381**. The names that do it: the footer's "Ilopango,
El Salvador" on every page, the home date lockup's, and the "Ilopango" in the tickets box, the sponsors
lede and the About page's team line. Each is a `<button class="place" popovertarget="venue-map">`
styled as an underlined word of its sentence, and it opens one **popover** per page, `#venue-map`,
placed after the footer: the place, **Open in** / **Abrir en**, then **Google Maps**, **Apple Maps** and
**Waze**, and a **Close** / **Cerrar** button. Like the menu, it needs **no script**: it opens in the middle
of the screen over a dimmed page and closes on Esc, a tap outside or Close. A browser without popovers
cannot open it, so there the three links stay at the bottom of the page and the names read as plain
text. On a phone each link opens its app when it is installed (universal links), its website when not.

- The links: `https://www.google.com/maps/search/?api=1&query=13.676983%2C-89.095381`,
  `https://maps.apple.com/?ll=13.676983,-89.095381&q=Renaissance%20Rodeo`,
  `https://waze.com/ul?ll=13.676983,-89.095381&navigate=yes`. Cameron's share link
  (`maps.app.goo.gl/adckMoVBJtxjHzDbA`) points to the same coordinates but carries Google's share
  tracking (`g_ep`, `skid`), so the site uses Google's documented URL for the point instead.
- Left plain on purpose: `<title>`, the meta and share card descriptions, the share bar's texts and the
  poster's alt text (none can hold a button), and "El Salvador" in partner captions and team bios (not
  the venue).
- The ticket shop prints its location as plain text (pretix's own templates), so it has no map link.
- Moving the venue means the three links and the tests' copy of them; the tests require on every page
  exactly one `#venue-map` after the footer, the three links in this order, and every place button
  pointing at it.

## Social links

X and Instagram (`@rodeo_sv` on both) sit in the header as two inline-SVG icons after the page
links, drawn in `currentColor` (`.social` in `style.css`): no row of their own, no image file,
nothing for `img-src` or `npm run assets`. Each icon link carries `rel="me noopener"` and an
`aria-label` in the page's language; the footer does not repeat them. `<meta name="twitter:site"
content="@rodeo_sv">` credits the share card on X. A handle change touches the header of all
eight pages (tested); `404.html` has no social links.

The copy ends, after the signup, with an article-style **Share / Follow** block (`section.share`):

- Five share links (WhatsApp, X, Facebook, Telegram, email) are plain links with the page's URL and
  title already encoded into each `href`, so they work with no JavaScript. The four web ones
  open in a new tab (`target="_blank" rel="noopener"`), deliberately unlike every other outbound
  link on the site, so sharing never takes the visitor away from the page.
- Two buttons ship `hidden` and are unhidden by `public/share.js` only where the browser can run
  them: **Copy link** (Clipboard API; shows the section's `data-copied` text for 3 s) and the
  system **share sheet** (Web Share, mostly phones). The script reads `data-url` / `data-title` /
  `data-copied` from the section, so it has no per-language text.
- **Follow** repeats the header's two `@rodeo_sv` links.

If the page URL or title changes, update the section's `data-*` values **and** the encoded share
`href`s in both HTML files. "No spam. Unsubscribe any time." sits inside the form, directly under
the input row (tested).

## The home page

`/` and `/es/` are short on purpose (Cameron, 2026-10-24): the logo and the date lockup, a red
**Buy tickets** / **Comprar boletos** button centred under it that goes **straight to the ticket shop**
(`https://tickets.renaissance.rodeo/rodeo/2026/`), and "The day after Bitcoin Histórico" centred
under it. Then one sentence about the day that names every activity (*It will be a full afternoon of
rodeo entertainment, including bull riding, barrel racing, …*; Cameron wants it to cover everything),
the **activity list** (below), and **Learn more about Renaissance Rodeo →** / **Conozca más sobre
Renaissance Rodeo →**, a plain text link to `/about` whose arrow is an inline SVG (the font subset has
no U+2192). Then the partner rows, the signup form (pitched at times, transport and directions to
the venue), the share bar, and the poster column on desktop. The full story lives on the About page.

**The activity list** (`ul.activities`, 12 items in Cameron's order: bull riding … country) is on
the home page and again after the About page's event text, identical (tested). Items are written in
sentence case and uppercased by CSS, each with a small red diamond. On phones and tablets the home
page sets it in a row beside the poster thumbnail, `[poster | list]`, one column, so its twelve lines
stand about as tall as the thumbnail and neither leaves a gap (the thumbnail used to float in the
hero beside one line of text). On phones the list drops the uppercase and a size, or most items would
wrap in that narrow column. From 64rem the thumbnail hides (the poster has its own column) and the
list runs in two columns (three on the wider about page). The sentence keeps "animal fairs", which the list does not have.

**There is no opening sequence any more** (removed 2026-10-24, with its "View intro" pill, at
Cameron's request): no `intro.js`, no overlay, no intro CSS. It is in the history before that date.

## The about page

`/about` (`public/about.html`) and `/es/about` (`public/es/about.html`) replaced the team page on
2026-10-24 (the files were `git mv`ed, so their history is the team page's). They are linked as
**About** / **Acerca de** in every page's header and footer (*Navigation*), and from the home page's
learn-more line. The old `/team` addresses answer 301 to `/about#team` (`public/_redirects`, which
miniflare honours too, fragment included). The page is static, has no script, and needs nothing new
in the CSP.

```
h1        About Renaissance Rodeo / Acerca de Renaissance Rodeo
nav.jump  The event · Team · Sponsors      (El evento · Equipo · Patrocinadores)
#event    the three paragraphs that used to be the home page's About text
#team     The organizing team: the lede and the cards (below)
#sponsors Sponsors and partners: the home page's partner row, captions shown, then a line
          with sponsors@renaissance.rodeo
```

- **Jump links.** `nav.jump` is a row of three links (the header's voice, a small red diamond between
  them, centred on desktop) that sticks to the top of the screen. A tap
  scrolls smoothly (`html { scroll-behavior: smooth }`, only without a reduced-motion preference)
  and lands the section heading just under the row (`scroll-margin-top`). Where CSS scroll
  markers exist (Chrome 140+: `scroll-target-group` + `:target-current`) the link of the section in
  view is underlined, as the current page is in the header; elsewhere the link of the
  section you jumped to is (`:has(#team:target)`, behind `@supports not selector(:target-current)`).
  `:target-current` has its own rule and is never in the header's selector list: a browser that does not
  know it drops a whole rule that names it. No script.
  Below 768px the three share the row equally and the type shrinks from the header's size just enough to
  keep the Spanish labels on one row (measured widths are in the CSS comment); if the row still cannot fit
  (a 320px phone) it slides sideways instead of wrapping. Its background is the body's
  fixed wash, so it is invisible where it sits and still covers what scrolls under it.
- **The scroll fade-up is not used here**: the sections are jump targets, and a section still
  translated by the animation when the browser scrolls to it lands 1.25rem off, under the row.
- **Desktop** (64rem up): no poster column; the page takes the full width, the event text keeps a
  reading measure, the cards run in two columns, and the main sponsors sit two across, centred.
- **The partner row is the home page's** (tested): a new partner goes into both home pages, both
  about pages and both sponsors pages.

Each person is one `<li class="member">` in `ul.team-grid` inside `section#team`, in the order shown
(the name is an `h3` under the section's `h2`):

```html
<li class="member">
  <span class="avatar" aria-hidden="true"><img src="/img/team-tom.jpg" width="256" height="256" alt=""></span>
  <div class="member-body">
    <h3 class="member-name">Tom Taber</h3>
    <p class="member-org"><a href="https://origenganadero.com/" rel="noopener">Origen Ganadero</a></p>
    <ul class="social"> … one <li> per X link, the icon from the header, aria-label "Tom Taber on X" … </ul>
  </div>
  <p class="member-bio">A few sentences about the person; may carry an inline link.</p>   <!-- optional -->
</li>
```

The organisation line is plain text when there is no site to link (`Media &amp; Marketing`), and
the line, the icon list or the bio is left out when there is nothing to show. The bio is a sibling
of `.member-body`, not inside it, so that on phones it runs full width under the square. It is
translated, not copied, in the Spanish file, and the tests require the same people to have one in
both. A bio may carry an inline link to the person's organisation (`https://`, `rel="noopener"`),
as James's does to Beef Back Better.

**To add, remove or reorder someone, edit both files the same way** and in the same commit. The
tests compare them: the same names in the same order and the same links in the same order in both
languages; the square must hold either the person's photo or the initials of the first two words of
the name; every outbound link must be `https://` with `rel="noopener"`; every X icon must carry an
`aria-label` ("… on X" / "… en X"). Translate the organisation line when it is a description
(`Medios y marketing`), never a name.

**Only list people who have agreed to be listed.** This repository is public and the site deploys on
merge, so a name in a commit is published — whether or not the card is visible, and even if the
commit is reverted. Keep unconfirmed people out of commits, branch names and PR text entirely.

**Photos** live inside the square as an `<img>` with `width`/`height` and an empty `alt` (the
`aria-hidden` square already hides it): a self-hosted JPEG built from a source in `brand/team/` by
`scripts/build-assets.sh` like every other image — never a hotlinked or `data:` URL (`img-src
'self'`). The build cover-crops each source to a 256×256 square (`img/team-<name>.jpg`). A person
without a photo yet keeps the ink square with their initials in Bevan.

## The tickets page

`/tickets` and `/es/tickets` open with a ruled box: **Have a Bitcoin Histórico ticket? It includes
your entry to Renaissance Rodeo** (Spanish: *¿Tiene boleto para Bitcoin Histórico? Incluye su
entrada…*), with the Bitcoin Histórico emblem from the partner row and a link to its site. Then
**Buy tickets** / **Comprar boletos**: VIP Cowboy Deluxe $210 (the shop sells 50), regular entry $21. In the VIP
row, right under its name and price, what the ticket includes (Cameron, 2026-10-28): "Limited to 50 tickets. Each
one includes:" then an exclusive lakeside BBQ in the VIP area, a branded cowboy hat and a pick of 1 of 3 tees; the
hat and the tees each have a quieter "Hecho en El Salvador" line under them, in Spanish on both pages as he wrote
it (`lang="es"` on the English page). No emoji, and a test keeps them out of the section. The shop's VIP description says the same. Then **Bitcoin Only** / **Solo Bitcoin**
(no discount code is shown on the page; it lives in the shop), one Buy link to
`https://tickets.renaissance.rodeo/rodeo/2026/`, and under it a quieter line saying tickets arrive by email,
with `hello@renaissance.rodeo` as the address for questions (no mailbox: the mail catch-all delivers it to
the team, and the shop sends the same address as its Reply-To). Those are the section's only two links. Then a
text-only box: **Free entry with a DUI** / **Entrada gratuita con DUI**. DUI holders need no ticket
and show the DUI at the gate, so this is page copy only and not a product in the ticket shop. Then
**Stay in the loop** / **Novedades** with the home page's signup form word for word: same fields,
honeypot, Turnstile widget, messages and success line, posting to the same `/api/subscribe` and the same listmonk list (`data-lang` tags Spanish-page
signups with `lang: es`). The tests compare the form, the success line and the message
strings with the home page's, so a change to one form must be made in all four signup pages.

Deploy the Buy link only once the shop is open: a closed shop answers 403 "Shop offline".
The shop lives at `tickets.renaissance.rodeo`.

## The sponsors page

`/sponsors` and `/es/sponsors` carry the home page's partner rows (tested to match it) with every
caption shown, then **Become a sponsor** with `sponsors@renaissance.rodeo` (the zone's catch-all
forwards it, see *Email*). The About page's sponsors section carries the same rows.

There are **two tiers** (Cameron, 2026-10-24):

- **`ul.partners`**: the main sponsors, four in two rows of two, capped at `40rem` and centred: Bitcoin
  Histórico and Club Cocal (`clubcocal.com`), then Origen Ganadero and BitPoker SV. Club Cocal shows
  **its circle emblem only** (the crescent and the palm), without the CLUB COCAL lettering: the name is
  typed in its caption in the page's own bold, like Bitcoin Histórico's and BitPoker SV's (Cameron,
  2026-10-30). On phones the home page keeps the two-by-two marks with the captions screen-reader-only,
  and the about and sponsors pages stack them with every caption.
- **`ul.partners.tier-2`**: The Bitcoin Hardware Store (`tbhs.sv`), BitDriver (`bitdriver.taxi`) and
  Beef Back Better (`beefbackbetter.com`, added 2026-10-26), right under it. It sits below a hairline with
  no label, and its marks are smaller and side by side (three across; two-up on phones with the third
  centred under them).

Every mark is re-inked to the page ink. Both rows live in six files: both home pages, both about pages
and both sponsors pages. A new sponsor goes into the right row in all six, and its logo through
`brand/` and `npm run assets` like every other image.

## Fonts and licences

| Font | Use | Licence |
|---|---|---|
| Bevan 400 | date, signup heading, 404 numeral | OFL 1.1 — `public/fonts/LICENSE-bevan.txt` |
| Cormorant Garamond 400 / 600 | the body font — copy, buttons, labels, language switch, `<strong>`, the activity list | OFL 1.1 — `public/fonts/LICENSE-cormorant-garamond.txt` |
| Dust West | the wordmark, **inside the logo images only** | personal-use only; forbids conversion — never installed, shipped or embedded as a font |

The WOFF2 files are fontsource 5.3.0 latin subsets (Bevan 21,008 B; Cormorant Garamond 400 22,876 B;
Cormorant Garamond 600 23,396 B), self-hosted from `public/fonts/`, declared once in `style.css` with `font-display:swap`
and fontsource's latin `unicode-range`. The subset covers the Spanish accents and ¿ ¡ but not ₿ —
no page text uses it (it appears only inside the poster and partner images), and U+20BF is never typed.

**The date lockup.** On `/` and `/es/` the date and the place sit under the logo as two centred
lines of Bevan (`.when-date`, `.when-place`), sized in container units (`5.8cqi` of the hero) so
they scale with the logo at every width; the longest line, the Spanish date, fills about 95% of
the column. A browser without container units falls back to `--text-date`. The phone poster
thumbnail floats beside the two lines under it.

## Page scale

The root font size is the body size (20–23px), so `1rem` in `style.css` is 20–23px rather than
16px, and every rem-based length (type, column widths, gaps, the poster) comes out about 1.3× its
16px reading. At 100% zoom on a desktop that read too large; 75% browser zoom looked right. So
`--scale` multiplies the root size: `1` below 64rem (1024px), `.75` from 64rem up. Everything
measured in rem shrinks together, the full-screen poster viewer (sized in `vw`/`dvh`)
still fills the screen, and px sizes (icons, 44px tap targets, borders, the focus ring) stay as they
are. To tune desktop, change the one `.75`; phones and tablets are not touched by it.

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
| Git repository | `SovereignTechnology/renaissance-rodeo` (was `sovITxyz/…` before the account rename) |
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

### Staging

`staging.renaissance.rodeo` is a second Worker, **`renaissance-rodeo-staging`** (`env.staging` in
`wrangler.jsonc`), where a branch is looked at and approved before it is merged and goes live
(Cameron, 2026-10-24). Deploy it by hand from the branch under review:

```sh
npx wrangler deploy --env staging
```

Workers Builds deploys only the top-level Worker, so nothing reaches staging by itself and nothing
deployed to staging reaches production. The environment inherits `main`, `compatibility_date` and
`assets`; `vars` and `ratelimits` are set empty and no secret is ever put on it, so its signup form
answers `503 unavailable` and can never write to the live listmonk list (the Turnstile widget does
not list the staging hostname either). The tests hold it to its name, its one hostname and its empty
`vars`, so a staging block can never claim a production domain. The first deploy attaches the custom
domain (DNS record and certificate) the same way the production cutover did. The pages' canonical
links point at production, so search engines treat staging as a copy.

### CI

`.github/workflows/test.yml` runs `npm test` on every pull request and on pushes to `main`, on
GitHub Actions, with `contents: read` and no secrets. The actions are pinned to commit SHAs and the
Node version comes from the same `.node-version`. It is the pull-request signal; the deploy gate is
the Workers Builds build command above.

### Source history

The canonical repository is on Nostr (NIP-34), maintained by the SovTech key and hosted on the
GRASP servers `git.sovit.xyz` and `git.buildinelsalvador.com`:

```sh
git clone nostr://npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx/git.sovit.xyz/renaissance-rodeo
```

Patches and issues go there (`ngit send`, `ngit issue create`). GitHub is the deploy mirror, because
Workers Builds only watches GitHub: changes are squash-merged into GitHub `main`, which deploys,
and that exact commit is then published to the Nostr `main`, signed by the SovTech key. Nothing
else is ever pushed to Nostr, so the signed Nostr `main` is the record of what was released.

The site was first built in a private self-hosted GitLab project (merge request !1 built the site,
!2 cut the domain over). GitHub took over on 2026-09-21, and the GitLab project is archived.

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
3. One real signup lands in the listmonk list (check the count, not the address).
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
  when siteverify says `success:false`; 503 when `LISTMONK_API_TOKEN` or `LISTMONK_WORKER_HEADER`
  is unset or empty, or `LISTMONK_LIST_ID` is unset or malformed (zero, a leading zero, whitespace,
  a number); 503 on listmonk 401, 403, 404, 429, 500 or a thrown `fetch`; 405 on `GET`; 403
  cross-origin; 400 on a bad email after Turnstile passes;
- **the request shape**: the happy path makes exactly one POST to
  `news.renaissance.rodeo/api/subscribers` with the email lowercased, `lists: [2]` as a number,
  `status: "enabled"`, `attribs.lang` `es` or `en`, no `preconfirm_subscriptions`, no `name`, no `@`
  in the URL, the `x-rodeo-worker` header and `Authorization: token rodeo-worker:…`;
- **no membership oracle**: a listmonk 200 (new), 409 (existing), 400 and 422 (refused upstream)
  produce byte-identical bodies; on a refusal the upstream body is never read and only the status is
  logged; the honeypot (`rr_ref`) returns 200 with zero outbound calls;
- **CSP equality**: the `content-security-policy` on a Worker response equals the line in
  `public/_headers` (read by `vitest.config.mjs` and passed in as `TEST_HEADERS_CSP`);
- **configuration**: `vitest.config.mjs` reads `wrangler.jsonc` with wrangler's own config reader
  (`unstable_readConfig`, so comments are handled) and passes the result in as `TEST_WRANGLER_*`
  bindings; the tests assert that `vars` contains none of `DEV_MODE`, `TURNSTILE_SECRET`,
  `LISTMONK_API_TOKEN`, `LISTMONK_WORKER_HEADER`; that `LISTMONK_LIST_ID` is present and a string
  matching `LIST_ID_RE`; and that non-empty `routes` implies `workers_dev: false`;
- **static**: `/` is `lang="en"`, `/es/` is `lang="es"`, both carry the X and Instagram links,
  `twitter:site` and the share bar (and "No spam" under the input), an unknown path returns the 404 page;
- **navigation, tickets, sponsors**: the four new pages are served in their language with the
  site CSP and redirect their other spellings; every page carries the same page links in the
  header and the footer, marking only itself; every page has one popover nav holding the links
  and icons, and one menu button pointing at it, before the language switch; every subpage header opens with the mark and its
  language switch leads to the same page; every outbound link on every page is `https` +
  `noopener`; the Turnstile sitekey is on exactly the four signup pages, identical, and never a
  test key; the tickets pages tell Bitcoin Histórico ticket holders the rodeo is included, then
  show the prices and the one Buy link, the DUI notice, and repeat the home signup form and strings; the home date lockup is
  two lines under the logo; every page names the place in its footer and its copy as buttons opening
  one venue map popover (Google Maps, Apple Maps, Waze); the sponsors pages repeat
  the partner row; the sitemap lists all eight pages;
- **about**: `/about` and `/es/about` are served in their language with the site CSP, `/about/` and
  `/about.html` redirect to `/about`, every spelling of the old `/team` addresses answers 301 to
  `#team`, the two files list the same names and links in the same order, each square holds the
  photo or the name's initials, every outbound link is `https` + `noopener`, every X icon is
  labelled, the header opens with the bull-and-rider mark linking home in the page's language,
  neither page loads a script, the jump links point at `#event`, `#team` and `#sponsors` in page
  order, the event section holds the three paragraphs including the home page's line, the sponsors
  section repeats the home partner row, and both home pages and the sitemap link them;
- **home**: the About section is the sentence, the `[poster | list]` row and the link to `/about`, in
  that order, and the hero carries the Buy tickets button to the shop and no thumbnail; there is no
  opening sequence (no `intro.js`, overlay or replay button, and `/intro.js` is a 404);
- **activities**: twelve items, identical on the home and about pages per language, in sentence case;
- **main sponsors**: `ul.partners` lists `bitcoinhistorico.com`, `clubcocal.com`, `origenganadero.com` then
  `bitpokersv.com` (classes `bh`, `cc`, `og`, `bp`) identically on the home, about and sponsors pages, Club
  Cocal as its emblem with the name typed in the caption, and `/img/clubcocal.png` served as PNG;
- **sponsor tier 2**: the same `ul.partners.tier-2` right after the partner row on the home, about
  and sponsors pages, linking `tbhs.sv`, `bitdriver.taxi` then `beefbackbetter.com`, and the three logos served as PNG;
- **staging**: `env.staging` is `renaissance-rodeo-staging` on `staging.renaissance.rodeo` only,
  `workers_dev` off, with no `vars` and no rate limiter.

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
address to `rodeo@sovit.xyz`. A destination must be verified by clicking
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

**One SPF record.** The apex must carry exactly one `v=spf1` TXT record. Cloudflare's
`include:_spf.mx.cloudflare.net` covers Email Routing, which rewrites the envelope sender of
forwarded mail to `renaissance.rodeo`; whatever sends the listmonk campaigns as
`@renaissance.rodeo` goes into the **same** record. A second `v=spf1` record makes SPF fail for
every sender. Check for a single `v=spf1` after any change with `dig +short TXT renaissance.rodeo`.
The previous newsletter provider's `include:_spf.mlsend.com` and its `litesrv._domainkey` DKIM CNAME
are no longer needed now that campaigns go through listmonk, and can be removed.

DKIM: `cf2024-1._domainkey` for Cloudflare, added from *Email → Email Routing → Settings*. There is
no DMARC record yet. When campaign sending starts, add `_dmarc` TXT
`v=DMARC1; p=none; rua=mailto:dmarc@renaissance.rodeo`, and the reports arrive through the
catch-all.

## Cutover record

- `2026-09-21` — smoke deploy of `renaissance-rodeo` on
  `renaissance-rodeo.bitcoin-rodeo.workers.dev` verified (pages, `/es` → 307, 404, headers, every
  API gate; signups fail closed with `unavailable` because no secret is set yet).
- `2026-09-21` — domains `renaissance.rodeo` + `www` moved from Worker `bitcoin-rodeo` to
  `renaissance-rodeo`; workers.dev hostname switched off. Signups stay `unavailable` until
  `TURNSTILE_SECRET`, the list credentials and the list id exist and the real sitekey replaces the
  test one.
- `2026-09-22` — Turnstile widget `renaissance-rodeo-signup` created from the terminal, real sitekey
  in both pages, `TURNSTILE_SECRET` set (Bitwarden copy first).
- `2026-09-22` — the first newsletter provider's lists, ids and key set (Bitwarden copy first).
  Every signup prerequisite exists.
- `2026-09-21` — old Worker `bitcoin-rodeo` and its D1 `rodeo-list` (0 subscribers) deleted. There
  is no second Worker to fall back to any more: roll back with `npx wrangler rollback` to an earlier
  version of `renaissance-rodeo`.
- **Pending:** delete the old private GitHub repository `SovereignTechnology/bitcoin-rodeo` (needs a
  `gh` token with the `delete_repo` scope). A local checkout keeps its full history.

## Still browser-only

Nothing here is automated; each is a few minutes in a dashboard.

- **Old newsletter DNS records** — remove the previous provider's SPF include and DKIM CNAME from
  the `renaissance.rodeo` zone (see *Email*).
- **Workers Builds connection** — once, see *Deploying*. Until it exists, `main` is deployed by hand.
- **SPF merge and Cloudflare DKIM** for Email Routing — see *Email*.
