"""Turn a 2D site plan (DXF) into the JSON the viewer loads, by raising building outlines into blocks.

Usage:
  python3 tools/plan_to_model.py PLAN.dxf viewer/public/model.json "Project name" --bbox X0 Y0 X1 Y1 [--config site.json]

Use this when the drawing has no 3D solids (only lines), which is how most site plans and survey drawings
come. Use dxf_to_model.py when the drawing already has 3D massing on 3D-HOUSES / 3D-PUBLIC.

--bbox crops to one site, in drawing coordinates; site plans often hold several sites and detail sheets.
--config is a JSON file shaped like DEFAULT_CONFIG below, to name the layers and heights of another drawing.

Heights are not in a 2D plan. Buildings get a number of floors (1 by default, or per building number with
--floors 008=3), at 3.5 m a floor plus a 0.6 m parapet; sheds and cabins get one fixed height (see DEFAULT_CONFIG).
Building numbers (codes) are matched to the nearest footprint within 25 m.
Outlines drawn as separate LINEs, double wall lines and small gaps (under 0.5 m) are all handled: the
linework is thickened a little, merged, and every enclosed area becomes one building footprint.
"""
import argparse, json, os, sys
import ezdxf
from ezdxf import path
import shapely
from shapely.geometry import LineString, Polygon, Point
from shapely.ops import unary_union

# Layer names follow the survey/master-plan drawings this was written for ("SC-" survey layers).
DEFAULT_CONFIG = {
    # group key -> {label shown in the viewer, layers, and either "floors" (storeys) or a fixed "height" in m}
    "buildings": {
        "existing": {"label": "مبانٍ قائمة", "layers": ["SC-BUILDING"], "floors": 1},
        "proposed": {"label": "مبانٍ مقترحة", "layers": ["PROPOSED BUILDING", "NEW STRUCTURE OUTLINE",
                                                         "SANG-TF-MP-01(REV-2)$0$NEW PROPOSED BUILDING OUTLINE"],
                     "floors": 1},
        "sheds": {"label": "مظلات ومستودعات", "layers": ["SC-SHED", "SC-TENT"], "height": 6.0},
        "cabins": {"label": "غرف حراسة وكبائن", "layers": ["SC-GUARD-HOUSE", "SC-PORTA CABIN", "PORTA-CABIN",
                                                            "GUARD TOWER"], "height": 3.0},
    },
    # line group -> layers drawn flat on the ground
    "lines": {
        "plan": ["SC-ASPHALT-ROAD", "SC-CURB", "NEW WALKWAYS", "New road", "الطرق", "SC-SIDEWALK",
                 "EXISTING SIDEWALK", "FINAL ROAD EDGES", "FINAL ROAD CURBSTONE", "NEW ROADLINES", "PARKING LINES"],
        "details": ["SC-FENCE", "NEW FENCES", "Ex-fence", "EXISTING WALL", "SC-WALL-FOOT", "CHAINLINK FENCE",
                    "playing courts", "SC-CONCRETE", "SC-GATE", "EXISTING GATE"],
    },
    # Surfaces: curb and walkway edges enclose blocks (paving); the corridors between them are asphalt.
    "curbs": ["SC-CURB", "NEW WALKWAYS", "SC-ASPHALT-ROAD", "SC-SIDEWALK", "FINAL ROAD EDGES", "FINAL ROAD CURBSTONE",
              "New road", "SC-CONCRETE"],
    "parking": ["PARKING LINES"],
    "sports": ["playing courts"],
    "fences": ["SC-FENCE", "NEW FENCES", "Ex-fence", "EXISTING WALL", "CHAINLINK FENCE"],
    "fence_height": 2.4,
    "trees": ["SC-TREE", "EXISTING PALM TREE", "L-tree ficus", "L-tree-palm-1"],
    "codes": ["EXIST-NAME", "SANG-TF-MP-01(REV-2)$0$EXISTING BUILDING NUMBERS", "bldg_tag"],
    "names": [],  # layers whose text is shown as place names (Arabic text shows in the viewer)
    "min_area": 6.0,  # m²: smaller closed shapes are symbols, not buildings
    "max_area": 20000.0,
    "floor_height": 3.5,
    "parapet": 0.6,
}
GAP = 0.25  # half the gap width (m) closed when outlines do not quite meet
LINE_TYPES = {"LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"}


def flat_points(e):
    try:
        return [(p.x, p.y) for p in path.make_path(e).flattening(0.1)]
    except Exception:
        return []


