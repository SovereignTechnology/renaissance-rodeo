#!/usr/bin/env bash
set +x   # first thing, before any line that could hold the key: `bash -x` would print it
# scripts/mailerlite-groups.sh — list the MailerLite groups (id + name) for the account
# whose API key sits in the 0600 file given as $1, so the group id can go into
# wrangler.jsonc without the key ever being pasted into a terminal or a transcript.
#
# Usage: scripts/mailerlite-groups.sh /path/to/0600/keyfile
#
# The key file is created WITHOUT the value ever touching a command line
# (README, "MailerLite"):
#   umask 077; IFS= read -rs -p 'MailerLite API key: ' k && printf %s "$k" > ~/.rr-mailerlite; unset k
# and, once the group id is known, the same file is handed to
#   scripts/set-secret.sh MAILERLITE_API_KEY --from-file ~/.rr-mailerlite
# which stores it in Bitwarden, pushes it into the Worker and removes the file.
#
# Output: one line per group, "<id>\t<name>", nothing else. Never prints the key, never
# requests subscriber data (only GET /api/groups). On any non-200 answer it prints the
# HTTP status code alone (never the body) and exits 1.
set -euo pipefail
umask 077

usage()  { printf 'usage: %s <0600 file holding the MailerLite API key>\n' "$0" >&2; exit 64; }
refuse() { printf 'refusing: %s\n' "$*" >&2; exit 77; }

f="${1:-}"
[ -n "$f" ] || usage
# -L before -f: `[ -f ]` follows symlinks, and the old message ("mode 777") misled.
[ ! -L "$f" ] || refuse "$f is a symlink — pass the real file, not a link to it"
[ -f "$f" ] || refuse "$f is not a regular file"
mode=$(stat -c %a -- "$f")
[ "$mode" = 600 ] || refuse "$f has mode $mode, must be 0600 (chmod 600 \"$f\")"
[ "$(stat -c %u -- "$f")" = "$(id -u)" ] || refuse "$f is not owned by the current user"
# A writer in the parent directory could swap the file between these checks and the read
# (rename is not blocked by the file's own 0600), so the directory must be private too.
# -L on the directory: what matters is the real directory's mode, not a link's 777.
dir=$(dirname -- "$f"); dmode=$(stat -L -c %a -- "$dir")
[ $(( 8#$dmode & 8#022 )) -eq 0 ] || refuse "$dir has mode $dmode (group- or other-writable) — keep the key file in a private directory such as \$HOME"

# The key lives in a shell variable (not exported, so absent from every child's
# environment) and reaches curl through a header file on a pipe (-H @/dev/fd/N),
# so it never appears in argv or on disk beyond the file the caller made.
key=$(head -c 8192 -- "$f" | tr -d '\r\n')
[ -n "$key" ] || refuse "$f is empty"
case "$key" in *[[:space:]]*) refuse "key contains whitespace — the file must hold the key alone" ;; esac

command -v curl    >/dev/null || { echo "curl not found" >&2; exit 69; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 69; }

body=$(mktemp); meta=$(mktemp)       # both 0600 under umask 077
trap 'rm -f "$body" "$meta"' EXIT

page=1
while :; do
  # -q MUST be the first argument: only there does it stop curl reading ~/.curlrc
  # ($CURL_HOME/.curlrc, $XDG_CONFIG_HOME/curlrc), where a `verbose` or `trace-ascii`
  # left over from debugging would print the Authorization header — key included.
  code=$(curl -q -sS --proto '=https' --max-time 30 -o "$body" -w '%{http_code}' \
           -H @<(printf 'Authorization: Bearer %s\n' "$key") \
           -H 'Accept: application/json' \
           "https://connect.mailerlite.com/api/groups?limit=100&page=$page") || true
  if [ "${code:-000}" != 200 ]; then printf '%s\n' "${code:-000}"; exit 1; fi

  # Print only id and name (non-printable characters in a name become '?'); note the page count.
  python3 - "$body" "$meta" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for g in d.get("data", []):
    name = "".join(ch if ch.isprintable() else "?" for ch in str(g.get("name", "")))
    print(f"{g.get('id', '')}\t{name}")
open(sys.argv[2], "w").write(str(int(d.get("meta", {}).get("last_page", 1))))
PY
  last=$(cat "$meta")
  [ "$page" -lt "$last" ] && [ "$page" -lt 50 ] || break
  page=$((page + 1))
done
