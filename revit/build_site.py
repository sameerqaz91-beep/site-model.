# -*- coding: utf-8 -*-
"""
Site model for Revit from a GPS site plan (Dynamo Python Script node)
=====================================================================
Reads the JSON that site_to_revit.py makes from the DXF and builds, in the open Revit project:
  1. Shared coordinates: the model's (0, 0, 0) is placed at its true UTM easting / northing / elevation
  2. Topography from the drawing's spot heights (Toposolid on Revit 2024+, Topography Surface before)
  3. Buildings: exterior walls, a slab per floor and a roof slab, numbered with the drawing's building number
  4. Asphalt and paving as thin site floors with their own materials
  5. Fences and boundary walls
  6. Trees (when a planting family is loaded)
  7. Views: site plan, 3D overview, four eye-level perspectives and an aerial perspective
  8. Sheets: A-101 site plan, A-301 aerial perspective, A-302 eye-level perspectives

How to run (Revit 2022 or newer):
  Manage > Dynamo > New > add a "Python Script" node > paste this file > engine CPython3
  (PythonNet3 on Revit 2025+) > connect a "File Path" node with the site JSON to IN[0] > Run.
  Full steps: revit/README.md
"""

# ---------------------------------------------------------------- settings ---
JSON_PATH = r"C:\Projects\battalion.json"  # used when IN[0] is not connected
SET_SHARED_COORDINATES = True   # put the model on its true UTM coordinates
BUILD_TOPOGRAPHY = True
BUILD_SURFACES = True           # asphalt and paving
BUILD_FENCES = True
BUILD_TREES = True
SURFACE_THICKNESS = 0.15        # m, asphalt and paving slabs
FENCE_THICKNESS = 0.2           # m
MAX_FENCE_SEGMENTS = 3000       # safety limit for very detailed drawings

LEVEL_PREFIX = u"منسوب"          # level names: منسوب 0, منسوب 1, ...
SITE_PLAN_NAME = u"مخطط الموقع العام"

# ------------------------------------------------------------------ imports ---
import io
import json
import math
import os
import clr
clr.AddReference("RevitAPI")
clr.AddReference("RevitServices")
clr.AddReference("System")
from System.Collections.Generic import List
from Autodesk.Revit.DB import *
from Autodesk.Revit.DB.Structure import StructuralType
from RevitServices.Persistence import DocumentManager
from RevitServices.Transactions import TransactionManager

doc = DocumentManager.Instance.CurrentDBDocument
report = []

try:
    if IN and IN[0]:
        JSON_PATH = str(IN[0])
except NameError:
    pass


# ------------------------------------------------------------------ helpers ---
def ft(meters):
    return meters / 0.3048


def P(x, y, z=0.0):
    return XYZ(ft(x), ft(y), ft(z))


def collect(cls):
    return list(FilteredElementCollector(doc).OfClass(cls).ToElements())


def try_name(element, name):
    """Name an element; if the name is taken, add a number."""
    for i in range(50):
        try:
            element.Name = name if i == 0 else u"%s (%d)" % (name, i + 1)
            return
        except Exception:
            continue


def set_param(element, bip, value):
    try:
        p = element.get_Parameter(bip)
        if p is not None and not p.IsReadOnly:
            p.Set(value)
            return True
    except Exception:
        pass
    return False


def set_text(element, bip, text):
    if text:
        set_param(element, bip, text)


def tname(t):
    """Type name that works on every Revit version (Name can fail on ElementType in CPython)."""
    try:
        return t.Name
    except Exception:
        p = t.get_Parameter(BuiltInParameter.SYMBOL_NAME_PARAM)
        return p.AsString() if p else ""


def pick_type(types, *keywords):
    for kw in keywords:
        for t in types:
            if kw.lower() in tname(t).lower():
                return t
    return types[0] if types else None


def clean_ring(points, closed=True, tol=0.05):
    """Drop repeated points and edges shorter than tol (m), which Revit rejects."""
    out = []
    for p in points:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= tol:
            out.append(p)
    if closed and len(out) > 1 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < tol:
        out.pop()
    return out


def curve_loop(points, z=0.0):
    ring = clean_ring(points)
    if len(ring) < 3:
        return None
    loop = CurveLoop()
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        loop.Append(Line.CreateBound(P(a[0], a[1], z), P(b[0], b[1], z)))
    return loop


def get_or_create_level(elev_m, name):
    for lv in collect(Level):
        if abs(lv.Elevation - ft(elev_m)) < 0.01:
            return lv
    lv = Level.Create(doc, ft(elev_m))
    try_name(lv, name)
    return lv


