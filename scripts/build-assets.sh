#!/usr/bin/env bash
# scripts/build-assets.sh — derive every web image from brand/.
#
#   npm run assets                 build everything, then verify, then print the size table
#   scripts/build-assets.sh check  verify the files already under public/ (no rebuild, no network)
#   scripts/build-assets.sh preview  render eyeballing previews into .scratch/previews/ (after a build)
#
# Reads ONLY from brand/ (plus one build-time font download into .scratch/).
# Writes ONLY public/img/* and public/favicon.ico — and only AFTER every output has been
# built into .scratch/assets/out/ and verified there, so a bad brand file can never leave
# public/ half-updated. Idempotent: outputs are byte-reproducible for the same inputs
# (every PNG is -strip'ped).
#
# Every SVG read from brand/ passes svg_gate() (no scripts, handlers, entities, external
# references) BEFORE ImageMagick parses it: the build host is the attack surface there.
#
# Sources are looked up by stem: brand/<stem>.svg is preferred over brand/<stem>.png
# when both exist (the README promises an SVG may replace a PNG under the same name).
# Nothing is ever upscaled: the build fails if a source is smaller than its target.
#
# Every re-inked output is asserted to hold exactly ONE opaque colour (the ink) with
# alpha intact; every icon is asserted to be fully opaque; every output is asserted to
# have the exact pixel size the HTML declares. Any mismatch fails loudly.
set -euo pipefail

# ---------------------------------------------------------------- configuration
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
BRAND="$ROOT/brand"
PUBLIC="$ROOT/public"
IMG="$PUBLIC/img"
SCRATCH="$ROOT/.scratch/assets"       # gitignored; never under public/
OUT="$SCRATCH/out"                     # staging: builders write here, verify() runs here, THEN files move to public/
OUT_IMG="$OUT/img"

INK='#0e1d2d'                          # --ink: the only colour any transparent asset carries
ICON_BG='#fcd9aa'                      # poster cream: favicons + OG canvases only (opaque)
OG_STROKE_PX=15                        # Origen Ganadero monogram stroke. Source is 7px (≈1.4 px at 152 px: a hairline).
                                       # Eyeballed 2026-09-21 at x152/x136 (`preview` mode): 13 was solid but visibly lighter
                                       # than the wordmark at x136; 15 balances the two. Never past 16.
OG_VIEWBOX='130 118 740 760'           # tight box around the mark + wordmark (content bbox 717×736 at +142+131)

WEBP_LOSSLESS_MAX=$((120 * 1024))      # logo.webp: lossless unless bigger than this, then -q 90

# Bevan (OFL) is used for the two text lines on the OG images. Downloaded at build time
# into .scratch/, never shipped. The hash pins the exact upstream file so a silent
# upstream change cannot alter the images — update BEVAN_SHA256 deliberately if it does.
BEVAN_URL='https://github.com/google/fonts/raw/main/ofl/bevan/Bevan-Regular.ttf'
BEVAN_SHA256='8d16c0920330f1def84e342ce70626c27fbf179b4294e6391b19301ff5873469'
BEVAN_TTF="$SCRATCH/Bevan-Regular.ttf"

OG_LINE1_EN='13 NOVEMBER 2026'
OG_LINE1_ES='13 DE NOVIEMBRE DE 2026'
OG_LINE2='ILOPANGO, EL SALVADOR'

# Expected output geometry. These numbers are ALSO written into the two HTML files
# (width/height attributes) — if a replacement brand file changes an aspect ratio the
# build stops here on purpose, so the HTML gets updated in the same commit.
declare -A EXPECT=(
  [logo.png]=1200x591
  [logo.webp]=1200x591
  [mark.png]=144x144
  [favicon-32.png]=32x32
  [apple-touch-icon.png]=180x180
  [icon-192.png]=192x192
  [icon-512.png]=512x512
  [og-en.png]=1200x630
  [og-es.png]=1200x630
  [origen-ganadero.svg]=740x760
  [bitcoin-historico.png]=251x288
)
# Favicon family: output name → canvas size → bull size (bull centred on an opaque cream square)
ICONS='favicon-32.png:32:24 apple-touch-icon.png:180:136 icon-192.png:192:144 icon-512.png:512:352'

