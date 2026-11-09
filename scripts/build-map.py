#!/usr/bin/env python3
"""scripts/build-map.py: the Location page's map (README, "The location page").

    python3 scripts/build-map.py fetch    query OpenStreetMap (Overpass) once; write brand/map/osm-extract.json
    python3 scripts/build-map.py render   draw the map from that extract into public/location.html and
                                          public/es/location.html, between <!-- map:begin --> and <!-- map:end -->

Standard library only, no network in `render`. The map is inline SVG (no <img>, no third-party tiles: the
CSP is img-src 'self' and the site loads nothing from elsewhere), so its labels use the site's fonts and
read in the page's language. What it shows: the west half of Lake Ilopango, the main roads, Apulo, the boat
and ferry crossing from Apulo, and the venue pin (13.676983, -89.095381, Cameron's coordinates, the same as
the venue-map popover). The data is OpenStreetMap's (ODbL); the pages credit it under the map.

`render` refuses to draw when the venue pin is not on the lakeshore (within 400 m of the OSM shoreline, on
land) or the crossing is not a 5-minute boat ride (2-5 km): a wrong pin must never ship as a map.
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACT = ROOT / "brand" / "map" / "osm-extract.json"
PAGES = {"en": ROOT / "public" / "location.html", "es": ROOT / "public" / "es" / "location.html"}

VENUE = (13.676983, -89.095381)          # lat, lon: the site's venue pin
LAKE_RELATION = 3553081                  # Lago de Ilopango
APULO_NODE = 9153486067                  # Dolores Apulo (place=village)
APULO_PARK = 1127406483                  # Parque Recreativo Apulo, the lakeside turicentro: the boats' side
# The frame: the lake's west half, with the land toward San Salvador on the left.
WEST, EAST, SOUTH, NORTH = -89.160, -89.000, 13.625, 13.730
WIDTH = 1000                             # viewBox width; the height follows the frame's true aspect
CX, CY = WIDTH - 80, 112                 # the compass, top right: clear of the shore, the roads and every label
FETCH_BOX = (13.60, -89.22, 13.75, -88.95)


ENDPOINTS = ("https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter")


def overpass(q):
    """POST the query; on a busy server (429/502/503/504) back off and try the next public instance."""
    data = urllib.parse.urlencode({"data": q}).encode()
    wait = 5
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        req = urllib.request.Request(url, data=data, headers={"User-Agent": "renaissance-rodeo-map-build/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 502, 503, 504):
                raise
            print(f"{url}: HTTP {e.code}, retrying in {wait} s", file=sys.stderr)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"{url}: {e}, retrying in {wait} s", file=sys.stderr)
        time.sleep(wait)
        wait *= 2
    sys.exit("Overpass: every attempt failed")


def fetch():
    s, w, n, e = FETCH_BOX
    q = f"""[out:json][timeout:90];
