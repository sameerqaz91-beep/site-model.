"""Tests for the Revit site pipeline: the DXF extractor, and the Dynamo script run against a fake Revit API.

Run: python3 -m pytest revit/tests      (needs: pip install ezdxf shapely pytest)
The drawings used here are made up; the real site plan stays out of the repository.
"""
import json, os, sys, types

import ezdxf
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REVIT = os.path.dirname(HERE)
sys.path.insert(0, REVIT)
import site_to_revit  # noqa: E402

E0, N0 = 650000.0, 2369000.0  # a made-up UTM spot


def make_dxf(path):
    doc = ezdxf.new()
    msp = doc.modelspace()

    def rect(x, y, w, h, layer):
        msp.add_lwpolyline([(E0 + x, N0 + y), (E0 + x + w, N0 + y), (E0 + x + w, N0 + y + h), (E0 + x, N0 + y + h)],
                           close=True, dxfattribs={"layer": layer})

    rect(10, 10, 20, 12, "SC-BUILDING")              # existing building, number 008
    msp.add_text("008", dxfattribs={"layer": "bldg_tag", "insert": (E0 + 18, N0 + 15)})
    for (ax, ay), (bx, by) in (((40, 10), (55, 10)), ((55, 10), (55, 20)), ((55, 20), (40, 20)), ((40, 20), (40, 10))):
        msp.add_line((E0 + ax, N0 + ay), (E0 + bx, N0 + by), dxfattribs={"layer": "PROPOSED BUILDING"})
    rect(70, 10, 8, 6, "SC-SHED")
    blk = doc.blocks.new("HUT")                      # a building drawn as a block
    blk.add_lwpolyline([(0, 0), (6, 0), (6, 5), (0, 5)], close=True)
    msp.add_blockref("HUT", (E0 + 70, N0 + 40), dxfattribs={"layer": "00000buildyy"})
    msp.add_lwpolyline([(E0 + 0, N0 + 0), (E0 + 100, N0 + 0), (E0 + 100, N0 + 60)], dxfattribs={"layer": "SC-FENCE"})
    for i, (x, y) in enumerate(((5, 5), (95, 5), (95, 55), (5, 55), (50, 30))):
        msp.add_text("%.2f" % (1550 + i * 0.5), dxfattribs={"layer": "FGL-PNTS", "insert": (E0 + x, N0 + y)})
    msp.add_text("1100.00", dxfattribs={"layer": "FGL-PNTS", "insert": (E0 + 50, N0 + 50)})  # stray value
    msp.add_blockref("HUT", (E0 + 90, N0 + 50), dxfattribs={"layer": "SC-TREE"})
    doc.saveas(path)


@pytest.fixture(scope="module")
def site(tmp_path_factory):
    d = tmp_path_factory.mktemp("site")
    make_dxf(str(d / "plan.dxf"))
    out = d / "site.json"
    site_to_revit.main([str(d / "plan.dxf"), str(out), "--bbox", str(E0), str(N0), str(E0 + 100), str(N0 + 60),
                        "--name", "test", "--floors", "008=3"])
    with open(out, encoding="utf-8") as f:
        return json.load(f), str(out)


def test_extractor(site):
    data, _ = site
    assert data["origin"] == {"easting": E0 + 50, "northing": N0 + 30}
    assert data["base_elev"] == 1551.0          # median of the five spot heights; 1100 is dropped
    groups = sorted(b["group"] for b in data["buildings"])
    assert groups == ["existing", "proposed", "proposed", "sheds"]
    b008 = next(b for b in data["buildings"] if b["code"] == "008")
    assert b008["floors"] == 3 and b008["height"] == 3 * 3.5 + 0.6
    assert abs(b008["area"] - 240) < 1
    hut = next(b for b in data["buildings"] if abs(b["area"] - 30) < 1)
    assert hut["group"] == "proposed"           # block on 00000buildyy
    assert len(data["fences"]) == 1 and len(data["trees"]) == 1
    assert len(data["ground"]) == 5 + 8          # spot heights plus bbox corners and edge midpoints
    for b in data["buildings"]:                  # outlines are relative to the origin
        assert all(-60 <= x <= 60 and -40 <= y <= 40 for x, y in b["outline"])


# ------------------------------------------------------------------ fake Revit API for build_site.py ---
class Obj:
    """Anything: every attribute and call gives another Obj, so unmodelled API calls do not fail."""

    def __init__(self, *a, **k):
        self.args = a

    def __getattr__(self, name):
        return Obj()

    def __call__(self, *a, **k):
        return Obj()

    def __iter__(self):
        return iter([])

    def __bool__(self):
        return True


class XYZ:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.X, self.Y, self.Z = x, y, z

    def Subtract(self, o):
        return XYZ(self.X - o.X, self.Y - o.Y, self.Z - o.Z)

    def Normalize(self):
        n = (self.X ** 2 + self.Y ** 2 + self.Z ** 2) ** 0.5 or 1
        return XYZ(self.X / n, self.Y / n, self.Z / n)

    def CrossProduct(self, o):
        return XYZ(self.Y * o.Z - self.Z * o.Y, self.Z * o.X - self.X * o.Z, self.X * o.Y - self.Y * o.X)


XYZ.Zero = XYZ()
XYZ.BasisZ = XYZ(0, 0, 1)


