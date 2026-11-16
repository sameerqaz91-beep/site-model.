import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, MapControls, Sky } from "@react-three/drei";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { buildingAt, subsetGeometry, type Building, type Model } from "./model";

/** Layer visibility by key; building groups are "g:<group key>". A missing key means on. */
export type Layers = Record<string, boolean>;

export type Palette = Record<
  "ground" | "line" | "detail" | "fill" | "edge" | "pick" | "sky" | "tree"
  | "asphalt" | "paving" | "grass" | "track" | "court" | "wall" | "glass", string> & {
  dark: boolean;
  meshes: string[]; // one colour per building group, in order
};

export type ViewName = "perspective" | "top" | "close";

interface Props {
  model: Model;
  layers: Layers;
  palette: Palette;
  selected: Building | null;
  onSelect: (b: Building | null) => void;
  view: { name: ViewName; seq: number };
  /** Pixels of the canvas covered by the panel, on the right (desktop) or at the bottom (phone). */
  inset: { right: number; bottom: number };
}

const FOV = 40;
// Direction of the three-quarter view, from the south-west.
const PERSPECTIVE_DIR = new THREE.Vector3(-0.12, 0.5, 0.62).normalize();
// A lower, closer three-quarter view for presentation shots.
const CLOSE_DIR = new THREE.Vector3(-0.42, 0.3, 0.86).normalize();

/**
 * Camera position that fits the whole site (plus a margin) in the part of the canvas the panel leaves free.
 * Projects the site's corners with a camera set up like the real one and searches for the closest distance.
 */
export function fitCamera(
  view: ViewName, [w0, d0]: [number, number],
  size: { width: number; height: number }, inset: { right: number; bottom: number },
  height = 12,
): THREE.Vector3 {
  let w = w0, d = d0;
  if (view === "close") { w *= 0.45; d *= 0.45; } // frame the heart of the site; the rest runs off to the horizon
  const W = Math.max(size.width, 1), H = Math.max(size.height, 1);
  const right = Math.min(inset.right, W * 0.7), bottom = Math.min(inset.bottom, H * 0.7);
  const cam = new THREE.PerspectiveCamera(FOV, W / H, 1, 1e6);
  if (right || bottom) cam.setViewOffset(W + right, H + bottom, right, bottom, W, H);
  cam.updateProjectionMatrix();
  // Free area in normalised device coordinates, with a margin of 4% on each side.
  const m = 0.08;
  const xMax = ((W - right) / W) * 2 - 1 - m, yMin = (bottom / H) * 2 - 1 + m;
  const corners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [0, height].map((y) => new THREE.Vector3((sx * w) / 2, y, (sz * d) / 2))));
  const dir = view === "top" ? new THREE.Vector3(0, 1, 0.0001).normalize() : view === "close" ? CLOSE_DIR : PERSPECTIVE_DIR;
  const fits = (dist: number) => {
    cam.position.copy(dir).multiplyScalar(dist);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    return corners.every((c) => {
      const p = c.clone().project(cam);
      return p.z < 1 && p.x > -1 + m && p.x < xMax && p.y > yMin && p.y < 1 - m;
    });
  };
  let lo = 1, hi = Math.max(w, d) * 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  return dir.clone().multiplyScalar(hi);
}

export function Scene(props: Props) {
  return (
    <Canvas
      camera={{ fov: FOV, near: 1, far: 20000, position: PERSPECTIVE_DIR.clone().multiplyScalar(Math.max(...props.model.size)) }}
      dpr={[1, 2]}
      onPointerMissed={() => props.onSelect(null)}
      gl={{ antialias: true }}
      shadows
    >
      <Contents {...props} />
    </Canvas>
  );
}

