# Brand sources

Everything under `public/img/` and `public/favicon.ico` is DERIVED from this directory by
`scripts/build-assets.sh` (`npm run assets`). Never edit the derived files; replace a source here
under the SAME name, re-run the script, and commit both.

| File | What | Origin |
|---|---|---|
| `logo-stacked-black.png` / `-white.png` | stacked wordmark "RENAISSANCE / RODEO" + bull-and-rider, transparent | designer export (interim: Signal-compressed, 1451×800) |
| `logo-square-black.png` / `-white.png` | bull above the stacked wordmark, transparent | designer export (interim, 616×629) |
| `bull-black.png` / `-white.png` | bull-and-rider silhouette only, transparent | designer export (interim, 500×510) |
| `partners/origen-ganadero.svg` | Origen Ganadero mark + wordmark, single colour `#F2E8D5` | https://origenganadero.com/assets/images/logos/og-logo-mix-cream.svg |
| `partners/bitcoin-historico-white.png` | Bitcoin Histórico emblem, white on transparent, 500×574 | bitcoinhistorico.com theme cache |
| `partners/bitcoin-historico-gold-lockup.png` | emblem + wordmark lockup, 400×126 (swap-in if the emblem alone reads thin) | bitcoinhistorico.com theme cache |
| `partners/bitpoker-black.png` | BitPoker SV spade mark, black on transparent, 766×901 | cut out of the club's 1664×928 export, which had a checkerboard *baked into the pixels* (no alpha) — see below |
| `poster.jpg` | the announcement poster, 1080×1920 (9:16) | designer export, 2026-09-21 |

`partners/bitpoker-black.png` was made once from that export (`1790054125.png`) and committed; the
build script only accepts transparent sources, so the cut-out is the source. The recipe, for when a
new export arrives: the mark is pure black and the checker is ≥ gray(231), so alpha is the inverted
luminance with the checker levelled to 0, everything under 3 % zeroed, and a fuzzy trim (the checker
leaves single-pixel specks that defeat an exact one):

```sh
convert 1790054125.png -crop 900x928+400+0 +repage \
  \( +clone -colorspace gray -negate -level 9.5%,100% -black-threshold 3% \) \
  -alpha off -compose CopyOpacity -composite -fill black -colorize 100 \
  -fuzz 1% -trim +repage -strip -depth 8 PNG32:partners/bitpoker-black.png
```

Check it: `identify -format '%[opaque]'` prints `false`, the size is about 766×901 (a width near
1600 means specks survived), and the `preview` build mode renders it on cream.

The wordmark is set in Dust West, which is licensed for personal use only — it lives here as
images and is never installed or converted. Headings on the site use Bevan (OFL).

When better exports arrive (uncompressed PNG, or ideally SVG), drop them in under the same names.
An SVG source may replace a PNG of the same stem; the build script prefers `.svg` when present.