# ---------------------------------------------------------------- helpers
log()  { printf '%s\n' "$*"; }
die()  { printf 'build-assets: ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }

# Prefer an SVG source over a PNG of the same stem.
src_for() {                          # src_for <stem-relative-to-brand>  → prints path
  local stem="$1"
  if   [ -f "$BRAND/$stem.svg" ]; then printf '%s' "$BRAND/$stem.svg"
  elif [ -f "$BRAND/$stem.png" ]; then printf '%s' "$BRAND/$stem.png"
  else die "no source for brand/$stem.{svg,png}"
  fi
}

# Generic gate for EVERY SVG this script opens — designer sources (prepare() rasterises any
# brand/<stem>.svg the README invites) and the partner mark alike — run BEFORE convert sees
# the file. ImageMagick's MSVG/XML path (entity expansion, external references) is the build
# host's attack surface; the served partner SVG is the site's. Deny-list on the raw bytes,
# case-insensitive, so nothing depends on how a parser would read it. The partner-source
# gate and verify() layer their structural checks (colours, classes, viewBox) on top.
svg_gate() {                         # svg_gate <file.svg>
  local f="$1" n; n=$(basename "$f")
  [ ! -L "$f" ] && [ -f "$f" ] || die "svg gate: $n is not a regular file"
  ! grep -qiE '<!' "$f" || die "svg gate: $n contains '<!' (DOCTYPE/ENTITY/comment/CDATA are all refused)"
  ! grep -qiE '<(script|image|foreignObject|use|a|set|animate[a-z]*|iframe|embed|object|handler|listener)\b' "$f" \
    || die "svg gate: $n contains a forbidden element (script/image/foreignObject/use/a/set/animate*/iframe/embed/object/handler/listener)"
  ! grep -qiE '[[:space:]]on[a-z]+[[:space:]]*=' "$f" || die "svg gate: $n carries an on*= event-handler attribute"
  ! grep -qiE 'javascript:' "$f" || die "svg gate: $n contains 'javascript:'"
  ! grep -qiE 'href|xlink' "$f" || die "svg gate: $n contains href/xlink (no references, internal or external — not even the xmlns:xlink declaration)"
  ! grep -qiE 'url\(|@import|<\?xml-stylesheet' "$f" || die "svg gate: $n contains url()/@import/xml-stylesheet"
  [ "$(grep -ci '<svg' "$f")" = 1 ] || die "svg gate: $n: expected exactly one <svg> element"
}

# Turn a source into a trimmed, transparent, 8-bit raster in scratch (SVG gets rasterised
# at high density so every later step is a downscale). Prints the scratch path.
prepare() {                          # prepare <stem> [trim]
  local stem="$1" trim="${2:-trim}" src out
  src=$(src_for "$stem")
  out="$SCRATCH/$(basename "$stem").prepared.png"
  local trimarg=()
  [ "$trim" = trim ] && trimarg=(-trim +repage)
  case "$src" in
    *.svg) svg_gate "$src"
           convert -background none -density 384 "$src" "${trimarg[@]}" -strip -depth 8 PNG32:"$out" ;;
    *)     convert "$src" "${trimarg[@]}" -strip -depth 8 PNG32:"$out" ;;
  esac
  [ "$(identify -format '%[opaque]' "$out")" = false ] || die "$src has no transparency — brand sources must be transparent"
  printf '%s' "$out"
}

# A re-inked PNG holds ONE colour × ≤256 alpha levels, which is exactly a palette PNG with a
# tRNS chunk (index = alpha). Rewrite it that way — lossless by construction, verified
# byte-for-byte on the RGBA pixels before the file is replaced — for ~40 % fewer bytes.
# ImageMagick's own PNG8 writer is NOT used: it collapses alpha to 1 bit.
palettise_ink() {                    # palettise_ink <file.png>
  python3 - "$1" "$INK" <<'PY' || die "palettise_ink failed on $(basename "$1")"
import sys
from PIL import Image, ImageChops
path, ink = sys.argv[1], sys.argv[2].lstrip('#')
rgb = bytes.fromhex(ink)
src = Image.open(path).convert('RGBA')
pal = Image.new('P', src.size)
pal.putdata(list(src.getchannel('A').getdata()))
pal.putpalette(rgb * 256)
out = path + '.pal'
pal.save(out, format='PNG', optimize=True, transparency=bytes(range(256)))
back = Image.open(out).convert('RGBA')
if back.size != src.size or ImageChops.difference(back, src).getbbox() is not None:
    sys.exit('palette rewrite is not pixel-identical')
import os; os.replace(out, path)
PY
}