function Contents({ model, layers, palette, selected, onSelect, view, inset }: Props) {
  const controls = useRef<MapControlsImpl>(null);
  const { camera, scene, size } = useThree();
  const [w, d] = model.size;

  // Shift the projection so the scene centre sits in the middle of the area the panel leaves free.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    if (inset.right || inset.bottom) {
      cam.setViewOffset(size.width + inset.right, size.height + inset.bottom, inset.right, inset.bottom, size.width, size.height);
    } else {
      cam.clearViewOffset();
      cam.aspect = size.width / size.height;
    }
    cam.updateProjectionMatrix();
  }, [camera, size.width, size.height, inset.right, inset.bottom]);

  // Latest size and inset for the fit below, which should run on a view change, not on every resize.
  const latest = useRef({ size, inset });
  latest.current = { size, inset };
  const measured = useRef(false);

  useEffect(() => {
    scene.background = new THREE.Color(palette.sky);
    // Haze toward the horizon gives depth; it starts beyond the site so the site itself stays crisp.
    const span = Math.max(w, d);
    scene.fog = new THREE.Fog(palette.sky, span * 1.2, span * 4);
  }, [scene, palette.sky, w, d]);

  // Move the camera when a view button is pressed, or to the picked building.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    camera.position.copy(fitCamera(view.name, model.extent.size, latest.current.size, latest.current.inset)).add(model.extent.center);
    c.target.copy(model.extent.center);
    c.update();
  }, [view, camera, w, d]);

  // The panel is measured after the first frame; fit once more when that measurement arrives.
  useEffect(() => {
    const c = controls.current;
    if (!c || measured.current || !(inset.right || inset.bottom)) return;
    measured.current = true;
    camera.position.copy(fitCamera(view.name, model.extent.size, size, inset)).add(model.extent.center);
    c.target.copy(model.extent.center);
    c.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inset.right, inset.bottom]);

  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const offset = camera.position.clone().sub(c.target);
    const dist = Math.min(offset.length(), Math.max(240, Math.sqrt(selected.area) * 9));
    offset.setLength(dist);
    c.target.copy(selected.center).setY(0);
    camera.position.copy(c.target).add(offset);
    c.update();
  }, [selected, camera]);

  const groupGeo = useMemo(() => {
    const g = model.groups.find((x) => x.kind === selected?.kind);
    return g && selected ? subsetGeometry(g, selected) : null;
  }, [model, selected]);

  const on = (k: string) => layers[k] !== false;
  const visible = (kind: string) => on(`g:${kind}`);

  return (
    <>
      <hemisphereLight args={[palette.sky, palette.ground, 1.4]} />
      {!palette.dark && <Sky distance={15000} sunPosition={[-0.7, 0.55, 0.55]} turbidity={6} rayleigh={1.2} mieCoefficient={0.004} mieDirectionalG={0.85} />}
      <Sun span={Math.max(w, d)} />
      <ambientLight intensity={0.35} />

      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[Math.max(w, d) * 12, Math.max(w, d) * 12]} />
        <meshBasicMaterial color={palette.ground} />
      </mesh>
      {/* Shadows only, so the ground keeps its exact colour. */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.02} receiveShadow raycast={() => null}>
        <planeGeometry args={[Math.max(w, d) * 3, Math.max(w, d) * 3]} />
        <shadowMaterial opacity={0.22} />
      </mesh>

      {on("surfaces") && (Object.entries(model.surfaces) as [keyof typeof model.surfaces, THREE.BufferGeometry][]).map(([kind, geo]) => (
        <mesh key={kind} geometry={geo} receiveShadow raycast={() => null}>
          <meshStandardMaterial color={palette[kind]} roughness={kind === "asphalt" ? 0.95 : 0.85} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {on("details") && model.walls && (
        <mesh geometry={model.walls} castShadow receiveShadow raycast={() => null}>
          <meshStandardMaterial color={palette.wall} roughness={0.8} />
        </mesh>
      )}
      {model.windows && model.groups.some((g) => visible(g.kind)) && (
        <mesh geometry={model.windows} raycast={() => null}>
          <meshPhysicalMaterial color={palette.glass} roughness={0.08} metalness={0.4} clearcoat={1} side={THREE.DoubleSide} />
        </mesh>
      )}

      {on("fills") && model.fills && (
        <mesh geometry={model.fills}>
          <meshBasicMaterial color={palette.fill} side={THREE.DoubleSide} />
        </mesh>
      )}
      {on("plan") && model.lines.plan && (
        <lineSegments geometry={model.lines.plan}>
          <lineBasicMaterial color={palette.line} />
        </lineSegments>
      )}
      {on("details") && model.lines.details && (
        <lineSegments geometry={model.lines.details}>
          <lineBasicMaterial color={palette.detail} />
        </lineSegments>
      )}
      {on("floors") && model.lines.floors && (
        <lineSegments geometry={model.lines.floors}>
          <lineBasicMaterial color={palette.edge} />
        </lineSegments>
      )}

      {model.groups.map((g) =>
        visible(g.kind) ? (
          <group key={g.kind}>
            <mesh
              geometry={g.geometry}
              castShadow
              receiveShadow
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                if (e.faceIndex != null) onSelect(buildingAt(g, e.faceIndex));
              }}
              onPointerOver={() => (document.body.style.cursor = "pointer")}
              onPointerOut={() => (document.body.style.cursor = "")}
            >
              <meshStandardMaterial
                color={palette.meshes[g.colorIndex % palette.meshes.length]}
                flatShading
                side={THREE.DoubleSide} // faces in CAD exports are not reliably wound outwards
                roughness={0.85}
                polygonOffset
                polygonOffsetFactor={1}
                polygonOffsetUnits={1}
              />
            </mesh>
            <lineSegments geometry={g.edges}>
              <lineBasicMaterial color={palette.edge} transparent opacity={0.55} />
            </lineSegments>
          </group>
        ) : null,
      )}
      {model.storeys && model.groups.some((g) => visible(g.kind)) && (
        <lineSegments geometry={model.storeys}>
          <lineBasicMaterial color={palette.edge} transparent opacity={0.7} />
        </lineSegments>
      )}

      {groupGeo && (
        <mesh geometry={groupGeo}>
          <meshStandardMaterial color={palette.pick} emissive={palette.pick} emissiveIntensity={0.35} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      )}

      {on("codes") &&
        model.codes.map((c, i) => (
          <Html key={i} position={[c.position.x, 12, c.position.z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
            <span className={c.text.startsWith("DISTRICT") ? "tag tag-district" : "tag"}>{c.text}</span>
          </Html>
        ))}

      {on("trees") && model.trees.length > 0 && <Trees xz={model.trees} color={palette.tree} />}

      {on("names") &&
        model.names.map((c, i) => (
          <Html key={`n${i}`} position={[c.position.x, 8, c.position.z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
            <span className="tag tag-name">{c.text}</span>
          </Html>
        ))}

      <MapControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        maxPolarAngle={Math.PI / 2.15}
        minDistance={40}
        maxDistance={Math.max(w, d) * 2.5}
      />
    </>
  );
}

// Each tree is a trunk and a rounded canopy, drawn as two instanced meshes.
function Trees({ xz, color }: { xz: Float32Array; color: string }) {
  const trunk = useRef<THREE.InstancedMesh>(null);
  const crown = useRef<THREE.InstancedMesh>(null);
  const count = xz.length / 2;
  useEffect(() => {
    const t = trunk.current, c = crown.current;
    if (!t || !c) return;
    const o = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const s = 0.8 + ((i * 7919) % 40) / 100; // small stable size variation
      const x = xz[2 * i], z = xz[2 * i + 1];
      o.rotation.set(0, (i * 2.399) % (Math.PI * 2), 0);
      o.position.set(x, 1.1 * s, z);
      o.scale.set(s, s, s);
      o.updateMatrix();
      t.setMatrixAt(i, o.matrix);
      o.position.set(x, 3.4 * s, z);
      o.scale.set(s, s * 0.9, s);
      o.updateMatrix();
      c.setMatrixAt(i, o.matrix);
    }
    t.instanceMatrix.needsUpdate = true;
    c.instanceMatrix.needsUpdate = true;
  }, [xz, count]);
  return (
    <>
      <instancedMesh ref={trunk} args={[undefined, undefined, count]} raycast={() => null} castShadow>
        <cylinderGeometry args={[0.18, 0.25, 2.2, 5]} />
        <meshStandardMaterial color="#7a5c43" roughness={1} />
      </instancedMesh>
      <instancedMesh ref={crown} args={[undefined, undefined, count]} raycast={() => null} castShadow>
        <icosahedronGeometry args={[1.9, 1]} />
        <meshStandardMaterial color={color} roughness={0.9} flatShading />
      </instancedMesh>
    </>
  );
}

// Late-afternoon sun from the south-west, with a shadow box sized to the site.
function Sun({ span }: { span: number }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  useEffect(() => {
    const l = ref.current;
    if (!l) return;
    const c = l.shadow.camera;
    const r = span * 0.75;
    c.left = -r; c.right = r; c.top = r; c.bottom = -r;
    c.near = 1; c.far = span * 4;
    c.updateProjectionMatrix();
    l.shadow.mapSize.set(4096, 4096);
    l.shadow.bias = -0.0004;
    l.shadow.normalBias = 0.6;
    l.shadow.map?.dispose();
    l.shadow.map = null;
  }, [span]);
  return <directionalLight ref={ref} position={[-span * 0.7, span * 0.9, span * 0.55]} intensity={1.7} castShadow />;
}
