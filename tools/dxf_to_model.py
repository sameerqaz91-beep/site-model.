"""Convert a 3D master-plan DXF into the JSON the viewer loads.

Usage: python3 tools/dxf_to_model.py MASTER_PLAN.dxf viewer/public/model.json ["Project name"]

Buildings are read from the 3D-HOUSES and 3D-PUBLIC layers as polyface meshes (POLYLINE), MESH entities,
or 3DFACE entities, in modelspace or inside block references (INSERT, nested too). Entities on layer "0"
inside a block take the layer of the INSERT that places them, as AutoCAD draws them.
One building is one POLYLINE or MESH entity; 3DFACEs are grouped into buildings by shared corners.

Output (Y-up, metres, centred on the site):
  meshes:  {layer: {"positions": [...], "indices": [...], "items": [[firstIndex, count, height, area], ...]}}
  lines:   {layer: [[x, z, x, z, ...] polylines on the ground]}
  fills:   [[x, z, ...] closed outlines of solid hatches]
  labels:  [{"t": text, "x": x, "z": z, "h": height}]
  floorHeight: height of the floor lines, when the drawing gives them an elevation
"""
import json, os, statistics, sys
import ezdxf
from ezdxf import bbox, path
from ezdxf.math import Vec3

MESH_LAYERS = {"3D-HOUSES", "3D-PUBLIC"}
LINE_LAYERS = {"blocks": "plan", "A-DETL": "details", "3D-FLOOR-LINE": "floors"}
LINE_TYPES = {"LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE"}
MAX_DEPTH = 8  # block nesting deeper than this is almost surely a reference loop


def walk(entities, layer=None, depth=0):
    """Yield (entity, effective layer) for every entity, expanding block references in world coordinates."""
    for e in entities:
        own = e.dxf.get("layer", "0")
        eff = layer if (layer and own == "0") else own
        if e.dxftype() == "INSERT":
            if depth >= MAX_DEPTH:
                continue
            try:
                children = list(e.virtual_entities())
            except Exception as err:  # broken or non-uniformly scaled block: skip it, say so
                print(f"skipped block {e.dxf.name!r}: {err}", file=sys.stderr)
                continue
            yield from walk(children, eff, depth + 1)
        else:
            yield e, eff


def solid_of(e):
    """(vertices, faces) for a POLYLINE polyface mesh or MESH entity, else None."""
    t = e.dxftype()
    if t == "POLYLINE" and e.is_poly_face_mesh:
        mb = ezdxf.render.MeshBuilder.from_polyface(e)
    elif t == "MESH":
        mb = ezdxf.render.MeshBuilder.from_mesh(e)
    else:
        return None
    verts = [Vec3(v) for v in mb.vertices]
    faces = [list(f) for f in mb.faces if len(f) >= 3]
    return (verts, faces) if faces else None


