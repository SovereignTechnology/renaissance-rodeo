#!/usr/bin/env bash
set +x   # first thing, before any line that could hold the value: `bash -x` would print it
# scripts/set-secret.sh — put ONE Worker secret into Bitwarden (sovtech/shared, through the
# TPM broker) AND into Cloudflare, with the value never on a command line, never echoed,
# never in shell history, and never left only in Cloudflare (which is write-only).
#
#   scripts/set-secret.sh TURNSTILE_SECRET                          # prompts; what you type is not echoed
#   scripts/set-secret.sh MAILERLITE_API_KEY --from-file ~/.rr-secret.abc123
#
# Steps, each gated on the previous one:
#   1. sudo -n /usr/local/bin/secret-store renaissance-rodeo-<kebab-name> <0600 temp file>
#   2. npx wrangler secret put <NAME> < <temp file>      the Worker must ALREADY exist
#                                                        (`npm run deploy` once, otherwise wrangler fails)
#   3. rm the temp file, and the --from-file source
# On ANY failure: says which step failed, keeps the 0600 temp file, prints its path, exits
# non-zero — the value is never lost (re-run with --from-file <that path>) and never printed.
#
# Why not four separate lines: `printf %s 'value' > file` lands in ~/.bash_history and every
# terminal logger; unchained steps let a failed secret-store + a successful wrangler put +
# shred leave the ONLY copy inside Cloudflare, where nothing can read it back.
set -euo pipefail
umask 077

usage()  { printf 'usage: %s TURNSTILE_SECRET|MAILERLITE_API_KEY [--from-file PATH]\n' "$0" >&2; exit 64; }
refuse() { printf 'set-secret: refusing: %s\n' "$*" >&2; exit 77; }

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

name="${1:-}"; [ -n "$name" ] || usage
case "$name" in                       # allow-list: the item name is derived, never typed
  TURNSTILE_SECRET)   item=renaissance-rodeo-turnstile-secret ;;
  MAILERLITE_API_KEY) item=renaissance-rodeo-mailerlite-api-key ;;
  *) refuse "unknown secret name '$name' (TURNSTILE_SECRET or MAILERLITE_API_KEY)" ;;
esac
shift
src=''
case "$#" in
  0) ;;
  2) [ "$1" = --from-file ] && [ -n "$2" ] || usage; src="$2" ;;
  *) usage ;;
esac

command -v sudo >/dev/null || { echo "set-secret: sudo not found" >&2; exit 69; }
command -v npx  >/dev/null || { echo "set-secret: npx not found (Node + npm, see README)" >&2; exit 69; }
[ -d "${HOME:-/nonexistent}" ] && [ -w "$HOME" ] || refuse "\$HOME is not a writable directory"

# --- obtain the value: from a private file, or typed at a prompt — never an argument
if [ -n "$src" ]; then
  [ ! -L "$src" ] || refuse "$src is a symlink — pass the real file"
  [ -f "$src" ] || refuse "$src is not a regular file"
  mode=$(stat -c %a -- "$src"); [ "$mode" = 600 ] || refuse "$src has mode $mode, must be 0600 (chmod 600 \"$src\")"
  [ "$(stat -c %u -- "$src")" = "$(id -u)" ] || refuse "$src is not owned by you"
  v=$(head -c 65536 -- "$src"; printf x); v=${v%x}        # keep the bytes exactly, then…
  v=${v%$'\n'}; v=${v%$'\r'}                                # …drop ONE trailing newline / CRLF (an editor's)
else
  [ -t 0 ] || refuse "stdin is not a terminal — type the value at the prompt, or use --from-file PATH (never echo/printf a secret on a command line: it lands in shell history)"
  IFS= read -rs -p "$name value (not echoed): " v
  printf '\n' >&2
fi
[ -n "$v" ] || refuse "empty value"
case "$v" in *[[:space:]]*) refuse "value contains whitespace (a stray space or newline in the paste?)" ;; esac

# --- the value touches disk exactly once: a 0600 file in $HOME, from which both stores read it
tmp=''; reported=''
on_exit() {   # only speaks when something exited without reporting (a tool crash under set -e)
  if [ -z "$reported" ] && [ -n "$tmp" ] && [ -e "$tmp" ]; then
    printf 'set-secret: aborted; the value is kept in %s (mode 0600). Re-run: %s %s --from-file %s\n' "$tmp" "$0" "$name" "$tmp" >&2
  fi
}
trap on_exit EXIT
tmp=$(mktemp "$HOME/.rr-secret.XXXXXX")     # 0600: mktemp's own mode, and umask 077 besides
printf '%s' "$v" > "$tmp"                   # printf is a builtin: the value is in no process's argv
unset v

step_failed() {   # step_failed <n> <what>: keep the file, say where it is, exit non-zero
  reported=1
  printf 'set-secret: step %s (%s) FAILED. The value is kept in %s (mode 0600), nothing else was changed by this step. Fix the cause, then re-run:\n  %s %s --from-file %s\n' \
    "$1" "$2" "$tmp" "$0" "$name" "$tmp" >&2
  [ -n "$src" ] && [ "$src" != "$tmp" ] && printf 'set-secret: your source file %s is untouched.\n' "$src" >&2
  exit 1
}

# 1. Bitwarden first: if this fails, nothing has reached Cloudflare and nothing is lost.
if ! sudo -n /usr/local/bin/secret-store "$item" "$tmp"; then
  step_failed 1 "secret-store → Bitwarden sovtech/shared item '$item'; needs sudo -n and an unlocked bw-agent"
fi

# 2. Cloudflare, only now: the copy that survives the laptop already exists.
if ! (cd "$ROOT" && npx wrangler secret put "$name" < "$tmp"); then
  step_failed 2 "wrangler secret put $name — the Worker must already exist (npm run deploy once); Bitwarden already holds '$item', so the re-run just stores it again"
fi

# 3. Both stores hold it: remove the file(s). rm, not shred — on ZFS/btrfs (this laptop, the
# server) shred rewrites a NEW copy-on-write block and the old one stays until reused; and
# ext4 gives no guarantee either. rm is equivalent and honest.
reported=1
rm -f -- "$tmp"
removed="$tmp"
if [ -n "$src" ] && [ -e "$src" ]; then rm -f -- "$src"; removed="$removed and $src"; fi
printf 'set-secret: %s is in Bitwarden (%s) and in Cloudflare. Removed %s (rm — shred is pointless on ZFS/btrfs).\n' "$name" "$item" "$removed"