def make_api():
    created = {"walls": [], "floors": [], "levels": [], "topo": [], "sheets": [], "views": []}

    class Named(Obj):
        def __init__(self, name="", **kw):
            self.Name = name
            self.__dict__.update(kw)

        def Duplicate(self, name):
            return type(self)(name)

    class WallType(Named):
        Kind = "Basic"

    class FloorType(Named):
        IsFoundationSlab = False

    class Level(Named):
        @staticmethod
        def Create(doc, elev):
            lv = Level(Elevation=elev, Id=Obj())
            created["levels"].append(lv)
            return lv

    class ViewFamilyType(Named):
        pass

    pool = {WallType: [WallType("Generic - 200mm")], FloorType: [FloorType("Generic 150mm")],
            Level: [], ViewFamilyType: [ViewFamilyType("3D", ViewFamily="ThreeDimensional", Id=Obj()),
                                        ViewFamilyType("Floor Plan", ViewFamily="FloorPlan", Id=Obj())]}

    class Collector:
        def __init__(self, doc):
            self.cls = None

        def OfClass(self, cls):
            self.cls = cls
            return self

        def OfCategory(self, cat):
            return self

        def WhereElementIsElementType(self):
            return self

        def ToElements(self):
            if self.cls is Level:
                return list(created["levels"])
            return list(pool.get(self.cls, []))

    class Wall:
        @staticmethod
        def Create(doc, line, type_id, level_id, height, offset, flip, structural):
            created["walls"].append((line, height, offset))
            return Obj()

    class Floor:
        @staticmethod
        def Create(doc, loops, type_id, level_id):
            created["floors"].append(loops)
            return Obj()

    class Line:
        @staticmethod
        def CreateBound(a, b):
            if abs(a.X - b.X) + abs(a.Y - b.Y) + abs(a.Z - b.Z) < 0.003:
                raise ValueError("curve too short")
            return (a, b)

    class CurveLoop(list):
        def Append(self, c):
            self.append(c)

    class Toposolid:
        @staticmethod
        def Create(doc, pts, type_id, level_id):
            created["topo"].append(list(pts))
            return Obj()

    class ViewSheet:
        @staticmethod
        def Create(doc, tb):
            created["sheets"].append(tb)
            return Obj(Outline=Obj())

    class View3D:
        @staticmethod
        def CreatePerspective(doc, vft):
            created["views"].append("persp")
            return Obj()

        @staticmethod
        def CreateIsometric(doc, vft):
            created["views"].append("iso")
            return Obj()

    db = types.ModuleType("Autodesk.Revit.DB")
    for name in ("ProjectPosition", "ViewPlan", "Material", "Color", "FillPatternElement", "CompoundStructure",
                 "MaterialFunctionAssignment", "BuiltInParameter", "ElementId", "ViewType", "ViewFamily",
                 "ViewOrientation3D", "DisplayStyle", "ViewDetailLevel", "BuiltInCategory", "FamilySymbol",
                 "BoundingBoxXYZ", "TopographySurface", "Viewport", "WallKind", "ToposolidType"):
        setattr(db, name, Obj())
    db.WallKind = types.SimpleNamespace(Basic="Basic")
    db.ViewFamily = types.SimpleNamespace(ThreeDimensional="ThreeDimensional", FloorPlan="FloorPlan")
    db.ToposolidType = Named
    pool[db.ToposolidType] = [Named("Toposolid", Id=Obj())]
    for cls in (XYZ, WallType, FloorType, Level, ViewFamilyType, Wall, Floor, Line, CurveLoop, Toposolid, ViewSheet,
                View3D):
        setattr(db, cls.__name__, cls)
    db.FilteredElementCollector = Collector
    db.__all__ = [n for n in dir(db) if not n.startswith("_")]
    return db, created


def test_build_site_runs(site, monkeypatch):
    _, path = site
    db, created = make_api()
    autodesk = types.ModuleType("Autodesk")
    revit = types.ModuleType("Autodesk.Revit")
    structure = types.ModuleType("Autodesk.Revit.DB.Structure")
    structure.StructuralType = Obj()
    services = types.ModuleType("RevitServices")
    persistence = types.ModuleType("RevitServices.Persistence")
    persistence.DocumentManager = Obj()
    transactions = types.ModuleType("RevitServices.Transactions")
    transactions.TransactionManager = Obj()
    system = types.ModuleType("System")
    generic = types.ModuleType("System.Collections.Generic")
    class NetList(list):  # System.Collections.Generic.List[T]
        Add = list.append

        @property
        def Count(self):
            return len(self)

    class ListOf:
        def __getitem__(self, t):
            return lambda items=(): NetList(items)

    generic.List = ListOf()
    clr = types.ModuleType("clr")
    clr.AddReference = lambda name: None
    for name, mod in {"clr": clr, "System": system, "System.Collections": types.ModuleType("System.Collections"),
                      "System.Collections.Generic": generic, "Autodesk": autodesk, "Autodesk.Revit": revit,
                      "Autodesk.Revit.DB": db, "Autodesk.Revit.DB.Structure": structure,
                      "RevitServices": services, "RevitServices.Persistence": persistence,
                      "RevitServices.Transactions": transactions}.items():
        monkeypatch.setitem(sys.modules, name, mod)

    scope = {"IN": [path], "__name__": "__dynamo__"}
    with open(os.path.join(REVIT, "build_site.py"), encoding="utf-8") as f:
        exec(compile(f.read(), "build_site.py", "exec"), scope)
    report = scope["OUT"]
    assert not any(line.startswith(("ERROR", "Skipped")) for line in report), report
    assert len(created["levels"]) == 4             # building 008 has 3 floors: levels 0-3
    assert len(created["topo"]) == 1 and len(created["topo"][0]) == 13
    building_walls = [w for w in created["walls"] if w[1] > 3.0 / 0.3048]
    assert len(building_walls) >= 4 * 3            # four corners each for the 3 multi-wall buildings at least
    assert len(created["floors"]) >= 3 + 1 + 1 + 1  # 008: 3 slabs + roof; the others a roof each
    assert created["views"].count("persp") == 5
