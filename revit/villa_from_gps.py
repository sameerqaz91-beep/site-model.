# -*- coding: utf-8 -*-
"""
Villa starter model for Revit (Dynamo Python Script node)
=========================================================
Builds, in the open Revit project:
  1. Levels  : ground floor, first floor, roof
  2. Grids   : A, B, C ... / 1, 2, 3 ...
  3. Walls   : exterior + interior walls on every floor, parapet on the roof
  4. Floors  : a slab on every level (the roof slab included)
  5. Doors / windows (if the project has door/window families loaded)
  6. Links the site DWG (GPS.dwg) into the ground floor plan
  7. Five realistic perspective views (4 eye-level corners + 1 aerial)
  8. A sheet holding the aerial perspective

How to run (Revit 2022 or newer):
  Manage > Dynamo > New > add a "Python Script" node > paste this file >
  set the node engine to CPython3 > connect a "File Path" node pointing to
  GPS.dwg into IN[0] (optional) > Run.

All sizes below are in METERS. Change them, then run again on a fresh project.
"""

# ---------------------------------------------------------------- settings ---
DWG_PATH        = r"C:\Projects\GPS.dwg"   # used when IN[0] is not connected
DWG_UNITS       = "Meter"      # units the DWG was drawn in: Meter / Millimeter / Foot
DWG_PLACEMENT   = "Centered"   # Centered (recommended for GPS/UTM drawings) / Origin

WIDTH           = 20.0   # building length along X (m)
DEPTH           = 15.0   # building depth along Y (m)
FLOOR_HEIGHT    = 3.5    # floor-to-floor height (m)
FLOORS          = 2      # number of floors (roof is added on top)
PARAPET         = 1.2    # roof parapet height (m)
GRID_SPACING_X  = 5.0    # grid spacing along X (m)
GRID_SPACING_Y  = 7.5    # grid spacing along Y (m)
WINDOW_SPACING  = 4.0    # distance between windows on long facades (m)
SILL_HEIGHT     = 0.9    # window sill height (m)

LEVEL_NAMES = [u"الدور الأرضي", u"الدور الأول", u"الدور الثاني", u"الدور الثالث"]
ROOF_NAME   = u"السطح"

# ------------------------------------------------------------------ imports ---
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
        DWG_PATH = str(IN[0])
except NameError:
    pass


# ------------------------------------------------------------------ helpers ---
def ft(meters):
    """meters -> Revit internal feet"""
    return meters / 0.3048


def P(x, y, z=0.0):
    return XYZ(ft(x), ft(y), ft(z))


def collect(cls):
    return list(FilteredElementCollector(doc).OfClass(cls).ToElements())


def try_name(element, name):
    try:
        element.Name = name
    except Exception:
        pass


def pick_type(types, *keywords):
    for kw in keywords:
        for t in types:
            if kw.lower() in t.Name.lower():
                return t
    return types[0] if types else None


def get_or_create_level(elev_m, name):
    for lv in collect(Level):
        if abs(lv.Elevation - ft(elev_m)) < 0.01:
            try_name(lv, name)
            return lv
    lv = Level.Create(doc, ft(elev_m))
    try_name(lv, name)
    return lv


def get_or_create_plan(level):
    for v in collect(ViewPlan):
        if (not v.IsTemplate and v.GenLevel is not None
                and v.GenLevel.Id == level.Id
                and v.ViewType == ViewType.FloorPlan):
            return v
    vft = [t for t in collect(ViewFamilyType) if t.ViewFamily == ViewFamily.FloorPlan][0]
    return ViewPlan.Create(doc, vft.Id, level.Id)


def rect_lines(x0, y0, x1, y1, z=0.0):
    pts = [P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)]
    return [Line.CreateBound(pts[i], pts[(i + 1) % 4]) for i in range(4)]


