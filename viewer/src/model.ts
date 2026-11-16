import * as THREE from "three";

// Shape of the JSON produced by tools/dxf_to_model.py and tools/plan_to_model.py (Y-up, metres, centred on the site).
export interface RawMesh {
  positions: number[];
  indices: number[];
  // floors and code are given by plan_to_model.py; floors is 0 for sheds and other fixed-height groups.
  items: [first: number, count: number, height: number, area: number, floors?: number, code?: string | null][];
}
export interface RawModel {
  name?: string;
  units: string;
  size: [number, number];
  meshes: Record<string, RawMesh>;
  lines: Record<string, number[][]>;
  fills: number[][];
  labels: { t: string; x: number; z: number; h: number }[];
  floorHeight?: number; // height of 3D-FLOOR-LINE when the drawing gives one; 3.5 m otherwise
  meshLabels?: Record<string, string>; // name shown for each key of meshes
  codes?: { t: string; x: number; z: number; h: number }[]; // building numbers, when the converter knows them
  trees?: number[]; // x, z pairs
  storeys?: number[][]; // [y, x, z, x, z, ...]: a building outline at each floor level
  surfaces?: Partial<Record<SurfaceKind, number[][][]>>; // polygons as [outer ring, ...holes], rings of x, z
  walls?: { positions: number[]; indices: number[] }; // fences and boundary walls
  windows?: { positions: number[]; indices: number[] }; // window panes on the facades
  assumedHeights?: boolean; // heights were not in the drawing (2D plan)
}

const DEFAULT_LABELS: Record<string, string> = { "3D-HOUSES": "كتل سكنية", "3D-PUBLIC": "مبانٍ عامة" };

export type SurfaceKind = "asphalt" | "paving" | "grass" | "track" | "court";

export interface Building {
  id: number;
  kind: string; // key of the group it belongs to
  label: string;
  first: number;
  count: number;
  height: number;
  area: number;
  floors: number; // 0 when unknown
  center: THREE.Vector3;
  code: string | null; // nearest code label from the drawing
}

export interface Group {
  kind: string;
  label: string;
  colorIndex: number; // into Palette.meshes
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
  names: { text: string; position: THREE.Vector3 }[]; // Arabic place names written in the drawing
  floorHeight: number;
  trees: Float32Array; // x, z pairs
  storeys: THREE.BufferGeometry | null;
  surfaces: Partial<Record<SurfaceKind, THREE.BufferGeometry>>;
  walls: THREE.BufferGeometry | null;
  windows: THREE.BufferGeometry | null;
  extent: { center: THREE.Vector3; size: [number, number] }; // where the drawn content is, for framing
  assumedHeights: boolean;
  stats: { builtArea: number; groups: { kind: string; label: string; colorIndex: number; count: number; area: number }[] };
}

// Building-type codes and district names are upper-case words; plot numbers are left out.
const CODE = /^[A-Z]{1,8}\d?$/;
const ARABIC = /[\u0600-\u06FF]/;
export const DEFAULT_FLOOR_HEIGHT = 3.5;

