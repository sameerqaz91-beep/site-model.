"""Draw the site data from site_to_revit.py as a plan and a 3D view, to check it before running Revit.

Usage: python3 revit/preview_site.py SITE.json OUT.png        (needs: pip install matplotlib)
"""
import json, sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as Patch
from mpl_toolkits.mplot3d.art3d import Poly3DCollection

COLORS = {"existing": "#c8b89a", "proposed": "#e8dcc4", "sheds": "#9fb4c7", "cabins": "#d9a37a"}


def main(src, dst):
    with open(src, encoding="utf-8") as f:
        d = json.load(f)
    fig = plt.figure(figsize=(20, 10), dpi=110)
    ax = fig.add_subplot(1, 2, 1)
    for kind, color in (("asphalt", "#4a4a4a"), ("paving", "#d8d2c4")):
        for s in d["surfaces"][kind]:
            ax.add_patch(Patch(s["rings"][0], closed=True, fc=color, ec="none", zorder=1))
            for hole in s["rings"][1:]:
                ax.add_patch(Patch(hole, closed=True, fc="white", ec="none", zorder=1.5))
    for fence in d["fences"]:
        xs, ys = zip(*fence["points"])
        ax.plot(xs, ys, color="#7a3b2e", lw=1.2, zorder=3)
    for b in d["buildings"]:
        ax.add_patch(Patch(b["outline"], closed=True, fc=COLORS.get(b["group"], "#ddd"), ec="k", lw=0.6, zorder=4))
        if b["code"]:
            cx = sum(p[0] for p in b["outline"]) / len(b["outline"])
            cy = sum(p[1] for p in b["outline"]) / len(b["outline"])
            ax.text(cx, cy, b["code"], fontsize=7, ha="center", va="center", zorder=5)
    if d["trees"]:
        xs, ys = zip(*d["trees"])
        ax.scatter(xs, ys, s=6, color="#3d7a3a", zorder=4)
    x0, y0, x1, y1 = d["bbox"]
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.set_title(f"plan, origin E {d['origin']['easting']:.0f} N {d['origin']['northing']:.0f}")

    ax3 = fig.add_subplot(1, 2, 2, projection="3d")
    if len(d["ground"]) >= 3:
        xs, ys, zs = zip(*d["ground"])
        ax3.plot_trisurf(xs, ys, zs, color="#cdbf9f", alpha=0.6, linewidth=0)
    for b in d["buildings"]:
        ring, z0, z1 = b["outline"], b["base"], b["base"] + b["height"]
        faces = [[(*ring[i], z0), (*ring[(i + 1) % len(ring)], z0), (*ring[(i + 1) % len(ring)], z1), (*ring[i], z1)]
                 for i in range(len(ring))]
        faces.append([(*p, z1) for p in ring])
        ax3.add_collection3d(Poly3DCollection(faces, fc=COLORS.get(b["group"], "#ddd"), ec="#555", lw=0.2))
    ax3.set_xlim(x0, x1)
    ax3.set_ylim(y0, y1)
    span = max(x1 - x0, y1 - y0)
    zmin = min([p[2] for p in d["ground"]] or [0])
    ax3.set_zlim(zmin, zmin + span / 3)
    ax3.set_box_aspect((x1 - x0, y1 - y0, span / 3))
    ax3.view_init(elev=35, azim=-60)
    ax3.set_title(f"3D, level 0 = {d['base_elev']} m")
    fig.suptitle(f"{d['source']}  ·  {len(d['buildings'])} buildings", fontsize=10)
    fig.savefig(dst, bbox_inches="tight")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