dims()      { identify -format '%wx%h' "$1"; }
no_upscale() {                       # no_upscale <file> <needed-w> <needed-h>
  local w h; IFS=x read -r w h <<< "$(dims "$1")"
  [ "$w" -ge "$2" ] && [ "$h" -ge "$3" ] || die "$(basename "$1") is ${w}x${h}; target needs ${2}x${3} — refusing to upscale (ask the designer for a larger export or an SVG)"
}

# Assertions ------------------------------------------------------------------
assert_dims() {                      # assert_dims <file> <WxH>
  local got; got=$(dims "$1")
  [ "$got" = "$2" ] || die "$(basename "$1") is $got, expected $2 (update the width/height attributes in both HTML files if the brand source changed shape)"
}
assert_ink() {                       # exactly one opaque colour == INK, alpha survived
  local f="$1" k hex
  k=$(convert "$f" -alpha off -unique-colors -format '%k' info:)
  [ "$k" = 1 ] || die "$(basename "$f") carries $k colours, expected exactly 1"
  hex=$(convert "$f" -alpha off -unique-colors -format '%[hex:p{0,0}]' info: | tr 'A-F' 'a-f')
  [ "#$hex" = "$INK" ] || die "$(basename "$f") colour is #$hex, expected $INK"
  [ "$(identify -format '%[opaque]' "$f")" = false ] || die "$(basename "$f") lost its alpha channel"
}
assert_opaque() {
  [ "$(identify -format '%[opaque]' "$1")" = true ] || die "$(basename "$1") must be fully opaque"
}
assert_png8_max_colors() {           # assert_png8_max_colors <file> <max>
  local k r
  k=$(identify -format '%k' "$1"); r=$(identify -format '%r' "$1")
  [ "$k" -le "$2" ] || die "$(basename "$1") has $k colours, expected ≤ $2"
  case "$r" in *PseudoClass*) ;; *) die "$(basename "$1") is not palette (PNG8): $r" ;; esac
}

# ---------------------------------------------------------------- font download
fetch_bevan() {
  if [ -f "$BEVAN_TTF" ] && printf '%s  %s\n' "$BEVAN_SHA256" "$BEVAN_TTF" | sha256sum -c --quiet - 2>/dev/null; then
    return
  fi
  log "downloading Bevan-Regular.ttf (build-time only, not shipped)"
  curl -fsSL --max-time 120 --retry 3 -o "$BEVAN_TTF.part" "$BEVAN_URL" || die "could not download $BEVAN_URL"
  printf '%s  %s\n' "$BEVAN_SHA256" "$BEVAN_TTF.part" | sha256sum -c --quiet - \
    || die "Bevan-Regular.ttf digest mismatch — upstream changed; inspect it, then update BEVAN_SHA256"
  mv -f "$BEVAN_TTF.part" "$BEVAN_TTF"
}

# ---------------------------------------------------------------- builders
build_logo() {
  local src; src=$(prepare logo-stacked-black)
  no_upscale "$src" 1200 1
  convert "$src" -resize 1200x -fill "$INK" -colorize 100 -strip -depth 8 PNG32:"$OUT_IMG/logo.png"
  palettise_ink "$OUT_IMG/logo.png"
  assert_ink "$OUT_IMG/logo.png"

  cwebp -quiet -lossless -z 9 -exact -metadata none "$OUT_IMG/logo.png" -o "$OUT_IMG/logo.webp"
  if [ "$(stat -c %s "$OUT_IMG/logo.webp")" -gt "$WEBP_LOSSLESS_MAX" ]; then
    log "logo.webp lossless is > $((WEBP_LOSSLESS_MAX / 1024)) KB — falling back to -q 90 -alpha_q 100"
    cwebp -quiet -q 90 -alpha_q 100 -metadata none "$OUT_IMG/logo.png" -o "$OUT_IMG/logo.webp"
  fi
}