def group_faces(faces3d):
    """Group 3DFACE corner lists into buildings: faces sharing a corner (to 1 cm) are one building."""
    parent = list(range(len(faces3d)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner = {}
    for i, pts in enumerate(faces3d):
        for p in pts:
            key = (round(p.x, 2), round(p.y, 2), round(p.z, 2))
            if key in owner:
                parent[find(i)] = find(owner[key])
            else:
                owner[key] = i
    groups = {}
    for i in range(len(faces3d)):
        groups.setdefault(find(i), []).append(faces3d[i])
    for fs in groups.values():
        verts, index, faces = [], {}, []
        for pts in fs:
            f = []
            for p in pts:
                key = (round(p.x, 3), round(p.y, 3), round(p.z, 3))
                if key not in index:
                    index[key] = len(verts)
                    verts.append(p)
                f.append(index[key])
            faces.append(f)
        yield verts, faces


def face_corners(e):
    """Distinct corners of a 3DFACE (a triangle repeats its last corner)."""
    pts = [Vec3(e.dxf.get(f"vtx{i}")) for i in range(4)]
    out = []
    for p in pts:
        if not out or not p.isclose(out[-1], abs_tol=1e-6):
            out.append(p)
    if len(out) > 1 and out[-1].isclose(out[0], abs_tol=1e-6):
        out.pop()
    return out if len(out) >= 3 else None


def footprint_area(verts, faces):
    """Plan area covered by a building, from the faces that look up or down but are not its floor.

    Roof planes of a flat, pitched or stepped roof project onto the plan without overlapping, so the sum of
    their projected areas is the footprint. Walls project to (almost) nothing; floor faces at the bottom are
    left out so a closed solid is not counted twice.
    """
    zmin = min(v.z for v in verts)
    total = 0.0
    for f in faces:
        ring = [verts[i] for i in f]
        if all(abs(v.z - zmin) < 0.01 for v in ring):
            continue  # floor
        n = Vec3()
        for a, b in zip(ring, ring[1:] + ring[:1]):
            n += a.cross(b)
        if n.magnitude < 1e-9 or abs(n.z) / n.magnitude < 0.05:
            continue  # wall or degenerate
        total += abs(n.z) / 2
    return total


def main(src, dst, name=""):
    doc = ezdxf.readfile(src)
    msp = doc.modelspace()
    flat = list(walk(msp))

    # Site extents come from the buildings and the plan; the title block and frame are left out.
    site = bbox.extents([e for e, layer in flat if layer in MESH_LAYERS | {"blocks"}], fast=True)
    if not site.has_data:
        sys.exit("No entities on 3D-HOUSES, 3D-PUBLIC or blocks; is this the right drawing?")
    cx, cy = (site.extmin.x + site.extmax.x) / 2, (site.extmin.y + site.extmax.y) / 2
    max_span = max(site.size.x, site.size.y) * 0.9  # anything this large is a frame, not plan

    def xz(x, y):
        return [round(x - cx, 2), round(-(y - cy), 2)]

    def inside(x, y):
        return site.extmin.x - 5 <= x <= site.extmax.x + 5 and site.extmin.y - 5 <= y <= site.extmax.y + 5

    meshes = {}

    def add_building(layer, verts, faces):
        m = meshes.setdefault(layer, {"positions": [], "indices": [], "items": []})
        base = len(m["positions"]) // 3
        for v in verts:
            m["positions"] += [round(v.x - cx, 2), round(v.z, 2), round(-(v.y - cy), 2)]
        first = len(m["indices"])
        for f in faces:
            for i in range(1, len(f) - 1):  # fan-triangulate each face
                m["indices"] += [base + f[0], base + f[i], base + f[i + 1]]
        zs = [v.z for v in verts]
        m["items"].append([first, len(m["indices"]) - first, round(max(zs) - min(zs), 2),
                           round(footprint_area(verts, faces), 1)])

    loose_faces = {}  # layer -> 3DFACE corner lists, grouped into buildings at the end
    lines, fills, labels, floor_z = {}, [], [], []
    for e, layer in flat:
        t = e.dxftype()
        if layer in MESH_LAYERS:
            if t == "3DFACE":
                corners = face_corners(e)
                if corners:
                    loose_faces.setdefault(layer, []).append(corners)
                continue
            solid = solid_of(e)
            if solid:
                add_building(layer, *solid)
            continue

        kind = LINE_LAYERS.get(layer)
        if kind and t in LINE_TYPES and not (t == "POLYLINE" and not e.is_2d_polyline and not e.is_3d_polyline):
            try:
                pts = list(path.make_path(e).flattening(0.25))
            except Exception:
                continue
            if len(pts) < 2:
                continue
            xs, ys = [q.x for q in pts], [q.y for q in pts]
            if max(xs) - min(xs) > max_span or max(ys) - min(ys) > max_span or not inside(xs[0], ys[0]):
                continue
            lines.setdefault(kind, []).append([c for q in pts for c in xz(q.x, q.y)])
            if kind == "floors":
                floor_z.append(pts[0].z)
            continue

        if t == "HATCH" and layer == "blocks" and e.dxf.solid_fill:
            for p in path.from_hatch(e):
                pts = list(p.flattening(0.25))
                if len(pts) >= 3 and inside(pts[0].x, pts[0].y):
                    fills.append([c for q in pts for c in xz(q.x, q.y)])
            continue

        if t in {"TEXT", "MTEXT"}:
            x, y = e.dxf.insert.x, e.dxf.insert.y
            text = (e.plain_text() if t == "MTEXT" else e.dxf.text).strip()
            h = e.dxf.char_height if t == "MTEXT" else e.dxf.height
            # Skip texts outside the site and ones stored in a legacy Arabic font encoding (unreadable here);
            # Unicode Arabic passes.
            if not text or not inside(x, y) or any(ch in text for ch in ":,]'"):
                continue
            labels.append({"t": text, "x": xz(x, y)[0], "z": xz(x, y)[1], "h": round(h, 2)})

    for layer, faces3d in loose_faces.items():
        for verts, faces in group_faces(faces3d):
            add_building(layer, verts, faces)

    out = {"name": name, "units": "m", "size": [round(site.size.x, 1), round(site.size.y, 1)],
           "meshes": meshes, "lines": lines, "fills": fills, "labels": labels}
    if floor_z and statistics.median(floor_z) > 0.1:
        out["floorHeight"] = round(statistics.median(floor_z), 2)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"houses={len(meshes.get('3D-HOUSES', {}).get('items', []))} public={len(meshes.get('3D-PUBLIC', {}).get('items', []))} "
          f"lines={ {k: len(v) for k, v in lines.items()} } fills={len(fills)} labels={len(labels)}")
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(*sys.argv[1:4])