def footprints(segments, min_area, max_area):
    """Enclosed areas of a set of 2D polylines, as polygons without holes."""
    if not segments:
        return []
    ink = unary_union([LineString(s) for s in segments if len(s) >= 2]).buffer(GAP, join_style="mitre", cap_style="square")
    parts = getattr(ink, "geoms", [ink])
    out = []
    for p in parts:
        # The ink plus everything it encloses, shrunk back to the drawn line.
        solid = Polygon(p.exterior).buffer(-GAP, join_style="mitre")
        for q in getattr(solid, "geoms", [solid]):
            if q.is_empty or not (min_area <= q.area <= max_area):
                continue
            # A lone line leaves a sliver after shrinking; real rooms are at least ~2 m across.
            if q.area / max(q.length, 1e-9) < 0.5:
                continue
            out.append(shapely.simplify(q, 0.05))
    return out


def extrude(poly, h):
    """Vertices (x, y, z) and faces of a prism: walls plus a triangulated flat roof."""
    ring = list(poly.exterior.coords)[:-1]
    if Polygon(ring).exterior.is_ccw is False:
        ring.reverse()
    n = len(ring)
    verts = [(x, y, 0.0) for x, y in ring] + [(x, y, h) for x, y in ring]
    faces = [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    index = {(round(x, 4), round(y, 4)): i for i, (x, y) in enumerate(ring)}
    tris = shapely.constrained_delaunay_triangles(Polygon(ring))
    for t in tris.geoms:
        ids = []
        corners = list(t.exterior.coords)[:-1]
        if Polygon(corners).exterior.is_ccw is False:
            corners.reverse()  # roof faces up: counter-clockwise seen from above
        for x, y in corners:
            k = index.get((round(x, 4), round(y, 4)))
            if k is None:  # triangulation added a point: fall back to a new vertex
                verts.append((x, y, h))
                ids.append(len(verts) - 1)
            else:
                ids.append(n + k)
        faces.append(ids)
    return verts, faces


def rings(poly, xz):
    """A polygon as [outer, hole, ...] rings of flat x, z numbers."""
    return [[c for x, y in list(r.coords) for c in xz(x, y)] for r in [poly.exterior, *poly.interiors]]


def as_polys(geom):
    return [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "Polygon" and not g.is_empty]


def make_surfaces(extra, buildings, xz):
    """Ground surfaces: asphalt corridors, paved blocks, parking, and sports pitches."""
    out = {"asphalt": [], "paving": [], "grass": [], "track": [], "court": []}
    if extra["curbs"]:
        ink = unary_union([LineString(s) for s in extra["curbs"] if len(s) >= 2]).buffer(0.15)
        # Areas fully enclosed by curb lines are blocks; those holding parking bays are parking lots.
        enclosed = [Polygon(r) for p in as_polys(ink) for r in p.interiors]
        enclosed = [p for p in enclosed if p.area >= 30]
        parking = unary_union([LineString(s) for s in extra["parking"] if len(s) >= 2]) if extra["parking"] else None
        sports = unary_union([LineString(s) for s in extra["sports"] if len(s) >= 2]) if extra["sports"] else None
        blocks, lots = [], []
        for p in sorted(enclosed, key=lambda q: q.area):
            if any(p.contains(q) for q in blocks + lots):
                continue  # keep the innermost areas; outer rings are the curb band
            if sports is not None and p.area > 2000 and p.intersection(sports).length > 100:
                continue  # the running track and pitch are handled below
            if parking is not None and p.intersection(parking).length > 0.2 * p.length:
                lots.append(p)
            else:
                blocks.append(p)
        # Asphalt: the corridors around blocks, found by closing the gaps between curb lines.
        corridor = ink.buffer(7, join_style="mitre").buffer(-5, join_style="mitre")
        asphalt = corridor.difference(unary_union(blocks)).union(unary_union(lots)) if blocks else corridor
        asphalt = asphalt.difference(unary_union([b.buffer(0.5) for b in buildings])) if buildings else asphalt
        out["asphalt"] = [rings(shapely.simplify(p, 0.1), xz) for p in as_polys(asphalt) if p.area > 15]
        out["paving"] = [rings(shapely.simplify(p, 0.1), xz) for p in blocks]
    if extra["sports"]:
        ink = unary_union([LineString(s) for s in extra["sports"] if len(s) >= 2]).buffer(0.15)
        for outer in as_polys(ink):
            whole = Polygon(outer.exterior)
            if whole.area < 200:
                continue
            box = whole.minimum_rotated_rectangle
            if whole.area > 3000:
                # A large sports area is a pitch with a running track: red surface, grass on the largest rectangle inside.
                out["track"].append(rings(shapely.simplify(whole, 0.1), xz))
                inner = [Polygon(r) for r in outer.interiors]
                pitch = max((q for q in inner if q.area > 0.9 * q.minimum_rotated_rectangle.area), key=lambda q: q.area, default=None)
                if pitch is None or pitch.area < 1000:
                    pitch = whole.buffer(-7, join_style="mitre")  # about six running lanes
                if not pitch.is_empty:
                    out["grass"] += [rings(shapely.simplify(q, 0.1), xz) for q in as_polys(pitch)]
            else:
                out["court"].append(rings(shapely.simplify(whole, 0.1), xz))
    return {k: v for k, v in out.items() if v}


def make_walls(lines, h, cx, cy):
    """Fences and boundary walls as thin solids along their lines."""
    m = {"positions": [], "indices": []}
    for s in lines:
        if len(s) < 2:
            continue
        for (ax, ay), (bx, by) in zip(s, s[1:]):
            dx, dy = bx - ax, by - ay
            L = (dx * dx + dy * dy) ** 0.5
            if L < 0.05:
                continue
            nx, ny = -dy / L * 0.12, dx / L * 0.12
            quad = [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)]
            base = len(m["positions"]) // 3
            for z in (0.0, h):
                for x, y in quad:
                    m["positions"] += [round(x - cx, 2), z, round(-(y - cy), 2)]
            for f in ([4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]):
                m["indices"] += [base + f[0], base + f[1], base + f[2], base + f[0], base + f[2], base + f[3]]
    return m