def link_dwg(path, view):
    opts = DWGImportOptions()
    opts.ColorMode = ImportColorMode.Preserved
    opts.ThisViewOnly = False
    opts.Unit = getattr(ImportUnit, DWG_UNITS, ImportUnit.Default)
    opts.Placement = getattr(ImportPlacement, DWG_PLACEMENT, ImportPlacement.Centered)
    try:                                   # IronPython 2
        ref = clr.Reference[ElementId]()
        doc.Link(path, opts, view, ref)
        return ref.Value
    except AttributeError:                 # CPython 3 (pythonnet): out param -> tuple
        res = doc.Link(path, opts, view, ElementId.InvalidElementId)
        return res[1] if isinstance(res, tuple) else None


def perspective(vft3d, eye, target, name):
    v = View3D.CreatePerspective(doc, vft3d.Id)
    forward = (target - eye).Normalize()
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


# --------------------------------------------------------------------- build --
TransactionManager.Instance.EnsureInTransaction(doc)
try:
    # 1. levels ---------------------------------------------------------------
    levels = []
    for i in range(FLOORS):
        name = LEVEL_NAMES[i] if i < len(LEVEL_NAMES) else u"الدور %d" % i
        levels.append(get_or_create_level(i * FLOOR_HEIGHT, name))
    roof = get_or_create_level(FLOORS * FLOOR_HEIGHT, ROOF_NAME)
    plans = [get_or_create_plan(lv) for lv in levels + [roof]]
    report.append("Levels: %d + roof" % FLOORS)

    # 2. grids ----------------------------------------------------------------
    ext = 2.0
    nx = int(round(WIDTH / GRID_SPACING_X))
    ny = int(round(DEPTH / GRID_SPACING_Y))
    for i in range(nx + 1):
        x = i * WIDTH / nx
        g = Grid.Create(doc, Line.CreateBound(P(x, -ext), P(x, DEPTH + ext)))
        try_name(g, str(i + 1))
    for j in range(ny + 1):
        y = j * DEPTH / ny
        g = Grid.Create(doc, Line.CreateBound(P(-ext, y), P(WIDTH + ext, y)))
        try_name(g, chr(ord("A") + j))
    report.append("Grids: %d x %d" % (nx + 1, ny + 1))

    # 3. walls ----------------------------------------------------------------
    wall_types = [w for w in collect(WallType) if w.Kind == WallKind.Basic]
    ext_type = pick_type(wall_types, "Exterior", "Generic - 300", "Generic - 2")
    int_type = pick_type(wall_types, "Interior", "Generic - 150", "Generic - 1")
    y_mid = DEPTH * 0.55
    facades = []          # (south_wall, north_wall, level) per floor
    for lv in levels:
        ext_walls = [Wall.Create(doc, ln, ext_type.Id, lv.Id, ft(FLOOR_HEIGHT), 0, False, False)
                     for ln in rect_lines(0, 0, WIDTH, DEPTH)]
        facades.append((ext_walls[0], ext_walls[2], lv))
        for a, b in [((0, y_mid), (WIDTH, y_mid)),
                     ((WIDTH * 0.4, 0), (WIDTH * 0.4, y_mid)),
                     ((WIDTH * 0.7, y_mid), (WIDTH * 0.7, DEPTH))]:
            Wall.Create(doc, Line.CreateBound(P(*a), P(*b)), int_type.Id, lv.Id,
                        ft(FLOOR_HEIGHT), 0, False, False)
    for ln in rect_lines(0, 0, WIDTH, DEPTH):
        Wall.Create(doc, ln, ext_type.Id, roof.Id, ft(PARAPET), 0, False, False)
    report.append("Walls: exterior=%s, interior=%s" % (ext_type.Name, int_type.Name))

    # 4. floors ---------------------------------------------------------------
    floor_types = [f for f in collect(FloorType) if not f.IsFoundationSlab]
    floor_type = pick_type(floor_types, "Generic", "Concrete")
    for lv in levels + [roof]:
        loop = CurveLoop()
        for ln in rect_lines(0, 0, WIDTH, DEPTH):
            loop.Append(ln)
        Floor.Create(doc, List[CurveLoop]([loop]), floor_type.Id, lv.Id)
    report.append("Floors: %d slabs (%s)" % (len(levels) + 1, floor_type.Name))

    # 5. doors & windows ------------------------------------------------------
    def symbols(cat):
        s = list(FilteredElementCollector(doc).OfCategory(cat)
                 .OfClass(FamilySymbol).ToElements())
        for x in s:
            if not x.IsActive:
                x.Activate()
        return s

    doors = symbols(BuiltInCategory.OST_Doors)
    windows = symbols(BuiltInCategory.OST_Windows)
    n_doors = n_windows = 0
    if doors:
        south_gf = facades[0][0]
        doc.Create.NewFamilyInstance(P(WIDTH / 2, 0), doors[0], south_gf, levels[0],
                                     StructuralType.NonStructural)
        n_doors += 1
    if windows:
        count = int(WIDTH // WINDOW_SPACING)
        for fi, (south, north, lv) in enumerate(facades):
            for k in range(count):
                x = WINDOW_SPACING / 2 + k * WINDOW_SPACING
                for wall, y in ((south, 0), (north, DEPTH)):
                    if fi == 0 and wall is south and abs(x - WIDTH / 2) < 1.5:
                        continue           # keep the entrance clear
                    inst = doc.Create.NewFamilyInstance(
                        P(x, y, fi * FLOOR_HEIGHT), windows[0], wall, lv,
                        StructuralType.NonStructural)
                    p = inst.get_Parameter(BuiltInParameter.INSTANCE_SILL_HEIGHT_PARAM)
                    if p and not p.IsReadOnly:
                        p.Set(ft(SILL_HEIGHT))
                    n_windows += 1
    report.append("Doors: %d, windows: %d" % (n_doors, n_windows))

    # 6. site DWG -------------------------------------------------------------
    if DWG_PATH and os.path.exists(DWG_PATH):
        link_id = link_dwg(DWG_PATH, plans[0])
        report.append("DWG linked: %s (id %s)" % (DWG_PATH, link_id))
    else:
        report.append("DWG NOT found, skipped: %s" % DWG_PATH)

    # 7. perspectives ---------------------------------------------------------
    vft3d = [t for t in collect(ViewFamilyType)
             if t.ViewFamily == ViewFamily.ThreeDimensional][0]
    H = FLOORS * FLOOR_HEIGHT
    target = P(WIDTH / 2, DEPTH / 2, H / 2)
    d = 1.6 * max(WIDTH, DEPTH)
    shots = [
        (P(-d * 0.6, -d, 1.7),           u"منظور 1 - جنوب غرب"),
        (P(WIDTH + d * 0.6, -d, 1.7),    u"منظور 2 - جنوب شرق"),
        (P(WIDTH + d * 0.6, DEPTH + d, 1.7), u"منظور 3 - شمال شرق"),
        (P(-d * 0.6, DEPTH + d, 1.7),    u"منظور 4 - شمال غرب"),
        (P(-d, -d * 1.2, H + 30),        u"منظور 5 - جوي"),
    ]
    views = [perspective(vft3d, eye, target, name) for eye, name in shots]
    iso = View3D.CreateIsometric(doc, vft3d.Id)
    try_name(iso, u"3D - عام")
    report.append("Perspective views: %d + 1 isometric" % len(views))

    # 8. sheet ----------------------------------------------------------------
    tb = list(FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_TitleBlocks)
              .WhereElementIsElementType().ToElements())
    if tb:
        sheet = ViewSheet.Create(doc, tb[0].Id)
        sheet.SheetNumber = "A-301"
        try_name(sheet, u"المناظير")
        Viewport.Create(doc, sheet.Id, views[-1].Id, XYZ(ft(0.42), ft(0.3), 0))
        report.append("Sheet A-301 created")
    else:
        report.append("No title block loaded, sheet skipped")

except Exception as e:
    report.append("ERROR: %s" % e)

TransactionManager.Instance.TransactionTaskDone()
OUT = report
