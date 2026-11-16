import * as THREE from "three";

// Shape of the JSON produced by tools/dxf_to_model.py (Y-up, metres, centred on the site).
export interface RawMesh {
  positions: number[];
  indices: number[];
  items: [first: number, count: number, height: number, area: number][];
}
export interface RawModel {
  name?: string;
  units: string;
  size: [number, number];
  meshes: Record<string, RawMesh>;
  lines: Record<string, number[][]>;
  fills: number[][];
  labels: { t: string; x: number; z: number; h: number }[];
}

export type Kind = "house" | "public";

export interface Building {
  id: number;
  kind: Kind;
  first: number;
  count: number;
  height: number;
  area: number;
  center: THREE.Vector3;
  code: string | null; // nearest code label from the drawing (public buildings only)
}

export interface Group {
  kind: Kind;
  geometry: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
  buildings: Building[];
}

export interface Model {
  name: string;
  size: [number, number];
  groups: Group[];
  lines: Record<string, THREE.BufferGeometry>;
  fills: THREE.BufferGeometry | null;
  codes: { text: string; position: THREE.Vector3 }[];
  stats: { houses: number; publics: number; houseArea: number; publicArea: number };
}

// Building-type codes and district names are upper-case words; plot numbers are left out.
const CODE = /^[A-Z]{1,8}\d?$/;

export function buildModel(raw: RawModel): Model {
  const codes = raw.labels
    .filter((l) => CODE.test(l.t))
    .map((l) => ({ text: l.t, position: new THREE.Vector3(l.x, 0, l.z) }));

  const groups: Group[] = [];
  let nextId = 0;
  for (const [layer, kind] of [["3D-HOUSES", "house"], ["3D-PUBLIC", "public"]] as const) {
    const m = raw.meshes[layer];
    if (!m) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
    geometry.setIndex(m.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const pos = geometry.getAttribute("position");
    const buildings = m.items.map(([first, count, height, area]) => {
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (let i = first; i < first + count; i++) box.expandByPoint(v.fromBufferAttribute(pos, m.indices[i]));
      const center = box.getCenter(new THREE.Vector3());
      let code: string | null = null;
      if (kind === "public") {
        let best = 45; // metres: a label further than this belongs to another building
        for (const c of codes) {
          const d = Math.hypot(c.position.x - center.x, c.position.z - center.z);
          if (d < best && !c.text.startsWith("DISTRICT")) { best = d; code = c.text; }
        }
      }
      return { id: nextId++, kind, first, count, height, area, center, code } as Building;
    });
    groups.push({ kind, geometry, edges: new THREE.EdgesGeometry(geometry, 30), buildings });
  }

  const lines: Record<string, THREE.BufferGeometry> = {};
  for (const [name, polys] of Object.entries(raw.lines)) {
    const y = name === "floors" ? 3.5 : 0.06;
    const seg: number[] = [];
    for (const p of polys) {
      for (let i = 0; i + 3 < p.length; i += 2) seg.push(p[i], y, p[i + 1], p[i + 2], y, p[i + 3]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
    lines[name] = g;
  }

  let fills: THREE.BufferGeometry | null = null;
  if (raw.fills.length) {
    const shapes = raw.fills.map((p) => {
      const s = new THREE.Shape();
      // Shape lives in the XY plane; rotate it onto the ground later. Flip z so it lines up after rotation.
      for (let i = 0; i < p.length; i += 2) (i ? s.lineTo(p[i], -p[i + 1]) : s.moveTo(p[i], -p[i + 1]));
      return s;
    });
    fills = new THREE.ShapeGeometry(shapes);
    fills.rotateX(-Math.PI / 2);
    fills.translate(0, 0.03, 0);
  }

  const sum = (k: Kind) => groups.filter((g) => g.kind === k).flatMap((g) => g.buildings);
  const houses = sum("house");
  const publics = sum("public");
  return {
    name: raw.name ?? "",
    size: raw.size,
    groups,
    lines,
    fills,
    codes,
    stats: {
      houses: houses.length,
      publics: publics.length,
      houseArea: houses.reduce((a, b) => a + b.area, 0),
      publicArea: publics.reduce((a, b) => a + b.area, 0),
    },
  };
}

// Which building owns a triangle hit by the raycaster (faceIndex → index-buffer offset).
export function buildingAt(group: Group, faceIndex: number): Building | null {
  const offset = faceIndex * 3;
  const list = group.buildings;
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = list[mid];
    if (offset < b.first) hi = mid - 1;
    else if (offset >= b.first + b.count) lo = mid + 1;
    else return b;
  }
  return null;
}

// A geometry holding only one building's triangles, sharing the group's vertices.
export function subsetGeometry(group: Group, b: Building): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", group.geometry.getAttribute("position"));
  g.setAttribute("normal", group.geometry.getAttribute("normal"));
  const idx = group.geometry.getIndex()!.array.slice(b.first, b.first + b.count);
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