export function buildModel(raw: RawModel): Model {
  const explicit = Array.isArray(raw.codes);
  const codes = (explicit ? raw.codes! : raw.labels.filter((l) => CODE.test(l.t)))
    .map((l) => ({ text: l.t, position: new THREE.Vector3(l.x, 0, l.z) }));
  const names = raw.labels
    .filter((l) => ARABIC.test(l.t))
    .map((l) => ({ text: l.t, position: new THREE.Vector3(l.x, 0, l.z) }));
  const floorHeight = raw.floorHeight ?? DEFAULT_FLOOR_HEIGHT;

  const groups: Group[] = [];
  let nextId = 0;
  for (const [kind, m] of Object.entries(raw.meshes)) {
    const label = raw.meshLabels?.[kind] ?? DEFAULT_LABELS[kind] ?? kind;
    const colorIndex = groups.length;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
    geometry.setIndex(m.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const pos = geometry.getAttribute("position");
    const buildings = m.items.map(([first, count, height, area, floors = 0, given = null]) => {
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (let i = first; i < first + count; i++) box.expandByPoint(v.fromBufferAttribute(pos, m.indices[i]));
      const center = box.getCenter(new THREE.Vector3());
      let code: string | null = given ?? null;
      // With numbers from the converter every building can carry one; otherwise only public buildings have codes.
      if (!code && given === null && (explicit || kind === "3D-PUBLIC") && m.items[0]?.length !== 6) {
        let best = explicit ? Math.max(12, Math.sqrt(area)) : 45; // metres: further labels belong to another building
        for (const c of codes) {
          const d = Math.hypot(c.position.x - center.x, c.position.z - center.z);
          if (d < best && !c.text.startsWith("DISTRICT")) { best = d; code = c.text; }
        }
      }
      return { id: nextId++, kind, label, first, count, height, area, floors, center, code } as Building;
    });
    groups.push({ kind, label, colorIndex, geometry, edges: new THREE.EdgesGeometry(geometry, 30), buildings });
  }

  const lines: Record<string, THREE.BufferGeometry> = {};
  for (const [name, polys] of Object.entries(raw.lines)) {
    const y = name === "floors" ? floorHeight : 0.06;
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

  const groupStats = groups.map((g) => ({
    kind: g.kind, label: g.label, colorIndex: g.colorIndex,
    count: g.buildings.length, area: g.buildings.reduce((a, b) => a + b.area, 0),
  }));
  return {
    name: raw.name ?? "",
    size: raw.size,
    groups,
    lines,
    fills,
    codes,
    names,
    floorHeight,
    trees: new Float32Array(raw.trees ?? []),
    storeys: ringsToSegments(raw.storeys),
    surfaces: surfacesOf(raw.surfaces),
    walls: meshOf(raw.walls),
    windows: meshOf(raw.windows),
    extent: extentOf([...groups.map((g) => g.geometry), ...Object.values(lines)], raw.size),
    assumedHeights: !!raw.assumedHeights,
    stats: { builtArea: groupStats.reduce((a, g) => a + g.area, 0), groups: groupStats },
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

// Closed outlines at a height each ([y, x, z, ...]) as one set of line segments.
function ringsToSegments(rings?: number[][]): THREE.BufferGeometry | null {
  if (!rings?.length) return null;
  const seg: number[] = [];
  for (const [y, ...p] of rings) {
    for (let i = 0; i + 3 < p.length; i += 2) seg.push(p[i], y, p[i + 1], p[i + 2], y, p[i + 3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  return g;
}

// Bounds of what is drawn on the plan; the site box from the converter can hold a lot of empty margin.
function extentOf(geoms: THREE.BufferGeometry[], fallback: [number, number]): Model["extent"] {
  const box = new THREE.Box3();
  for (const g of geoms) {
    g.computeBoundingBox();
    if (g.boundingBox && !g.boundingBox.isEmpty()) box.union(g.boundingBox);
  }
  if (box.isEmpty()) return { center: new THREE.Vector3(), size: fallback };
  const c = box.getCenter(new THREE.Vector3()).setY(0);
  const sz = box.getSize(new THREE.Vector3());
  return { center: c, size: [Math.max(sz.x, 1), Math.max(sz.z, 1)] };
}

function meshOf(m?: { positions: number[]; indices: number[] }): THREE.BufferGeometry | null {
  if (!m?.indices.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(m.positions, 3));
  g.setIndex(m.indices);
  g.computeVertexNormals();
  return g;
}

// Ground surfaces, each kind a flat shape on the ground (paved blocks are raised as 15 cm slabs).
const SURFACE_Y: Record<SurfaceKind, number> = { asphalt: 0.01, track: 0.015, court: 0.02, grass: 0.025, paving: 0 };
function surfacesOf(raw?: RawModel["surfaces"]): Model["surfaces"] {
  const out: Model["surfaces"] = {};
  if (!raw) return out;
  for (const [kind, polys] of Object.entries(raw) as [SurfaceKind, number[][][]][]) {
    if (!polys?.length) continue;
    const shapes = polys.map(([outer, ...holes]) => {
      const s = new THREE.Shape(toPts(outer));
      s.holes = holes.map((h) => new THREE.Path(toPts(h)));
      return s;
    });
    const g = kind === "paving"
      ? new THREE.ExtrudeGeometry(shapes, { depth: 0.15, bevelEnabled: false })
      : new THREE.ShapeGeometry(shapes);
    // Shapes live in the XY plane with y = -z; rotating them flat puts them back at (x, z).
    g.rotateX(Math.PI / 2);
    if (kind === "paving") g.translate(0, 0.15, 0);
    else g.translate(0, SURFACE_Y[kind], 0);
    g.computeVertexNormals();
    out[kind] = g;
  }
  return out;
}
const toPts = (r: number[]) => {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i + 1 < r.length; i += 2) pts.push(new THREE.Vector2(r[i], r[i + 1]));
  return pts;
};
