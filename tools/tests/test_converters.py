"""Converter tests on made-up drawings. Run: python3 -m unittest discover tools/tests"""
import json, os, subprocess, sys, tempfile, unittest
import ezdxf

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*args):
    subprocess.run([sys.executable, *args], check=True, capture_output=True, text=True)


class DxfToModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        dxf = os.path.join(cls.tmp.name, "sample.dxf")
        out = os.path.join(cls.tmp.name, "out", "model.json")  # folder does not exist yet
        run(os.path.join(TOOLS, "make_sample_dxf.py"), dxf)
        run(os.path.join(TOOLS, "dxf_to_model.py"), dxf, out, "Sample site")
        with open(out, encoding="utf-8") as f:
            cls.model = json.load(f)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_name_is_kept(self):
        self.assertEqual(self.model["name"], "Sample site")

    def test_every_building_type_is_read(self):
        houses = self.model["meshes"]["3D-HOUSES"]["items"]
        # 34 polyface boxes and block references, 6 pitched 3DFACE houses, 1 stepped MESH
        self.assertEqual(len(houses), 41)
        self.assertEqual(sorted({h[2] for h in houses}), [7.0, 9.5, 10.0])
        self.assertEqual(len(self.model["meshes"]["3D-PUBLIC"]["items"]), 3)

    def test_footprint_area_for_flat_pitched_and_stepped_roofs(self):
        for first, count, height, area in self.model["meshes"]["3D-HOUSES"]["items"]:
            self.assertAlmostEqual(area, 320.0, delta=0.5, msg=f"height {height}")

    def test_floor_height_and_arabic_labels(self):
        self.assertEqual(self.model["floorHeight"], 3.2)
        texts = {l["t"] for l in self.model["labels"]}
        self.assertIn("حديقة الحي", texts)
        self.assertTrue({"MOSQ", "SCH", "CLN", "DISTRICT1"} <= texts)


class PlanToModel(unittest.TestCase):
    """A 2D plan: buildings drawn as loose LINEs, with a double wall, a small gap and a stray line."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        doc = ezdxf.new("R2010")
        msp = doc.modelspace()

        def rect(x, y, w, d, layer, gap=0.0):
            pts = [(x, y), (x + w, y), (x + w, y + d), (x, y + d)]
            for i in range(4):
                a, b = pts[i], pts[(i + 1) % 4]
                if gap and i == 3:  # leave the last side short
                    b = (b[0], b[1] + gap)
                msp.add_line(a, b, dxfattribs={"layer": layer})

        rect(0, 0, 20, 10, "SC-BUILDING")  # 200 m²
        rect(0.3, 0.3, 19.4, 9.4, "SC-BUILDING")  # inner wall line: same building
        rect(40, 0, 10, 10, "PROPOSED BUILDING", gap=0.3)  # 100 m² with a 30 cm gap
        msp.add_line((0, 30), (50, 30), dxfattribs={"layer": "SC-BUILDING"})  # stray line: no building
        rect(70, 0, 8, 4, "SC-SHED")  # 32 m²
        msp.add_line((0, -10), (80, -10), dxfattribs={"layer": "SC-ASPHALT-ROAD"})
        doc.blocks.new("T")
        msp.add_blockref("T", (60, 20), dxfattribs={"layer": "SC-TREE"})
        msp.add_text("021", height=1, dxfattribs={"layer": "EXIST-NAME", "insert": (8, 4)})
        msp.add_text("021", height=1, dxfattribs={"layer": "EXIST-NAME", "insert": (9, 4)})  # duplicate
        cls.dxf = os.path.join(cls.tmp.name, "plan.dxf")
        doc.saveas(cls.dxf)
        out = os.path.join(cls.tmp.name, "model.json")
        run(os.path.join(TOOLS, "plan_to_model.py"), cls.dxf, out, "Plan", "--bbox", "-5", "-20", "90", "40")
        with open(out, encoding="utf-8") as f:
            cls.model = json.load(f)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def areas(self, group):
        return sorted(round(i[3]) for i in self.model["meshes"].get(group, {"items": []})["items"])

    def test_buildings_from_loose_lines(self):
        self.assertEqual(self.areas("existing"), [200])
        self.assertEqual(self.areas("proposed"), [100])
        self.assertEqual(self.areas("sheds"), [32])

    def test_assumed_heights_are_marked(self):
        self.assertTrue(self.model["assumedHeights"])
        self.assertEqual(self.model["meshes"]["sheds"]["items"][0][2], 6.0)

    def test_roof_faces_up(self):
        m = self.model["meshes"]["existing"]
        pos, idx = m["positions"], m["indices"]
        ups = 0
        for t in range(0, len(idx), 3):
            a, b, c = (pos[3 * i: 3 * i + 3] for i in idx[t: t + 3])
            if a[1] == b[1] == c[1] > 0:  # roof triangle
                # normal y of (b - a) x (c - a) in the viewer's Y-up frame
                ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2])
                self.assertGreater(ny, 0)
                ups += 1
        self.assertGreater(ups, 0)

    def test_lines_trees_and_codes(self):
        self.assertIn("plan", self.model["lines"])
        self.assertEqual(len(self.model["trees"]), 2)
        self.assertEqual([c["t"] for c in self.model["codes"]], ["021"])


if __name__ == "__main__":
    unittest.main()
