# Brand sources

Everything under `public/img/` and `public/favicon.ico` is DERIVED from this directory by
`scripts/build-assets.sh` (`npm run assets`). Never edit the derived files; replace a source here
under the SAME name, re-run the script, and commit both.

| File | What | Origin |
|---|---|---|
| `logo-stacked-black.png` / `-white.png` | stacked wordmark "RENAISSANCE / RODEO" + bull-and-rider, transparent | designer export (interim: Signal-compressed, 1451×800) |
| `logo-square-black.png` / `-white.png` | bull above the stacked wordmark, transparent | designer export (interim, 616×629) |
| `bull-black.png` / `-white.png` | bull-and-rider silhouette only, transparent; also `img/bull.png` at full canvas (it was the intro's closing card; kept as a brand asset) | designer export (interim, 500×510) |
| `partners/origen-ganadero.svg` | Origen Ganadero mark + wordmark, single colour `#F2E8D5` | https://origenganadero.com/assets/images/logos/og-logo-mix-cream.svg |
| `partners/bitcoin-historico-white.png` | Bitcoin Histórico emblem, white on transparent, 500×574 | bitcoinhistorico.com theme cache |
| `partners/bitcoin-historico-gold-lockup.png` | emblem + wordmark lockup, 400×126 (swap-in if the emblem alone reads thin) | bitcoinhistorico.com theme cache |
| `partners/bitpoker-black.png` | BitPoker SV spade mark, black on transparent, 766×901 | cut out of the club's 1664×928 export, which had a checkerboard *baked into the pixels* (no alpha) — see below |
| `partners/tbhs.png` | The Bitcoin Hardware Store lockup, blue and orange line art on transparent, 2024×1176 (second sponsor tier) | https://tbhs.sv/images/tbhs_logo_sm.png, as published |
| `partners/bitdriver-black.png` | BitDriver mark + "it-Driver" wordmark, black on transparent, 801×201, its coin's ₿ a knockout (second sponsor tier) | cut out of https://bitdriver.taxi/wp-content/uploads/2024/05/Bit-Driver-v2-PNG-e1733871491349.png (862×228, opaque on black) — see below |
| `partners/beefbackbetter-black.png` | Beef Back Better's seal as a one-colour cut-out, black on transparent, 1038×1080 (third sponsor-tier mark): the disc and the cow head are the mark, the white lettering and band are transparent | cut out of https://assets.zyrosite.com/AwvL7NLxGqUonxQl/logo-mp8XajqZvOCLL0EW.png (1080×1080, RGBA: blue disc, white lettering, orange cow head) — see below |
| `partners/clubcocal.png` | Club Cocal wordmark (the palm sits in its O), two greens on transparent, 1500×250 (main sponsor, second in the top block) | https://images.squarespace-cdn.com/content/v1/67b7b9813a56ba5760d2f7e7/5ec0a635-eacb-46db-950d-ee79c54b1342/CLUB+COCAL+LOGO.png?format=1500w, as published. The site serves WebP under a .png name; the committed file is the lossless PNG (`convert logo.webp -strip -depth 8 PNG32:partners/clubcocal.png`). Its alpha carries every shape, so the build's flat re-ink keeps it whole |
| `poster.jpg` | the announcement poster, 1080×1920 (9:16) | designer export, 2026-09-21 |
| `team/andrea.jpg` | Andrea Hernández Tobar's headshot, 1280×1600 (4:5) | photo, 2026-10-14 |
| `team/tom.jpg` | Tom Taber's headshot, 1284×1600 (4:5) | photo, 2026-10-14 (brighter pick) |
| `team/zack.jpg` | Zack Dorsey's headshot, 792×990 | photo, 2026-10-14 |
| `team/cam.jpg` | Cam's headshot, 814×1106 | photo, 2026-10-14 |
| `team/james.jpg` | James's headshot, 600×600 | cropped from a 1280×852 photo (2026-10-30), framed in the source because the build crops centred: `jpegtran -copy none -perfect -crop 600x600+448+64` (lossless, metadata dropped) |

The `team/` sources are cover-cropped to a 256×256 square (`img/team-<name>.jpg`) by
`build_team()` — a centred crop that keeps the head and hat. Replace a source under the same name
when a better shot arrives; the crop anchor is the source's framing, so re-frame there if needed.

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

`partners/bitdriver-black.png` was made once from BitDriver's site export and committed, for the same
reason. That export is orange and white on solid black: the coin and "Driver" are orange, the coin's
₿ and the "it-" are white. A plain silhouette would fill the ₿ in, so alpha is the orange's chroma
`(r − b) / 170` everywhere, plus the white's luminance `(min(r,g,b) − 20) / 215` **only right of
x = 394** (the coin's orange ends at x = 387, the "i" starts at x = 400), values under 4 % zeroed,
black RGB, cropped to the alpha's bounding box. The ₿ comes out as a clean anti-aliased knockout. In
Python with Pillow, per pixel: `a = max(clamp((r-b)/170), clamp((min(r,g,b)-20)/215) if x >= 394 else 0)`.
Check it: 801×201, `%[opaque]` false, and the `preview` build mode shows the ₿ cut out of the coin.

`partners/beefbackbetter-black.png` was made once from the business's site logo, for the same reason (a flat
re-ink of the original would be a solid disc). Alpha is how dark each pixel is, `1 − min(r,g,b)`, times the
original alpha, levelled so the disc's blue reaches full (0 %–93 %): the blue disc and the orange cow come out
opaque, the white lettering and the white band transparent. Black RGB, trimmed to the alpha's bounding box:

```sh
convert logo.png \( -clone 0 -alpha off -channel RGB -separate +channel -evaluate-sequence min -negate \) \
  \( -clone 0 -alpha extract \) -delete 0 -compose Multiply -composite -level 0%,93% mask.png
convert mask.png \( +clone \) -alpha off -compose CopyOpacity -composite -fill black -colorize 100 \
  -trim +repage -strip -depth 8 PNG32:partners/beefbackbetter-black.png
```

Check it: `%[opaque]` prints `false`, the size is 1038×1080, and `preview` shows the lettering and the cow
legible at the tier's 4.5rem height.

The wordmark is set in Dust West, which is licensed for personal use only — it lives here as
images and is never installed or converted. Headings on the site use Bevan (OFL).

When better exports arrive (uncompressed PNG, or ideally SVG), drop them in under the same names.
An SVG source may replace a PNG of the same stem; the build script prefers `.svg` when present.