build_mark() {
  local src w h side; src=$(prepare bull-black)
  IFS=x read -r w h <<< "$(dims "$src")"
  side=$(( (w > h ? w : h) + 2 ))     # pad the trimmed bull to a square, 1 px breathing room each side
  no_upscale "$src" 1 144
  convert "$src" -background none -gravity center -extent "${side}x${side}" \
          -resize 144x144 -fill "$INK" -colorize 100 -strip -depth 8 PNG32:"$OUT_IMG/mark.png"
  palettise_ink "$OUT_IMG/mark.png"
  assert_ink "$OUT_IMG/mark.png"
}

build_icons() {
  local src spec name canvas bull; src=$(prepare bull-black)
  for spec in $ICONS; do
    IFS=: read -r name canvas bull <<< "$spec"
    no_upscale "$src" 1 "$bull"
    # bull resized to fit bull×bull, re-inked, centred on an OPAQUE cream square (reads on dark tab strips)
    convert "$src" -resize "${bull}x${bull}" -fill "$INK" -colorize 100 \
            -background "$ICON_BG" -gravity center -extent "${canvas}x${canvas}" \
            -alpha remove -alpha off -strip -depth 8 PNG24:"$OUT_IMG/$name"
    assert_opaque "$OUT_IMG/$name"
  done
  convert "$OUT_IMG/favicon-32.png" -define icon:auto-resize=32,16 "$OUT/favicon.ico"
}

build_og() {
  fetch_bevan
  local lang line1
  for lang in en es; do
    if [ "$lang" = en ]; then line1=$OG_LINE1_EN; else line1=$OG_LINE1_ES; fi
    # cream canvas → logo 720 wide near the top → two Bevan lines near the bottom → PNG8 (64 colours)
    convert -size 1200x630 "xc:$ICON_BG" \
      \( "$OUT_IMG/logo.png" -resize 720x \) -gravity North -geometry +0+58 -composite \
      -font "$BEVAN_TTF" -fill "$INK" -pointsize 50 -kerning 1 -gravity North \
      -annotate +0+446 "$line1" -annotate +0+522 "$OG_LINE2" \
      +dither -colors 64 -strip PNG8:"$OUT_IMG/og-$lang.png"
    assert_opaque "$OUT_IMG/og-$lang.png"
    assert_png8_max_colors "$OUT_IMG/og-$lang.png" 64
  done
}