def get_or_create_plan(level):
    for v in collect(ViewPlan):
        if (not v.IsTemplate and v.GenLevel is not None and v.GenLevel.Id == level.Id
                and v.ViewType == ViewType.FloorPlan):
            return v
    vft = [t for t in collect(ViewFamilyType) if t.ViewFamily == ViewFamily.FloorPlan][0]
    return ViewPlan.Create(doc, vft.Id, level.Id)


def solid_material(name, rgb):
    for m in collect(Material):
        if m.Name == name:
            return m.Id
    mid = Material.Create(doc, name)
    m = doc.GetElement(mid)
    m.Color = Color(*rgb)
    try:
        m.SurfaceForegroundPatternColor = Color(*rgb)
        solid = [f for f in collect(FillPatternElement)
                 if f.GetFillPattern().IsSolidFill]
        if solid:
            m.SurfaceForegroundPatternId = solid[0].Id
    except Exception:
        pass
    return mid


def floor_type(base_type, name, thickness_m, material_id):
    """A one-layer floor type of the given thickness and material, made once by duplicating base_type."""
    for t in collect(FloorType):
        if tname(t) == name:
            return t
    t = base_type.Duplicate(name)
    try:
        cs = CompoundStructure.CreateSingleLayerCompoundStructure(
            MaterialFunctionAssignment.Structure, ft(thickness_m), material_id)
        t.SetCompoundStructure(cs)
    except Exception:
        pass
    return t


def wall_type(base_type, name, thickness_m, material_id=None):
    for t in collect(WallType):
        if tname(t) == name:
            return t
    t = base_type.Duplicate(name)
    try:
        mid = material_id if material_id is not None else ElementId.InvalidElementId
        cs = CompoundStructure.CreateSingleLayerCompoundStructure(
            MaterialFunctionAssignment.Structure, ft(thickness_m), mid)
        t.SetCompoundStructure(cs)
    except Exception:
        pass
    return t


def make_floor(loops, ftype, level, offset_m):
    curve_loops = List[CurveLoop]()
    for lp in loops:
        if lp is not None:
            curve_loops.Add(lp)
    if curve_loops.Count == 0:
        return None
    fl = Floor.Create(doc, curve_loops, ftype.Id, level.Id)
    set_param(fl, BuiltInParameter.FLOOR_HEIGHTABOVELEVEL_PARAM, ft(offset_m))
    return fl


def perspective(vft3d, eye, target, name):
    v = View3D.CreatePerspective(doc, vft3d.Id)
    forward = target.Subtract(eye).Normalize()
    right = forward.CrossProduct(XYZ.BasisZ).Normalize()
    up = right.CrossProduct(forward).Normalize()
    v.SetOrientation(ViewOrientation3D(eye, up, forward))
    try_name(v, name)
    try:
        v.DisplayStyle = DisplayStyle.Realistic
        v.DetailLevel = ViewDetailLevel.Fine
    except Exception:
        pass
    return v


def idw(points, x, y, k=6):
    if not points:
        return 0.0
    near = sorted(points, key=lambda p: (p[0] - x) ** 2 + (p[1] - y) ** 2)[:k]
    num = den = 0.0
    for px, py, pz in near:
        d2 = (px - x) ** 2 + (py - y) ** 2
        if d2 < 1e-6:
            return pz
        num += pz / d2
        den += 1.0 / d2
    return num / den


# --------------------------------------------------------------------- load ---
with io.open(JSON_PATH, encoding="utf-8") as f:
    site = json.load(f)
ground_pts = site.get("ground", [])
x0, y0, x1, y1 = site["bbox"]
counts = {"walls": 0, "floors": 0, "failed": 0}
failures = []


def failed(what, err):
    counts["failed"] += 1
    if len(failures) < 8:
        failures.append(u"%s: %s" % (what, err))


