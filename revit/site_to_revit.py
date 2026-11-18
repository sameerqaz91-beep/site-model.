"""Read a 2D site plan DXF (UTM / GPS coordinates) and write the site data that build_site.py turns into a Revit model.

Usage:
  python3 revit/site_to_revit.py PLAN.dxf OUT.json --site battalion [--floors 008=3 ...]
  python3 revit/site_to_revit.py PLAN.dxf OUT.json --bbox X0 Y0 X1 Y1 [--name "..."] [--config site.json]

Needs Python 3.9+ with:  pip install ezdxf shapely

--site picks one of the SITES presets below (area and layer names of Sameer's master plan);
--bbox crops any other area, in drawing coordinates (UTM metres), with the default layers.
--config is a JSON file shaped like DEFAULT_CONFIG, for a drawing with other layer names.

What comes out (all lengths in metres):
  origin     : the drawing (UTM) coordinates of the model's (0, 0) point, rounded to 10 m
  base_elev  : the ground elevation (m above sea level) taken as the model's level 0
  ground     : spot heights [x, y, z] relative to origin and base_elev, for the topography
  buildings  : outlines, number (code), floors, height and base offset of every building
  surfaces   : asphalt and paving areas as [outer ring, hole rings...]
  fences     : fence and boundary-wall polylines
  trees      : tree positions
Heights are not in a 2D plan: a building gets FLOOR_HEIGHT per floor plus a parapet, sheds and cabins a
fixed height. Give real floor counts per building number with --floors CODE=N.

The drawing and the JSON made from it are private: keep them out of the repository.
"""
import argparse, json, logging, os, re, statistics, sys

import ezdxf
from ezdxf import path
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

DEFAULT_CONFIG = {
    # group -> layers whose linework encloses buildings; "floors" (storeys) or a fixed "height" (m);
    # "gap": openings narrower than twice this (m) are closed first (doors in detailed floor plans);
    # "inset": shrink the outline by this much (m), when the layer draws a strip around the building
    "buildings": {
        "existing": {"label": "مبانٍ قائمة", "layers": ["SC-BUILDING"], "floors": 1, "gap": 0.25},
        "proposed": {"label": "مبانٍ مقترحة", "layers": ["PROPOSED BUILDING", "NEW STRUCTURE OUTLINE",
                                                         "SANG-TF-MP-01(REV-2)$0$NEW PROPOSED BUILDING OUTLINE",
                                                         "00000buildyy"], "floors": 1, "gap": 0.25},
        "sheds": {"label": "مظلات ومستودعات", "layers": ["SC-SHED", "SC-TENT"], "height": 6.0, "gap": 0.25},
        "cabins": {"label": "غرف حراسة وكبائن", "layers": ["SC-GUARD-HOUSE", "SC-PORTA CABIN", "PORTA-CABIN",
                                                            "GUARD TOWER"], "height": 3.0, "gap": 0.25},
    },
    # lines that enclose paved blocks; the corridors between them become asphalt
    "curbs": ["SC-CURB", "NEW WALKWAYS", "SC-ASPHALT-ROAD", "SC-SIDEWALK", "FINAL ROAD EDGES", "FINAL ROAD CURBSTONE",
              "New road", "SC-CONCRETE", "الطرق"],
    "parking": ["PARKING LINES", "parking lane"],
    "fences": ["SC-FENCE", "NEW FENCES", "Ex-fence", "EXISTING WALL", "CHAINLINK FENCE"],
    "trees": ["SC-TREE", "EXISTING PALM TREE", "L-tree ficus", "L-tree-palm-1", "CLP-TRE"],
    "codes": ["EXIST-NAME", "SANG-TF-MP-01(REV-2)$0$EXISTING BUILDING NUMBERS", "bldg_tag", "00000texty"],
    "code_pattern": r"^\d{3}[A-Z]?$",  # building numbers look like 008 or 012A
    # texts holding a ground level such as "1546.21" (finished / natural ground level points)
    "levels": ["FGL-PNTS", "FGL-PTS", "SC-F.G.L", "SPOTX", "LEVEL PTS.", "EXTNG LVL."],
    "level_range": [100.0, 9000.0],  # plausible absolute elevations; others are pipe sizes, chainages...
    "min_area": 6.0,
    "max_area": 20000.0,
    "floor_height": 3.5,
    "parapet": 0.6,
    "fence_height": 2.4,
}