(relation({LAKE_RELATION}); way(r);)->.lake;
.lake out geom;
way["highway"="trunk"]({s},{w},{n},{e});
out geom tags;
way["highway"]["name"="Calle a Apulo"]({s},{w},{n},{e});
out geom tags;
(node({APULO_NODE}); way({APULO_PARK}););
out tags center;
"""
    d = overpass(q)
    rel = next(x for x in d["elements"] if x["type"] == "relation" and x["id"] == LAKE_RELATION)
    roles = {m["ref"]: m["role"] for m in rel["members"] if m["type"] == "way"}
    ways = {x["id"]: x for x in d["elements"] if x["type"] == "way" and "geometry" in x}
    pt = lambda p: [round(p["lat"], 6), round(p["lon"], 6)]
    lake = [{"role": roles[i], "coords": [pt(p) for p in ways[i]["geometry"]]} for i in roles if i in ways]
    if len(lake) != len(roles):
        sys.exit(f"lake: {len(lake)} of {len(roles)} member ways came back with geometry")
    roads = []
    for x in d["elements"]:
        t = x.get("tags", {})
        if x["type"] == "way" and x["id"] not in roles and "geometry" in x and "highway" in t:
            kind = "apulo" if t.get("name") == "Calle a Apulo" else t["highway"]
            roads.append({"id": x["id"], "kind": kind, "ref": t.get("ref"), "name": t.get("name"),
                          "coords": [pt(p) for p in x["geometry"]]})
    places = {}
    for x in d["elements"]:
        c = x.get("center") or ({"lat": x["lat"], "lon": x["lon"]} if "lat" in x else None)
        if x["id"] in (APULO_NODE, APULO_PARK) and c:
            places[str(x["id"])] = {"name": x.get("tags", {}).get("name"), "at": pt(c)}
    if len(places) != 2:
        sys.exit(f"places: got {sorted(places)}, want the Apulo village node and the Apulo park")
    roads.sort(key=lambda r: r["id"])
    out = {"source": "OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)",
           "query": q, "lake": lake, "roads": roads, "places": places}
    EXTRACT.parent.mkdir(parents=True, exist_ok=True)
    EXTRACT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"wrote {EXTRACT.relative_to(ROOT)}: {len(lake)} lake ways, {len(roads)} roads, {len(places)} places")


# ---------------------------------------------------------------- geometry
LAT0 = (NORTH + SOUTH) / 2
KX = 111_320 * math.cos(math.radians(LAT0))   # metres per degree of longitude here
KY = 110_574                                  # metres per degree of latitude
SCALE = WIDTH / ((EAST - WEST) * KX)          # viewBox units per metre
HEIGHT = round((NORTH - SOUTH) * KY * SCALE)


def project(lat, lon):
    return ((lon - WEST) * KX * SCALE, (NORTH - lat) * KY * SCALE)


def metres(a, b):
    return math.hypot((a[1] - b[1]) * KX, (a[0] - b[0]) * KY)


def stitch(segments):
    """Join way segments that share end points into closed rings."""
    segs = [list(s) for s in segments]
    rings = []
    while segs:
        ring = segs.pop(0)
        while ring[0] != ring[-1]:
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                else:
                    continue
                segs.pop(i)
                break
            else:
                sys.exit("lake: a ring does not close")
        rings.append(ring)
    return rings


def seg_dist(p, a, b):
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / ((dx * dx + dy * dy) or 1)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def inside(p, ring):
    x, y = p
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def simplify(pts, tol):
    """Douglas-Peucker, iterative."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, at = -1.0, None
        for k in range(i + 1, j):
            dd = seg_dist(pts[k], pts[i], pts[j])
            if dd > best:
                best, at = dd, k
        if at is not None and best > tol:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(pts, keep) if k]


def clip_ring(ring, x0, y0, x1, y1):
    """Sutherland-Hodgman against a rectangle (the frame plus a margin, so the cut never shows)."""
    def cut(pts, inside_fn, cross):
        out = []
        for a, b in zip(pts, pts[1:] + pts[:1]):
            if inside_fn(b):
                if not inside_fn(a):
                    out.append(cross(a, b))
                out.append(b)
            elif inside_fn(a):
                out.append(cross(a, b))
        return out

    def at_x(x):
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))

    def at_y(y):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)

    pts = ring[:-1]
    for fn, cr in ((lambda p: p[0] >= x0, at_x(x0)), (lambda p: p[0] <= x1, at_x(x1)),
                   (lambda p: p[1] >= y0, at_y(y0)), (lambda p: p[1] <= y1, at_y(y1))):
        pts = cut(pts, fn, cr) if pts else pts
    return pts + pts[:1] if pts else []


def clip_line(pts, x0, y0, x1, y1):
    """Split a polyline into the runs inside the rectangle (keeping one point beyond each edge)."""
    ins = [x0 <= x <= x1 and y0 <= y <= y1 for x, y in pts]
    runs, cur = [], []
    for i, p in enumerate(pts):
        near = ins[i] or (i > 0 and ins[i - 1]) or (i + 1 < len(pts) and ins[i + 1])
        if near:
            cur.append(p)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) > 1]