# --------------------------------------------------------------------- build --
TransactionManager.Instance.EnsureInTransaction(doc)
try:
    # 1. shared coordinates ---------------------------------------------------
    if SET_SHARED_COORDINATES:
        o = site["origin"]
        pos = ProjectPosition(ft(o["easting"]), ft(o["northing"]), ft(site.get("base_elev", 0.0)), 0.0)
        doc.ActiveProjectLocation.SetProjectPosition(XYZ.Zero, pos)
        report.append(u"Shared coordinates: (0,0,0) = E %.1f N %.1f, elevation %.2f m"
                      % (o["easting"], o["northing"], site.get("base_elev", 0.0)))

    # 2. levels ---------------------------------------------------------------
    fh = site.get("floor_height", 3.5)
    max_floors = max([b["floors"] for b in site["buildings"]] + [1])
    levels = [get_or_create_level(i * fh, u"%s %d" % (LEVEL_PREFIX, i)) for i in range(max_floors + 1)]
    ground_level = levels[0]
    site_plan = get_or_create_plan(ground_level)
    try_name(site_plan, SITE_PLAN_NAME)
    report.append("Levels: %d" % len(levels))

    # 3. topography -----------------------------------------------------------
    if BUILD_TOPOGRAPHY and len(ground_pts) >= 3:
        pts = List[XYZ]([P(x, y, z) for x, y, z in ground_pts])
        topo = None
        try:  # Revit 2024+
            tt = collect(ToposolidType)
            if tt:
                topo = Toposolid.Create(doc, pts, tt[0].Id, ground_level.Id)
        except Exception as e:
            failed("Toposolid", e)
        if topo is None:
            try:  # Revit 2022-2023
                topo = TopographySurface.Create(doc, pts)
            except Exception as e:
                failed("TopographySurface", e)
        if topo is not None:
            report.append("Topography: %d spot heights" % len(ground_pts))

    # 4. buildings ------------------------------------------------------------
    basic_walls = [w for w in collect(WallType) if w.Kind == WallKind.Basic]
    ext_type = pick_type(basic_walls, "Exterior", "Generic - 300", "Generic - 200", "Generic")
    base_floor = pick_type([f for f in collect(FloorType) if not f.IsFoundationSlab], "Generic", "Concrete")
    roof_mat = solid_material(u"سطح - خرسانة", (205, 200, 190))
    roof_type = floor_type(base_floor, u"Site - Roof slab 250", 0.25, roof_mat)
    groups = {}
    for b in site["buildings"]:
        ring = clean_ring(b["outline"])
        if len(ring) < 3:
            continue
        base = b["base"]
        mark = b.get("code") or ""
        try:
            for i in range(len(ring)):
                a, c = ring[i], ring[(i + 1) % len(ring)]
                w = Wall.Create(doc, Line.CreateBound(P(a[0], a[1]), P(c[0], c[1])), ext_type.Id,
                                ground_level.Id, ft(b["height"]), ft(base), False, False)
                set_text(w, BuiltInParameter.ALL_MODEL_MARK, mark)
                set_text(w, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS, b["label"])
                counts["walls"] += 1
            storeys = max(b["floors"], 0)
            roof = base + b["height"] - (site.get("parapet", 0.6) if storeys else 0.0)
            slab_heights = [base + k * fh for k in range(storeys)] + [roof]
            for k, z in enumerate(slab_heights):
                fl = make_floor([curve_loop(ring)], roof_type if k == len(slab_heights) - 1 else base_floor,
                                ground_level, z)
                if fl is not None:
                    set_text(fl, BuiltInParameter.ALL_MODEL_MARK, mark)
                    set_text(fl, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS, b["label"])
                    counts["floors"] += 1
            groups[b["label"]] = groups.get(b["label"], 0) + 1
        except Exception as e:
            failed(u"building %s" % (mark or "?"), e)
    report.append(u"Buildings: " + u", ".join(u"%s %d" % kv for kv in groups.items()))

    # 5. asphalt and paving ---------------------------------------------------
    if BUILD_SURFACES:
        kinds = {"asphalt": (u"Site - Asphalt", (60, 60, 62)), "paving": (u"Site - Paving", (214, 206, 190))}
        for kind, (name, rgb) in kinds.items():
            ftp = floor_type(base_floor, name, SURFACE_THICKNESS, solid_material(name, rgb))
            n = 0
            for s in site["surfaces"].get(kind, []):
                try:
                    fl = make_floor([curve_loop(r) for r in s["rings"]], ftp, ground_level,
                                    s["base"] + 0.05)  # just above the ground
                    if fl is not None:
                        set_text(fl, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS, kind)
                        n += 1
                except Exception as e:
                    failed(kind, e)
            report.append("%s areas: %d" % (kind, n))

    # 6. fences ---------------------------------------------------------------
    if BUILD_FENCES and site["fences"]:
        fence_type = wall_type(ext_type, u"Site - Fence", FENCE_THICKNESS,
                               solid_material(u"سور", (180, 170, 150)))
        n = 0
        for fence in site["fences"]:
            pts = clean_ring(fence["points"], closed=False, tol=0.2)
            for a, c in zip(pts, pts[1:]):
                if n >= MAX_FENCE_SEGMENTS:
                    break
                try:
                    w = Wall.Create(doc, Line.CreateBound(P(a[0], a[1]), P(c[0], c[1])), fence_type.Id,
                                    ground_level.Id, ft(site.get("fence_height", 2.4)), ft(fence["base"]),
                                    False, False)
                    set_text(w, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS, u"سور")
                    n += 1
                except Exception as e:
                    failed("fence", e)
        report.append("Fence segments: %d" % n)

    # 7. trees ----------------------------------------------------------------
    if BUILD_TREES and site["trees"]:
        plants = list(FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Planting)
                      .OfClass(FamilySymbol).ToElements())
        if plants:
            sym = plants[0]
            if not sym.IsActive:
                sym.Activate()
                doc.Regenerate()
            n = 0
            for x, y in site["trees"]:
                try:
                    z = idw(ground_pts, x, y)
                    inst = doc.Create.NewFamilyInstance(P(x, y, 0), sym, ground_level, StructuralType.NonStructural)
                    if not set_param(inst, BuiltInParameter.INSTANCE_ELEVATION_PARAM, ft(z)):
                        set_param(inst, BuiltInParameter.INSTANCE_FREE_HOST_OFFSET_PARAM, ft(z))
                    n += 1
                except Exception as e:
                    failed("tree", e)
            report.append("Trees: %d (%s)" % (n, tname(sym)))
        else:
            report.append("Trees skipped: no planting family loaded (Insert > Load Family > Planting)")

    # 8. views ----------------------------------------------------------------
    doc.Regenerate()
    try:
        site_plan.CropBoxActive = True
        bb = BoundingBoxXYZ()
        bb.Min = P(x0, y0, -50)
        bb.Max = P(x1, y1, 200)
        site_plan.CropBox = bb
        site_plan.Scale = 1000
    except Exception as e:
        failed("site plan crop", e)

    vft3d = [t for t in collect(ViewFamilyType) if t.ViewFamily == ViewFamily.ThreeDimensional][0]
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    w, h = x1 - x0, y1 - y0
    zc = idw(ground_pts, cx, cy)
    target = P(cx, cy, zc + 4)
    eye_z = zc + 1.7
    shots = [
        (P(x0 - 0.05 * w, y0 - 0.05 * h, eye_z + 6), u"منظور 1 - جنوب غرب"),
        (P(x1 + 0.05 * w, y0 - 0.05 * h, eye_z + 6), u"منظور 2 - جنوب شرق"),
        (P(x1 + 0.05 * w, y1 + 0.05 * h, eye_z + 6), u"منظور 3 - شمال شرق"),
        (P(x0 - 0.05 * w, y1 + 0.05 * h, eye_z + 6), u"منظور 4 - شمال غرب"),
        (P(x0 - 0.6 * w, y0 - 0.8 * h, zc + 0.9 * max(w, h)), u"منظور 5 - جوي"),
    ]
    views = [perspective(vft3d, eye, target, name) for eye, name in shots]
    iso = View3D.CreateIsometric(doc, vft3d.Id)
    try_name(iso, u"3D - الموقع")
    try:
        iso.DisplayStyle = DisplayStyle.Realistic
    except Exception:
        pass
    report.append("Views: site plan, 3D overview, %d perspectives" % len(views))

    # 9. sheets ---------------------------------------------------------------
    tb = list(FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks)
              .WhereElementIsElementType().ToElements())
    if tb:
        def new_sheet(number, name):
            sh = ViewSheet.Create(doc, tb[0].Id)
            try:
                sh.SheetNumber = number
            except Exception:
                pass
            try_name(sh, name)
            return sh

        def centre(sh):
            o = sh.Outline
            return XYZ((o.Min.U + o.Max.U) / 2, (o.Min.V + o.Max.V) / 2, 0)

        made = []
        for number, name, vlist in (("A-101", SITE_PLAN_NAME, [site_plan]),
                                    ("A-301", u"المنظور الجوي", [views[-1]]),
                                    ("A-302", u"المناظير", views[:4])):
            try:
                sh = new_sheet(number, name)
                c = centre(sh)
                if len(vlist) == 1:
                    Viewport.Create(doc, sh.Id, vlist[0].Id, c)
                else:
                    o = sh.Outline
                    dx, dy = (o.Max.U - o.Min.U) / 4, (o.Max.V - o.Min.V) / 4
                    for v, (sx, sy) in zip(vlist, ((-1, 1), (1, 1), (-1, -1), (1, -1))):
                        Viewport.Create(doc, sh.Id, v.Id, XYZ(c.X + sx * dx, c.Y + sy * dy, 0))
                made.append(number)
            except Exception as e:
                failed("sheet " + number, e)
        report.append("Sheets: " + ", ".join(made))
    else:
        report.append("No title block loaded, sheets skipped")

except Exception as e:
    report.append("ERROR: %s" % e)

TransactionManager.Instance.TransactionTaskDone()
report.append("Elements: %d walls, %d floors" % (counts["walls"], counts["floors"]))
if counts["failed"]:
    report.append("Skipped %d elements Revit refused; first ones:" % counts["failed"])
    report.extend(failures)
if site.get("assumed_heights"):
    report.append("Building heights are assumed (floors x %.1f m); edit them with --floors in site_to_revit.py" % fh)
OUT = report