# Areas of the master plan "موقع الكتيبة الامنية و موقع الامداد والاشارة والاسلحة والذخيرة ... GPS".
SITES = {
    "battalion": {"name": "موقع الكتيبة الأمنية", "bbox": [650380, 2369040, 651060, 2369580],
                  "floors": {"008": 3}},
    # The walled compound east of it, drawn as detailed floor plans (wall layer A-WALLCMU-50).
    "supply": {"name": "موقع الإمداد والإشارة والأسلحة والذخيرة", "bbox": [651850, 2368950, 652450, 2369480],
               "config": {"buildings": {
                   # outer edge of the 1 m protection strip around each building
                   "strip": {"label": "مبانٍ", "layers": ["protection strip"], "floors": 1, "gap": 0.25, "inset": 1.0},
                   "blocks": {"label": "مبانٍ ومظلات", "layers": ["00000buildyy", "A-WALLCMU-50", "A-CMUWALL-15",
                                                                  "SPC_conc.edging"], "floors": 1, "gap": 0.8}}}},
}

LINE_TYPES = {"LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"}
MAX_DEPTH = 6
NUMBER = re.compile(r"(\d+(?:\.\d+)?)")


def flat_points(e):
    try:
        return [(p.x, p.y) for p in path.make_path(e).flattening(0.1)]
    except Exception:
        return []


def block_lines(insert, depth=0):
    """Linework inside a block reference, in drawing coordinates (buildings are often drawn as blocks)."""
    if depth > MAX_DEPTH:
        return
    try:
        children = list(insert.virtual_entities())
    except Exception:
        return
    for c in children:
        if c.dxftype() == "INSERT":
            yield from block_lines(c, depth + 1)
        elif c.dxftype() in LINE_TYPES:
            yield c


def footprints(segments, gap, min_area, max_area):
    """Enclosed areas of a set of 2D polylines, as polygons without holes."""
    if not segments:
        return []
    ink = unary_union([LineString(s) for s in segments if len(s) >= 2]).buffer(gap, join_style="mitre",
                                                                                 cap_style="square")
    out = []
    for p in getattr(ink, "geoms", [ink]):
        solid = Polygon(p.exterior).buffer(-gap, join_style="mitre")
        for q in getattr(solid, "geoms", [solid]):
            if q.is_empty or not (min_area <= q.area <= max_area):
                continue
            if q.area / max(q.length, 1e-9) < 0.5:  # a lone line leaves a sliver; rooms are ~2 m across
                continue
            out.append(shapely.simplify(q, 0.05))
    return out


def as_polys(geom):
    return [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "Polygon" and not g.is_empty]


def surfaces(curbs, parking, buildings):
    """Asphalt corridors between curb lines and the paved blocks they enclose."""
    if not curbs:
        return [], []
    ink = unary_union([LineString(s) for s in curbs if len(s) >= 2]).buffer(0.15)
    enclosed = [Polygon(r) for p in as_polys(ink) for r in p.interiors]
    enclosed = [p for p in enclosed if p.area >= 30]
    bays = unary_union([LineString(s) for s in parking if len(s) >= 2]) if parking else None
    blocks, lots = [], []
    for p in sorted(enclosed, key=lambda q: q.area):
        if any(p.contains(q) for q in blocks + lots):
            continue  # keep the innermost areas; outer rings are the curb band
        if bays is not None and p.intersection(bays).length > 0.2 * p.length:
            lots.append(p)
        else:
            blocks.append(p)
    corridor = ink.buffer(7, join_style="mitre").buffer(-5, join_style="mitre")
    asphalt = corridor.difference(unary_union(blocks)).union(unary_union(lots)) if blocks else corridor
    if buildings:
        asphalt = asphalt.difference(unary_union([b.buffer(0.5) for b in buildings]))
    asphalt = [shapely.simplify(p, 0.1) for p in as_polys(asphalt) if p.area > 15]
    paving = [shapely.simplify(p, 0.1) for p in blocks]
    return [p for p in asphalt if p.is_valid], [p for p in paving if p.is_valid]


def idw(points, x, y, k=6):
    """Ground height at (x, y) from the nearest k spot heights, inverse-distance weighted."""
    if not points:
        return 0.0
    near = sorted(points, key=lambda p: (p[0] - x) ** 2 + (p[1] - y) ** 2)[:k]
    num = den = 0.0
    for px, py, pz in near:
        d2 = (px - x) ** 2 + (py - y) ** 2
        if d2 < 1e-6:
            return pz
        num += pz / d2
        den += 1 / d2
    return num / den