def path(pts, close=False):
    """Absolute first point, then relative integer steps (the bytes of a 2 KB map, not a 20 KB one)."""
    q = [(round(x), round(y)) for x, y in pts]
    out = [q[0]]
    for p in q[1:]:
        if p != out[-1]:
            out.append(p)
    s = f"M{out[0][0]} {out[0][1]}"
    steps = []
    for (ax, ay), (bx, by) in zip(out, out[1:]):
        steps.append(f"{bx - ax} {by - ay}")
    if steps:
        s += "l" + " ".join(steps)
    s = re.sub(r" -", "-", s)
    return s + ("z" if close else "")


# ---------------------------------------------------------------- render
LABELS = {
    "en": {"title": "Map: Renaissance Rodeo at the west end of Lake Ilopango, across the water from Apulo, "
                    "which the boat and the ferry leave from. San Salvador is to the west; north is up.",
           "lake": "Lake Ilopango", "boat": "Boat &amp; ferry"},
    "es": {"title": "Mapa: Renaissance Rodeo en el extremo oeste del Lago de Ilopango, al otro lado del agua "
                    "desde Apulo, de donde salen el bote y el ferry. San Salvador queda al oeste; el norte est\u00e1 arriba.",
           "lake": "Lago de Ilopango", "boat": "Bote y ferry"},
}


