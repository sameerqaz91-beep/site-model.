import { describe, expect, it } from "vitest";
import { buildModel, buildingAt, type RawModel } from "../model";

// Two unit boxes (12 triangles each would be the real thing; two triangles per "building" is enough here).
function raw(extra: Partial<RawModel> = {}): RawModel {
  const square = (x: number) => [x, 0, 0, x + 10, 0, 0, x + 10, 0, 10, x, 0, 10];
  return {
    units: "m",
    size: [100, 50],
    meshes: {
      existing: { positions: [...square(0), ...square(30)], indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], items: [[0, 6, 4.5, 100], [6, 6, 4.5, 100]] },
      proposed: { positions: square(60), indices: [0, 1, 2, 0, 2, 3], items: [[0, 6, 6, 100]] },
    },
    lines: { floors: [[0, 0, 10, 0]] },
    fills: [],
    labels: [{ t: "حديقة", x: 0, z: 0, h: 1 }, { t: "GATE", x: 0, z: 0, h: 1 }],
    ...extra,
  };
}

describe("buildModel", () => {
  it("makes one group per mesh key, in order, with labels and colours", () => {
    const m = buildModel(raw({ meshLabels: { existing: "مبانٍ قائمة" } }));
    expect(m.groups.map((g) => [g.kind, g.label, g.colorIndex])).toEqual([["existing", "مبانٍ قائمة", 0], ["proposed", "proposed", 1]]);
    expect(m.stats.groups.map((g) => g.count)).toEqual([2, 1]);
    expect(m.stats.builtArea).toBe(300);
  });

  it("uses converter codes when given, and matches them to any building", () => {
    const m = buildModel(raw({ codes: [{ t: "021", x: 35, z: 5, h: 1 }] }));
    expect(m.codes.map((c) => c.text)).toEqual(["021"]);
    expect(m.groups[0].buildings.map((b) => b.code)).toEqual([null, "021"]);
  });

  it("falls back to upper-case labels as codes, and keeps Arabic labels as names", () => {
    const m = buildModel(raw());
    expect(m.codes.map((c) => c.text)).toEqual(["GATE"]);
    expect(m.names.map((c) => c.text)).toEqual(["حديقة"]);
  });

  it("puts floor lines at the drawing's height, or 3.5 m", () => {
    const y = (m: ReturnType<typeof buildModel>) => m.lines.floors.getAttribute("position").getY(0);
    expect(y(buildModel(raw()))).toBe(3.5);
    expect(y(buildModel(raw({ floorHeight: 3.2 })))).toBeCloseTo(3.2);
  });

  it("reads trees and the assumed-heights flag", () => {
    const m = buildModel(raw({ trees: [1, 2, 3, 4], assumedHeights: true }));
    expect(m.trees.length).toBe(4);
    expect(m.assumedHeights).toBe(true);
  });
});

describe("buildingAt", () => {
  it("finds the building that owns a triangle", () => {
    const g = buildModel(raw()).groups[0];
    expect(buildingAt(g, 0)?.id).toBe(0);
    expect(buildingAt(g, 1)?.id).toBe(0);
    expect(buildingAt(g, 2)?.id).toBe(1);
    expect(buildingAt(g, 9)).toBeNull();
  });
});
