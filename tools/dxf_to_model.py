"""Convert a 3D master-plan DXF into the JSON the viewer loads.

Usage: python3 tools/dxf_to_model.py MASTER_PLAN.dxf viewer/public/model.json ["Project name"]

Output (Y-up, metres, centred on the site):
  meshes:  {layer: {"positions": [...], "indices": [...], "items": [[firstIndex, count, height, area], ...]}}
  lines:   {layer: [[x, z, x, z, ...] polylines on the ground]}
  fills:   [[x, z, ...] closed outlines of solid hatches]
  labels:  [{"t": text, "x": x, "z": z, "h": height}]
"""
import json, math, sys
import ezdxf
from ezdxf import bbox, path

MESH_LAYERS = {"3D-HOUSES", "3D-PUBLIC"}
LINE_LAYERS = {"blocks": "plan", "A-DETL": "details", "3D-FLOOR-LINE": "floors"}


def main(src, dst, name=""):
    doc = ezdxf.readfile(src)
    msp = doc.modelspace()

    # Site extents come from the buildings and the plan; the title block and frame are left out.
    site = bbox.extents([e for e in msp if e.dxf.layer in MESH_LAYERS | {"blocks"}], fast=True)
    cx, cy = (site.extmin.x + site.extmax.x) / 2, (site.extmin.y + site.extmax.y) / 2
    max_span = max(site.size.x, site.size.y) * 0.9  # anything this large is a frame, not plan

    def xz(x, y):
        return [round(x - cx, 2), round(-(y - cy), 2)]

    def inside(x, y):
        return site.extmin.x - 5 <= x <= site.extmax.x + 5 and site.extmin.y - 5 <= y <= site.extmax.y + 5

    meshes = {}
    for e in msp.query("POLYLINE"):
        if e.dxf.layer not in MESH_LAYERS or not e.is_poly_face_mesh:
            continue
        m = meshes.setdefault(e.dxf.layer, {"positions": [], "indices": [], "items": []})
        mb = ezdxf.render.MeshBuilder.from_polyface(e)
        verts, faces = mb.vertices, mb.faces
        base = len(m["positions"]) // 3
        for v in verts:
            m["positions"] += [round(v.x - cx, 2), round(v.z, 2), round(-(v.y - cy), 2)]
        first = len(m["indices"])
        for f in faces:
            for i in range(1, len(f) - 1):  # fan-triangulate each face
                m["indices"] += [base + f[0], base + f[i], base + f[i + 1]]
        zs = [v.z for v in verts]
        # Footprint area: sum of the roof faces (all vertices at the top height), projected on plan.
        area = 0.0
        for f in faces:
            ring = [verts[i] for i in f]
            if all(abs(v.z - max(zs)) < 1e-6 for v in ring):
                area += abs(sum(a.x * b.y - b.x * a.y for a, b in zip(ring, ring[1:] + ring[:1]))) / 2
        m["items"].append([first, len(m["indices"]) - first, round(max(zs) - min(zs), 2), round(area, 1)])

    lines = {}
    for e in msp:
        name = LINE_LAYERS.get(e.dxf.layer)
        if not name or e.dxftype() not in {"LINE", "LWPOLYLINE", "ARC", "CIRCLE"}:
            continue
        p = path.make_path(e)
        pts = list(p.flattening(0.25))
        if len(pts) < 2:
            continue
        xs, ys = [q.x for q in pts], [q.y for q in pts]
        if max(xs) - min(xs) > max_span or max(ys) - min(ys) > max_span or not inside(xs[0], ys[0]):
            continue
        lines.setdefault(name, []).append([c for q in pts for c in xz(q.x, q.y)])

    fills = []
    for h in msp.query("HATCH"):
        if h.dxf.layer != "blocks" or not h.dxf.solid_fill:
            continue
        for p in path.from_hatch(h):
            pts = list(p.flattening(0.25))
            if len(pts) >= 3 and inside(pts[0].x, pts[0].y):
                fills.append([c for q in pts for c in xz(q.x, q.y)])

    labels = []
    for t in msp.query("TEXT"):
        x, y = t.dxf.insert.x, t.dxf.insert.y
        text = t.dxf.text.strip()
        # Skip texts outside the site and ones stored in a legacy Arabic font encoding (unreadable here).
        if not text or not inside(x, y) or any(ch in text for ch in ":,]'"):
            continue
        labels.append({"t": text, "x": xz(x, y)[0], "z": xz(x, y)[1], "h": round(t.dxf.height, 2)})

    out = {"name": name, "units": "m", "size": [round(site.size.x, 1), round(site.size.y, 1)],
           "meshes": meshes, "lines": lines, "fills": fills, "labels": labels}
    with open(dst, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"houses={len(meshes.get('3D-HOUSES', {}).get('items', []))} public={len(meshes.get('3D-PUBLIC', {}).get('items', []))} "
          f"lines={ {k: len(v) for k, v in lines.items()} } fills={len(fills)} labels={len(labels)}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
