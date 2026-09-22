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

The wordmark is set in Dust West, which is licensed for personal use only — it lives here as
images and is never installed or converted. Headings on the site use Bevan (OFL).

When better exports arrive (uncompressed PNG, or ideally SVG), drop them in under the same names.
An SVG source may replace a PNG of the same stem; the build script prefers `.svg` when present.