def render():
    d = json.loads(EXTRACT.read_text())
    outer = stitch([w["coords"] for w in d["lake"] if w["role"] == "outer"])
    inner = stitch([w["coords"] for w in d["lake"] if w["role"] == "inner"])
    shore = [[project(*p) for p in r] for r in outer]

    # The accuracy gate: the pin is on land, on the shore; the crossing is a short boat ride.
    v = project(*VENUE)
    gap = min(seg_dist(v, a, b) for r in shore for a, b in zip(r, r[1:])) / SCALE
    if gap > 400 or any(inside(v, r) for r in shore):
        sys.exit(f"venue pin is {gap:.0f} m from the shoreline (or in the lake): check the coordinates before drawing")
    park = d["places"][str(APULO_PARK)]["at"]
    village = d["places"][str(APULO_NODE)]["at"]
    crossing = metres(park, VENUE)
    if not 2000 <= crossing <= 5000:
        sys.exit(f"Apulo to the venue is {crossing / 1000:.2f} km: not a 5-minute boat ride, check before drawing")
    print(f"gate: venue {gap:.0f} m from the shore, on land; Apulo park to the venue {crossing / 1000:.2f} km")

    m = 60  # margin in viewBox units, so clipped edges sit outside the frame
    box = (-m, -m, WIDTH + m, HEIGHT + m)
    tol = 1.1  # ~17 m at this scale: well under a pixel of the drawn map
    water = []
    for r in outer + inner:
        pts = clip_ring([project(*p) for p in r], *box)
        if len(pts) > 3:
            water.append(path(simplify(pts, tol), close=True))
    roads = {"trunk": [], "apulo": []}
    for r in d["roads"]:
        for run in clip_line([project(*p) for p in r["coords"]], *box):
            roads["trunk" if r["kind"] != "apulo" else "apulo"].append(path(simplify(run, tol)))

    a = project(*park)
    # The crossing: a gentle arc out over the water, from the Apulo shore to the venue's.
    mx, my = (a[0] + v[0]) / 2, (a[1] + v[1]) / 2
    nx, ny = (v[1] - a[1]), -(v[0] - a[0])
    ln = math.hypot(nx, ny)
    c = (mx + nx / ln * 45, my + ny / ln * 45)
    for t in [i / 20 for i in range(3, 18)]:
        p = ((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * v[0],
             (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * v[1])
        if not any(inside(p, r) for r in shore):
            sys.exit(f"the crossing arc leaves the water at t={t:.2f}: adjust its bend")
    ap = project(*village)
    lake_at = project(13.664, -89.045)
    ss_y = project(13.699, WEST)[1]

    for lang, page in PAGES.items():
        L = LABELS[lang]
        r1 = lambda x: f"{x:.0f}"
        svg = "\n".join([
            f'<svg class="map" viewBox="0 0 {WIDTH} {HEIGHT}" role="img" aria-labelledby="map-title">',
            f'  <title id="map-title">{L["title"]}</title>',
            f'  <path class="map-water" fill-rule="evenodd" d="{"".join(water)}"/>',
            f'  <path class="map-road" d="{"".join(roads["trunk"])}"/>',
            f'  <path class="map-road map-road-apulo" d="{"".join(roads["apulo"])}"/>',
            f'  <path class="map-crossing" d="M{r1(a[0])} {r1(a[1])}Q{r1(c[0])} {r1(c[1])} {r1(v[0])} {r1(v[1])}"/>',
            f'  <text class="map-lake" x="{r1(lake_at[0])}" y="{r1(lake_at[1])}" text-anchor="middle">{L["lake"]}</text>',
            f'  <text class="map-note" x="{r1(c[0] + 18)}" y="{r1(c[1] + 22)}">{L["boat"]}</text>',
            f'  <circle class="map-dot" cx="{r1(a[0])}" cy="{r1(a[1])}" r="9"/>',
            f'  <text class="map-place" x="{r1(a[0] + 4)}" y="{r1(min(a[1], ap[1]) - 26)}" text-anchor="middle">Apulo</text>',
            f'  <path class="map-pin" d="M{r1(v[0])} {r1(v[1] - 22)}l22 22-22 22-22-22z"/>',
            # Two lines to the left of the pin, on the land side: one line would run off the frame.
            f'  <text class="map-venue" x="{r1(v[0] - 34)}" y="{r1(v[1] - 6)}" text-anchor="end">Renaissance'
            f'<tspan x="{r1(v[0] - 34)}" dy="42">Rodeo</tspan></text>',
            f'  <path class="map-arrow" d="M70 {r1(ss_y - 14)}l-28 14 28 14"/>',
            f'  <text class="map-place" x="84" y="{r1(ss_y + 12)}">San Salvador</text>',
            # The compass (Cameron, 2026-11-08), top right on a paper disc so it reads over land or lake: the
            # frame is north-up (equirectangular), so north is straight up; the north point is the site's red.
            f'  <g class="map-compass">',
            f'    <circle cx="{CX}" cy="{CY}" r="40"/>',
            f'    <path class="map-compass-n" d="M{CX} {CY - 50}l11 50h-22z"/>',
            f'    <path class="map-compass-s" d="M{CX} {CY + 50}l11-50h-22z"/>',
            f'    <path class="map-compass-s" d="M{CX - 50} {CY}l50-9v18z"/>',
            f'    <path class="map-compass-s" d="M{CX + 50} {CY}l-50-9v18z"/>',
            f'    <text class="map-compass-label" x="{CX}" y="{CY - 58}" text-anchor="middle">N</text>',
            "  </g>",
            "</svg>",
        ])
        html = page.read_text()
        new, n = re.subn(r"(<!-- map:begin -->)(?:\n.*?)?(\n[ \t]*<!-- map:end -->)",
                         lambda mm: mm.group(1) + "\n" + indent(svg, mm.group(2)) + mm.group(2), html, flags=re.S)
        if n != 1:
            sys.exit(f"{page.relative_to(ROOT)}: want exactly one map:begin/map:end pair, found {n}")
        page.write_text(new)
        print(f"{page.relative_to(ROOT)}: map {len(svg.encode())} bytes")


def indent(svg, tail):
    pad = re.match(r"\n(\s*)", tail).group(1)
    return "\n".join(pad + line for line in svg.splitlines())


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "fetch":
        fetch()
    elif mode == "render":
        render()
    else:
        sys.exit(__doc__)