build_origen_ganadero() {
  local src="$BRAND/partners/origen-ganadero.svg" out="$OUT_IMG/origen-ganadero.svg" colours
  [ -f "$src" ] || die "missing $src"

  # --- safety gate on the SOURCE: one flat colour, no external/active content. Active-content
  # patterns are listed here AND in svg_gate() on purpose: this gate is the contract for the
  # served file, the generic one is the contract for anything ImageMagick opens.
  colours=$(grep -oiE '#[0-9a-f]{3,8}\b' "$src" | tr 'A-F' 'a-f' | sort -u || true)   # || true: an empty result must reach die, not exit under pipefail
  [ "$colours" = '#f2e8d5' ] || die "origen-ganadero.svg colours are [$(printf '%s' "$colours" | tr '\n' ' ')], expected exactly #F2E8D5"
  ! grep -qiE 'rgba?\(|hsla?\(' "$src" || die "origen-ganadero.svg uses rgb()/hsl() colours"
  ! grep -qiE '<(image|script|text|foreignObject|use|filter|animate|set|a)\b' "$src" || die "origen-ganadero.svg contains a forbidden element (image/script/text/foreignObject/use/filter/animate/set/a)"
  ! grep -qiE 'gradient|url\(|href|xlink|<!|@import' "$src" || die "origen-ganadero.svg contains gradient/url()/href/xlink/'<!' (DOCTYPE/ENTITY/comment)/@import"
  ! grep -qiE '[[:space:]]on[a-z]+[[:space:]]*=|javascript:' "$src" || die "origen-ganadero.svg contains an on*= event handler or 'javascript:'"
  [ "$(grep -c '<svg' "$src")" = 1 ] || die "origen-ganadero.svg: expected exactly one <svg> element"
  svg_gate "$src"
  # The attribute mapping below relies on the source's two-class contract: cls-1 = the two
  # stroked monogram paths (fill:none, stroke-width:7px, miterlimit 10), cls-2 = the two
  # filled wordmark paths, both evenodd, all declared in ONE <style> block inside <defs>.
  [ "$(grep -o 'class="[^"]*"' "$src" | sort | uniq -c | awk '{print $1, $2}' | paste -sd';')" = '2 class="cls-1";2 class="cls-2"' ] \
    || die "origen-ganadero.svg: expected exactly two class=\"cls-1\" paths and two class=\"cls-2\" paths and no other classes"
  [ "$(grep -c '<style' "$src")" = 1 ] && [ "$(grep -c '<defs' "$src")" = 1 ] || die "origen-ganadero.svg: expected exactly one <defs><style> block"
  [ "$(grep -cE 'stroke-width:[[:space:]]*7px' "$src")" = 1 ] || die "origen-ganadero.svg: expected exactly one 'stroke-width: 7px' rule"
  [ "$(grep -cE 'fill:[[:space:]]*none' "$src")" = 1 ] || die "origen-ganadero.svg: expected exactly one 'fill: none' rule"
  [ "$(grep -cE 'stroke-miterlimit:[[:space:]]*10\b' "$src")" = 1 ] || die "origen-ganadero.svg: expected exactly one 'stroke-miterlimit: 10' rule"
  [ "$(grep -cE 'fill-rule:[[:space:]]*evenodd' "$src")" = 1 ] || die "origen-ganadero.svg: expected exactly one 'fill-rule: evenodd' rule"

  # --- transform: drop the <defs><style> block and express the two classes as presentation
  # attributes (re-inked, monogram stroke widened), so the file needs NO CSS to render.
  # public/_headers stamps the page CSP on /img/* too; once 'unsafe-inline' leaves style-src a
  # direct hit on the SVG URL would lose its <style> block and render as filled black blobs.
  # (Embedded via <img> it was never affected — this is about the bare URL.) Also drop the xml
  # header / ids / width / height and set the tight viewBox.
  sed -E \
    -e 's/<\?xml[^>]*\?>//' \
    -e '/<defs>/,/<\/defs>/d' \
    -e 's/ class="cls-1"/ fill="none" stroke="'"$INK"'" stroke-miterlimit="10" stroke-width="'"$OG_STROKE_PX"'" fill-rule="evenodd"/g' \
    -e 's/ class="cls-2"/ fill="'"$INK"'" fill-rule="evenodd"/g' \
    -e 's/#F2E8D5/'"$INK"'/gI' \
    -e 's/ (id|data-name)="[^"]*"//g' \
    -e '/<svg\b/{ s/ (width|height)="[^"]*"//g; s/ viewBox="[^"]*"/ viewBox="'"$OG_VIEWBOX"'"/; }' \
    "$src" | sed -e '/./,$!d' > "$out"          # sed #2 drops the blank line the header left

  # --- assertions on the OUTPUT
  colours=$(grep -oiE '#[0-9a-f]{3,8}\b' "$out" | tr 'A-F' 'a-f' | sort -u || true)
  [ "$colours" = "$INK" ] || die "origen-ganadero.svg output colours are [$(printf '%s' "$colours" | tr '\n' ' ')], expected exactly $INK"
  grep -q "viewBox=\"$OG_VIEWBOX\"" "$out" || die "origen-ganadero.svg output lacks viewBox=\"$OG_VIEWBOX\""
  [ "$(grep -c "stroke-width=\"${OG_STROKE_PX}\"" "$out")" = 2 ] || die "origen-ganadero.svg: expected stroke-width=\"${OG_STROKE_PX}\" on exactly two paths"
  [ "$(grep -c 'fill="none"' "$out")" = 2 ] && [ "$(grep -c "fill=\"$INK\"" "$out")" = 2 ] || die "origen-ganadero.svg: expected two stroked (fill=none) and two filled ($INK) paths"
  ! grep -qE '<style|<defs|class=|[[:space:]]style=' "$out" || die "origen-ganadero.svg output still carries <style>/<defs>/class=/style= — it must render with no CSS at all (the page CSP applies to a direct hit on the SVG URL)"
  ! grep -qE '<\?xml| id=| data-name=' "$out" || die "origen-ganadero.svg output still carries xml header / id / data-name"
  ! grep -qE '<svg[^>]* (width|height)=' "$out" || die "origen-ganadero.svg output root still carries width/height"
  head -c 5 "$out" | grep -q '^<svg' || die "origen-ganadero.svg output does not start with <svg"
  svg_gate "$out"
}

build_bitcoin_historico() {
  local src; src=$(prepare partners/bitcoin-historico-white notrim)
  no_upscale "$src" 1 288
  convert "$src" -resize x288 -fill "$INK" -colorize 100 -strip -depth 8 PNG32:"$OUT_IMG/bitcoin-historico.png"
  palettise_ink "$OUT_IMG/bitcoin-historico.png"
  assert_ink "$OUT_IMG/bitcoin-historico.png"
}

# ---------------------------------------------------------------- verify (also `check` mode)
# verify <dir> — <dir> holds img/* and favicon.ico: the staging dir during a build (nothing
# reaches public/ until this passes there), public/ itself for `check` and after promotion.
verify() {
  local root="${1:?verify needs a directory}" img name f
  img="$root/img"
  for name in "${!EXPECT[@]}"; do
    f="$img/$name"; [ -s "$f" ] || die "missing output $f (run: npm run assets)"
    assert_dims "$f" "${EXPECT[$name]}"
  done
  for f in logo.png mark.png bitcoin-historico.png; do assert_ink "$img/$f"; done
  for f in favicon-32.png apple-touch-icon.png icon-192.png icon-512.png og-en.png og-es.png; do assert_opaque "$img/$f"; done
  assert_png8_max_colors "$img/og-en.png" 64
  assert_png8_max_colors "$img/og-es.png" 64
  [ "$(identify -format '%[opaque]' "$img/logo.webp")" = false ] || die "logo.webp lost its alpha"
  [ "$(stat -c %s "$img/logo.webp")" -le "$((200 * 1024))" ] || die "logo.webp is unexpectedly large"

  [ -s "$root/favicon.ico" ] || die "missing $root/favicon.ico"
  [ "$(identify -format '%wx%h\n' "$root/favicon.ico" | paste -sd,)" = "32x32,16x16" ] || die "favicon.ico must hold exactly a 32×32 and a 16×16 frame"

  local svg="$img/origen-ganadero.svg" colours
  svg_gate "$svg"
  colours=$(grep -oiE '#[0-9a-f]{3,8}\b' "$svg" | tr 'A-F' 'a-f' | sort -u || true)
  [ "$colours" = "$INK" ] || die "origen-ganadero.svg colours are [$colours], expected $INK"
  grep -q "viewBox=\"$OG_VIEWBOX\"" "$svg" || die "origen-ganadero.svg viewBox drifted"
  ! grep -qiE '<(image|script|text|foreignObject|use|filter|animate|set|a)\b|gradient|url\(|href|xlink|<!|[[:space:]]on[a-z]+[[:space:]]*=|javascript:' "$svg" || die "origen-ganadero.svg carries forbidden content"
  [ "$(grep -c "stroke-width=\"${OG_STROKE_PX}\"" "$svg")" = 2 ] || die "origen-ganadero.svg stroke-width is not ${OG_STROKE_PX} on exactly two paths"
  ! grep -qE '<style|<defs|class=|[[:space:]]style=' "$svg" || die "origen-ganadero.svg carries <style>/<defs>/class=/style= — it must render with no CSS at all (the page CSP applies to a direct hit on the SVG URL)"
  [ "$OG_STROKE_PX" -le 16 ] || die "OG_STROKE_PX=$OG_STROKE_PX exceeds the 16 px ceiling"

  # nothing derived may still reference the interim Signal exports
  if grep -rl 'signal-' "$root" "$PUBLIC" "$BRAND" 2>/dev/null | grep -q .; then die "a file under public/ or brand/ still mentions 'signal-'"; fi
  log "verify: all assertions passed (${root#"$ROOT"/})"
}

# Move the verified staging copies into public/ — one rename per file, nothing until every
# assertion has passed on the copies. Then verify() runs AGAIN on public/: the status the
# build reports is about what is actually in the tree, never about the staging files.
promote() {
  local f
  for f in "$OUT_IMG"/*; do mv -f -- "$f" "$IMG/$(basename "$f")"; done
  mv -f -- "$OUT/favicon.ico" "$PUBLIC/favicon.ico"
}

size_table() {
  local f
  printf '\n%-24s %-10s %9s\n' 'output' 'size' 'bytes'
  printf '%-24s %-10s %9s\n' '------------------------' '----------' '---------'
  for f in "$IMG"/logo.png "$IMG"/logo.webp "$IMG"/mark.png "$IMG"/favicon-32.png "$IMG"/apple-touch-icon.png \
           "$IMG"/icon-192.png "$IMG"/icon-512.png "$PUBLIC"/favicon.ico "$IMG"/og-en.png "$IMG"/og-es.png \
           "$IMG"/origen-ganadero.svg "$IMG"/bitcoin-historico.png; do
    printf '%-24s %-10s %9s\n' "${f#"$PUBLIC"/}" "$(identify -format '%wx%h' "${f}[0]")" "$(stat -c %s "$f")"
  done
  printf '%-24s %-10s %9s\n' 'total' '' "$(cat "$IMG"/* "$PUBLIC"/favicon.ico | wc -c)"
}

# ---------------------------------------------------------------- preview (eyeballing aid)
# Renders what a browser would show, into .scratch/previews/. Uses cairosvg when
# installed (faithful stroke rendering); falls back to ImageMagick's own SVG renderer.
preview() {
  local P="$ROOT/.scratch/previews" cream='#f7edd8' svg="$IMG/origen-ganadero.svg" h
  mkdir -p "$P"
  for h in 152 136; do
    if command -v cairosvg >/dev/null 2>&1; then
      cairosvg "$svg" --output-height "$h" --background "$cream" -o "$P/og-x$h.png"
    else
      convert -background "$cream" -density 96 "$svg" -resize "x$h" "$P/og-x$h.png"
    fi
  done
  convert "$IMG/bitcoin-historico.png" -resize x120 -background "$cream" -flatten "$P/bh-x120.png"
  convert "$IMG/logo.png" -background "$cream" -flatten -resize 600x "$P/logo-on-cream.png"
  convert "$IMG/mark.png" -background "$cream" -flatten -resize 36x36 "$P/mark-36.png"
  # favicon strip at 1×, then the same magnified 4× (nearest-neighbour) so pixel legibility can be judged
  convert "$IMG/favicon-32.png" "$PUBLIC/favicon.ico[1]" "$IMG/apple-touch-icon.png" "$IMG/icon-192.png" \
          -background '#202124' +append "$P/icons-1x.png"
  convert "$IMG/favicon-32.png" "$PUBLIC/favicon.ico[1]" -background '#202124' +append -filter point -resize 400% "$P/favicons-4x.png"
  log "previews written to ${P#"$ROOT"/}/"
}

# ---------------------------------------------------------------- main
main() {
  local mode="${1:-build}"
  need convert; need identify; need cwebp; need curl; need sed; need sha256sum; need python3
  python3 -c 'import PIL' 2>/dev/null || die "python3 cannot import PIL (Pillow)"
  mkdir -p "$SCRATCH" "$IMG"
  case "$mode" in
    build)
      mkdir -p "$OUT_IMG"
      rm -f -- "$OUT_IMG"/* "$OUT/favicon.ico"      # a previous failed build must not pass verify by proxy
      build_logo
      build_mark
      build_icons
      build_og
      build_origen_ganadero
      build_bitcoin_historico
      verify "$OUT"
      promote
      verify "$PUBLIC"
      size_table
      ;;
    check)   verify "$PUBLIC"; size_table ;;
    preview) preview ;;
    *) die "usage: $0 [build|check|preview]" ;;
  esac
}
main "$@"