def make_windows(buildings, fh, cx, cy):
    """Window panes on each facade and floor: 1.6 m wide, 1.4 m tall, about every 3.2 m."""
    m = {"positions": [], "indices": []}
    for poly, floors in buildings:
        if floors <= 0:
            continue
        ring = list(poly.exterior.coords)
        if not Polygon(ring).exterior.is_ccw:
            ring.reverse()
        for (ax, ay), (bx, by) in zip(ring, ring[1:]):
            dx, dy = bx - ax, by - ay
            L = (dx * dx + dy * dy) ** 0.5
            n = int((L - 1.0) // 3.2)
            if n < 1:
                continue
            ux, uy = dx / L, dy / L
            ox, oy = uy * 0.05, -ux * 0.05  # outward for a counter-clockwise ring
            pad = (L - n * 3.2) / 2 + 0.8
            for f in range(floors):
                z0 = f * fh + 1.0
                for k in range(n):
                    c = pad + k * 3.2
                    x0, y0 = ax + ux * (c - 0.8) + ox, ay + uy * (c - 0.8) + oy
                    x1, y1 = ax + ux * (c + 0.8) + ox, ay + uy * (c + 0.8) + oy
                    base = len(m["positions"]) // 3
                    for x, y, z in ((x0, y0, z0), (x1, y1, z0), (x1, y1, z0 + 1.4), (x0, y0, z0 + 1.4)):
                        m["positions"] += [round(x - cx, 2), round(z, 2), round(-(y - cy), 2)]
                    m["indices"] += [base, base + 1, base + 2, base, base + 2, base + 3]
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("name", nargs="?", default="")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"), required=True)
    ap.add_argument("--config")
    ap.add_argument("--floors", action="append", default=[], metavar="CODE=N",
                    help="floors of the building with this number, e.g. --floors 008=3 (repeatable)")
    a = ap.parse_args()
    floors_by_code = {}
    for item in a.floors:
        code, _, n = item.partition("=")
        if not n.isdigit() or int(n) < 1:
            sys.exit(f"--floors expects CODE=N with N >= 1, got {item!r}")
        floors_by_code[code.strip()] = int(n)
    cfg = dict(DEFAULT_CONFIG)
    if a.config:
        with open(a.config, encoding="utf-8") as f:
            cfg.update(json.load(f))
    x0, y0, x1, y1 = a.bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    def inside(x, y):
        return x0 <= x <= x1 and y0 <= y <= y1

    def xz(x, y):
        return [round(x - cx, 2), round(-(y - cy), 2)]

    doc = ezdxf.readfile(a.src)
    msp = doc.modelspace()
    layer_group = {l: g for g, spec in cfg["buildings"].items() for l in spec["layers"]}
    line_group = {l: g for g, ls in cfg["lines"].items() for l in ls}
    segs = {g: [] for g in cfg["buildings"]}
    extra = {k: [] for k in ("curbs", "parking", "sports", "fences")}
    extra_of = {l: k for k in extra for l in cfg.get(k, [])}
    lines, trees, labels, codes = {}, [], [], []

    for e in msp:
        layer, t = e.dxf.layer, e.dxftype()
        if t in LINE_TYPES and (layer in layer_group or layer in line_group or layer in extra_of):
            pts = flat_points(e)
            if len(pts) < 2 or not all(inside(x, y) for x, y in (pts[0], pts[-1])):
                continue
            if layer in extra_of:
                extra[extra_of[layer]].append(pts)
                if layer not in layer_group and layer not in line_group:
                    continue
            if layer in layer_group:
                segs[layer_group[layer]].append(pts)
            else:
                lines.setdefault(line_group[layer], []).append([c for x, y in pts for c in xz(x, y)])
        elif t == "INSERT" and layer in cfg["trees"]:
            p = e.dxf.insert
            if inside(p.x, p.y):
                trees += xz(p.x, p.y)
        elif t in {"TEXT", "MTEXT"} and (layer in cfg["codes"] or layer in cfg["names"]):
            p = e.dxf.insert
            text = (e.plain_text() if t == "MTEXT" else e.dxf.text).strip().replace("\n", " ")
            if not text or not inside(p.x, p.y) or text.startswith("%%"):
                continue
            item = {"t": text, "x": xz(p.x, p.y)[0], "z": xz(p.x, p.y)[1],
                    "h": round(e.dxf.char_height if t == "MTEXT" else e.dxf.height, 2)}
            (codes if layer in cfg["codes"] else labels).append(item)

    # Drop duplicate codes (the same number is often written twice) and keep one per spot.
    uniq = []
    for c in codes:
        if not any(u["t"] == c["t"] and abs(u["x"] - c["x"]) < 12 and abs(u["z"] - c["z"]) < 12 for u in uniq):
            uniq.append(c)

    # All footprints first, so building numbers can be matched before heights are set.
    found = []  # (group, polygon)
    taken = []  # footprints already used, so a building drawn on two layers is not doubled
    for g in cfg["buildings"]:
        for poly in sorted(footprints(segs[g], cfg["min_area"], cfg["max_area"]), key=lambda p: -p.area):
            if any(poly.intersection(t).area > 0.6 * poly.area for t in taken):
                continue
            taken.append(poly)
            found.append((g, poly))
    code_of = {}
    for c in uniq:
        pt = Point(c["x"] + cx, -c["z"] + cy)
        best = min(range(len(found)), key=lambda i: found[i][1].distance(pt), default=None)
        if best is not None and found[best][1].distance(pt) <= 25:
            d = found[best][1].distance(pt)
            if best not in code_of or d < code_of[best][1]:
                code_of[best] = (c["t"], d)
    unused = set(floors_by_code) - {t for t, _ in code_of.values()}
    if unused:
        print(f"no building found for: {', '.join(sorted(unused))}", file=sys.stderr)

    meshes, labels_out, storeys = {}, {}, []
    floors_list = [0] * len(found)
    fh, parapet = cfg["floor_height"], cfg["parapet"]
    for g, spec in cfg["buildings"].items():
        m = {"positions": [], "indices": [], "items": []}
        for i, (gg, poly) in enumerate(found):
            if gg != g:
                continue
            code = code_of.get(i, (None,))[0]
            if "floors" in spec:
                floors = floors_by_code.get(code, spec["floors"])
                height = round(floors * fh + parapet, 2)
                ring = [c for x, y in list(poly.exterior.coords) for c in xz(x, y)]
                storeys += [[round(k * fh, 2), *ring] for k in range(1, floors + 1)]
            else:
                floors, height = 0, spec["height"]
            floors_list[i] = floors
            verts, faces = extrude(poly, height)
            base = len(m["positions"]) // 3
            for x, y, z in verts:
                m["positions"] += [round(x - cx, 2), round(z, 2), round(-(y - cy), 2)]
            first = len(m["indices"])
            for f in faces:
                for i in range(1, len(f) - 1):
                    m["indices"] += [base + f[0], base + f[i], base + f[i + 1]]
            m["items"].append([first, len(m["indices"]) - first, height, round(poly.area, 1), floors, code])
        if m["items"]:
            meshes[g] = m
            labels_out[g] = spec["label"]

    surfaces = make_surfaces(extra, [p for _, p in found], xz)
    walls = make_walls(extra["fences"], cfg["fence_height"], cx, cy)
    windows = make_windows([(p, m) for (g, p), m in zip(found, floors_list)], fh, cx, cy)

    out = {"name": a.name, "units": "m", "size": [round(x1 - x0, 1), round(y1 - y0, 1)],
           "meshes": meshes, "meshLabels": labels_out, "lines": lines, "fills": [], "labels": labels,
           "codes": uniq, "trees": trees, "storeys": storeys,
           "surfaces": surfaces, "walls": walls, "windows": windows,
           "assumedHeights": True}
    os.makedirs(os.path.dirname(os.path.abspath(a.dst)), exist_ok=True)
    with open(a.dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(" ".join(f"{g}={len(m['items'])}" for g, m in meshes.items()),
          f"lines={ {k: len(v) for k, v in lines.items()} } trees={len(trees) // 2} codes={len(uniq)} labels={len(labels)}")


if __name__ == "__main__":
    main()