def thin_ground(points, cell):
    """One spot height per cell x cell metres, so the topography stays light."""
    seen = {}
    for p in points:
        seen.setdefault((int(p[0] // cell), int(p[1] // cell)), p)
    return list(seen.values())


def load_config(args):
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    name, bbox, floors = args.name, args.bbox, {}
    if args.site:
        site = SITES[args.site]
        name = name or site["name"]
        bbox = bbox or site["bbox"]
        floors.update(site.get("floors", {}))
        cfg.update(site.get("config", {}))
    if args.config:
        with open(args.config, encoding="utf-8") as f:
            cfg.update(json.load(f))
    if not bbox:
        sys.exit("give --site or --bbox")
    for item in args.floors:
        code, _, n = item.partition("=")
        if not n.isdigit() or int(n) < 1:
            sys.exit(f"--floors expects CODE=N with N >= 1, got {item!r}")
        floors[code.strip()] = int(n)
    return cfg, name or "", [float(v) for v in bbox], floors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--site", choices=sorted(SITES))
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--name", default="")
    ap.add_argument("--config")
    ap.add_argument("--floors", action="append", default=[], metavar="CODE=N")
    args = ap.parse_args(argv)
    cfg, name, (x0, y0, x1, y1), floors_by_code = load_config(args)
    ox, oy = round((x0 + x1) / 2, -1), round((y0 + y1) / 2, -1)

    def inside(x, y):
        return x0 <= x <= x1 and y0 <= y <= y1

    def loc(x, y):
        return [round(x - ox, 3), round(y - oy, 3)]

    logging.getLogger("ezdxf").setLevel(logging.ERROR)  # old drawings trigger many harmless style warnings
    doc = ezdxf.readfile(args.src)
    msp = doc.modelspace()
    layer_group = {l: g for g, spec in cfg["buildings"].items() for l in spec["layers"]}
    segs = {g: [] for g in cfg["buildings"]}
    extra = {k: [] for k in ("curbs", "parking", "fences")}
    extra_of = {l: k for k in extra for l in cfg[k]}
    trees, codes, spots = [], [], []
    lo, hi = cfg["level_range"]
    code_re = re.compile(cfg["code_pattern"])

    for e in msp:
        layer, t = e.dxf.layer, e.dxftype()
        if t in LINE_TYPES and (layer in layer_group or layer in extra_of):
            pts = flat_points(e)
            if len(pts) < 2 or not all(inside(x, y) for x, y in (pts[0], pts[-1])):
                continue
            if layer in layer_group:
                segs[layer_group[layer]].append(pts)
            if layer in extra_of:
                extra[extra_of[layer]].append(pts)
        elif t == "INSERT" and layer in layer_group:
            p = e.dxf.insert
            if not inside(p.x, p.y):
                continue
            for c in block_lines(e):
                pts = flat_points(c)
                if len(pts) >= 2:
                    segs[layer_group[layer]].append(pts)
        elif t == "INSERT" and layer in cfg["trees"]:
            p = e.dxf.insert
            if inside(p.x, p.y):
                trees.append(loc(p.x, p.y))
        elif t in {"TEXT", "MTEXT"} and (layer in cfg["codes"] or layer in cfg["levels"]):
            p = e.dxf.insert
            if not inside(p.x, p.y):
                continue
            text = (e.plain_text() if t == "MTEXT" else e.dxf.text).strip().replace("\n", " ")
            if layer in cfg["codes"]:
                if code_re.match(text):
                    codes.append((text, p.x, p.y))
            else:
                m = NUMBER.search(text.replace(" ", ""))
                if m and "%" not in text and lo <= float(m.group(1)) <= hi:
                    spots.append((p.x, p.y, float(m.group(1))))

    # Spot heights: drop stray values (pipe inverts, typos) far from the rest.
    if spots:
        med = statistics.median(z for *_, z in spots)
        spots = [s for s in spots if abs(s[2] - med) <= 15]
    base = round(statistics.median(z for *_, z in spots), 2) if spots else 0.0

    # Building numbers: one per spot (the same number is often written twice).
    uniq = []
    for c in codes:
        if not any(u[0] == c[0] and abs(u[1] - c[1]) < 12 and abs(u[2] - c[2]) < 12 for u in uniq):
            uniq.append(c)

    found, taken = [], []
    for g, spec in cfg["buildings"].items():
        polys = footprints(segs[g], spec.get("gap", 0.25), cfg["min_area"], cfg["max_area"])
        if spec.get("inset"):
            polys = [q for p in polys for q in as_polys(p.buffer(-spec["inset"], join_style="mitre"))
                     if q.area >= cfg["min_area"]]
        for poly in sorted(polys, key=lambda p: -p.area):
            if any(poly.intersection(t).area > 0.6 * poly.area for t in taken):
                continue  # drawn on two layers, or a room inside a building already found
            taken.append(poly)
            found.append((g, poly))
    code_of = {}
    for text, x, y in uniq:
        pt = Point(x, y)
        best = min(range(len(found)), key=lambda i: found[i][1].distance(pt), default=None)
        if best is not None and found[best][1].distance(pt) <= 25:
            d = found[best][1].distance(pt)
            if best not in code_of or d < code_of[best][1]:
                code_of[best] = (text, d)
    unused = set(floors_by_code) - {t for t, _ in code_of.values()}
    if unused:
        print(f"no building found for: {', '.join(sorted(unused))}", file=sys.stderr)

    fh, parapet = cfg["floor_height"], cfg["parapet"]
    buildings = []
    for i, (g, poly) in enumerate(found):
        spec = cfg["buildings"][g]
        code = code_of.get(i, (None,))[0]
        if "floors" in spec:
            floors = floors_by_code.get(code, spec["floors"])
            height = round(floors * fh + parapet, 2)
        else:
            floors, height = 0, spec["height"]
        ring = list(poly.exterior.coords)[:-1]
        if not poly.exterior.is_ccw:
            ring.reverse()
        # The building stands on the highest ground under its corners, so no wall floats.
        ground = max(idw(spots, x, y) for x, y in ring) - base if spots else 0.0
        buildings.append({"group": g, "label": spec["label"], "code": code, "floors": floors, "height": height,
                          "base": round(ground, 2), "area": round(poly.area, 1),
                          "outline": [loc(x, y) for x, y in ring]})

    asphalt, paving = surfaces(extra["curbs"], extra["parking"], [p for _, p in found])

    def surf(p):
        c = p.representative_point()
        return {"base": round(idw(spots, c.x, c.y) - base, 2) if spots else 0.0,
                "rings": [[loc(x, y) for x, y in list(r.coords)[:-1]] for r in [p.exterior, *p.interiors]]}

    fences = []
    for s in extra["fences"]:
        line = shapely.simplify(LineString(s), 0.05)
        if line.length >= 1.0:
            pts = list(line.coords)
            fences.append({"base": round(min(idw(spots, x, y) for x, y in pts) - base, 2) if spots else 0.0,
                           "points": [loc(x, y) for x, y in pts]})

    # Ground: spot heights plus the bbox corners and edge midpoints, so the surface covers the whole site.
    ground = [[*loc(x, y), round(z - base, 3)] for x, y, z in thin_ground(spots, 4.0)]
    for fx in (0, 0.5, 1):
        for fy in (0, 0.5, 1):
            if fx == fy == 0.5:
                continue
            x, y = x0 + fx * (x1 - x0), y0 + fy * (y1 - y0)
            ground.append([*loc(x, y), round(idw(spots, x, y) - base, 3) if spots else 0.0])

    out = {"name": name, "units": "m", "source": os.path.basename(args.src),
           "origin": {"easting": ox, "northing": oy}, "base_elev": base,
           "bbox": [round(x0 - ox, 1), round(y0 - oy, 1), round(x1 - ox, 1), round(y1 - oy, 1)],
           "floor_height": fh, "parapet": parapet, "fence_height": cfg["fence_height"], "assumed_heights": True,
           "ground": ground, "buildings": buildings,
           "surfaces": {"asphalt": [surf(p) for p in asphalt], "paving": [surf(p) for p in paving]},
           "fences": fences, "trees": trees}
    os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
    with open(args.dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    groups = {}
    for b in buildings:
        groups[b["group"]] = groups.get(b["group"], 0) + 1
    print(f"{name}: buildings {groups}, numbered {sum(1 for b in buildings if b['code'])}, "
          f"spot heights {len(spots)} (level 0 = {base} m), asphalt {len(asphalt)}, paving {len(paving)}, "
          f"fences {len(fences)}, trees {len(trees)}")
    return out


if __name__ == "__main__":
    main()
