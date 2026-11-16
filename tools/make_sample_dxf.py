"""Write a small made-up master-plan DXF with the layers dxf_to_model.py expects.

Usage: python3 tools/make_sample_dxf.py sample.dxf

The real drawing stays out of this public repo; this file lets anyone try the converter and viewer.
It draws a grid of plots with house blocks, a few public buildings with type codes, roads, a hatched park,
and a floor line on each house at +3.2 m. Houses use every shape the converter reads: polyface meshes, one
column of pitched roofs made of 3DFACEs, one stepped MESH block, and one column of block references.
"""
import sys
import ezdxf


def box(msp, layer, x, y, w, d, h):
    """A closed box as a polyface mesh: four walls and a roof (no floor), like a massing export."""
    pts = [(x, y, 0), (x + w, y, 0), (x + w, y + d, 0), (x, y + d, 0)]
    top = [(px, py, h) for px, py, _ in pts]
    mesh = msp.add_polyface(dxfattribs={"layer": layer})
    faces = [top]
    for i in range(4):
        j = (i + 1) % 4
        faces.append([pts[i], pts[j], top[j], top[i]])
    mesh.append_faces(faces)


def gable(x, y, w, d, eave, ridge):
    """Corners of a house with a pitched (gable) roof, ridge along x, as 3DFACE corner lists."""
    a, b, c_, e = (x, y, 0), (x + w, y, 0), (x + w, y + d, 0), (x, y + d, 0)
    A, B, C, E = (x, y, eave), (x + w, y, eave), (x + w, y + d, eave), (x, y + d, eave)
    R1, R2 = (x, y + d / 2, ridge), (x + w, y + d / 2, ridge)
    return [[a, b, B, A], [b, c_, C, B], [c_, e, E, C], [e, a, A, E],  # walls
            [A, B, R2, R1], [C, E, R1, R2],  # roof planes
            [A, R1, E], [B, C, R2]]  # gable ends


def stepped_mesh(msp, layer, x, y):
    """A MESH entity: a 20x16 block whose back half rises to 10 m and front half to 4 m."""
    v, f = [], []

    def blk(x0, y0, w, d, z0, z1):
        base = len(v)
        v.extend([(x0, y0, z0), (x0 + w, y0, z0), (x0 + w, y0 + d, z0), (x0, y0 + d, z0),
                  (x0, y0, z1), (x0 + w, y0, z1), (x0 + w, y0 + d, z1), (x0, y0 + d, z1)])
        f.extend([[base + i for i in q] for q in
                  ([4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7])])

    blk(x, y, 20, 8, 0, 4)
    blk(x, y + 8, 20, 8, 0, 10)
    mesh = msp.add_mesh(dxfattribs={"layer": layer})
    with mesh.edit_data() as data:
        data.vertices, data.faces = v, f


def main(dst):
    doc = ezdxf.new("R2010")
    for name in ("3D-HOUSES", "3D-PUBLIC", "3D-FLOOR-LINE", "blocks", "A-DETL"):
        doc.layers.add(name)
    msp = doc.modelspace()

    # A villa block drawn once on layer 0 and placed with INSERTs on 3D-HOUSES, as many CAD exports do.
    villa = doc.blocks.new("VILLA")
    box(villa, "0", 0, 0, 20, 16, 7)

    plot, road, cols, rows = 30.0, 12.0, 8, 6
    pitch = plot + road
    for c in range(cols):
        for r in range(rows):
            x0, y0 = c * pitch, r * pitch
            msp.add_lwpolyline([(x0, y0), (x0 + plot, y0), (x0 + plot, y0 + plot), (x0, y0 + plot)],
                               close=True, dxfattribs={"layer": "blocks"})
            if (c, r) in {(3, 2), (4, 2), (3, 3), (4, 3)}:
                continue  # park in the middle
            if (c, r) in {(0, 5), (7, 0), (7, 5)}:
                box(msp, "3D-PUBLIC", x0 + 3, y0 + 3, plot - 6, plot - 6, 12)
                msp.add_circle((x0 + plot / 2, y0 + plot / 2), 4, dxfattribs={"layer": "A-DETL"})
                code = {(0, 5): "MOSQ", (7, 0): "SCH", (7, 5): "CLN"}[(c, r)]
                msp.add_text(code, height=3, dxfattribs={"insert": (x0 + 4, y0 + 4)})
                continue
            bx, by = x0 + 5, y0 + 6
            if c == 1:  # one column of pitched roofs built from 3DFACEs (ridge 9.5 m)
                for corners in gable(bx, by, 20, 16, 7, 9.5):
                    msp.add_3dface(corners, dxfattribs={"layer": "3D-HOUSES"})
            elif c == 2 and r == 0:  # one stepped MESH block
                stepped_mesh(msp, "3D-HOUSES", bx, by)
            elif c == 6:  # one column placed as block references
                msp.add_blockref("VILLA", (bx, by), dxfattribs={"layer": "3D-HOUSES"})
            else:
                box(msp, "3D-HOUSES", bx, by, 20, 16, 7)
            floor = msp.add_lwpolyline([(bx, by), (bx + 20, by), (bx + 20, by + 16), (bx, by + 16)],
                                       close=True, dxfattribs={"layer": "3D-FLOOR-LINE"})
            floor.dxf.elevation = 3.2
            msp.add_text(f"{c * rows + r + 1}", height=1.5, dxfattribs={"insert": (x0 + 1, y0 + 1)})

    # Park: a solid hatch over the four empty plots and the roads between them.
    hatch = msp.add_hatch(color=3, dxfattribs={"layer": "blocks"})
    px, py = 3 * pitch, 2 * pitch
    hatch.paths.add_polyline_path([(px, py), (px + pitch + plot, py), (px + pitch + plot, py + pitch + plot),
                                   (px, py + pitch + plot)], is_closed=True)
    msp.add_text("DISTRICT1", height=5, dxfattribs={"insert": (2 * pitch, 5 * pitch - road / 2 - 2)})
    msp.add_mtext("حديقة الحي", dxfattribs={"insert": (px + 20, py + 40), "char_height": 3})
    doc.saveas(dst)
    print(f"wrote {dst}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "sample.dxf")
