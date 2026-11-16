import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, MapControls } from "@react-three/drei";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { buildingAt, subsetGeometry, type Building, type Model } from "./model";

export interface Layers {
  houses: boolean;
  publics: boolean;
  plan: boolean;
  details: boolean;
  floors: boolean;
  fills: boolean;
  codes: boolean;
}

export type Palette = Record<"ground" | "house" | "public" | "line" | "detail" | "fill" | "edge" | "pick" | "sky", string>;

export type ViewName = "perspective" | "top";

interface Props {
  model: Model;
  layers: Layers;
  palette: Palette;
  selected: Building | null;
  onSelect: (b: Building | null) => void;
  view: { name: ViewName; seq: number };
}

// A three-quarter view from the south-west that fits the whole site on screen.
function perspectiveAt([w, d]: [number, number]): [number, number, number] {
  const span = Math.max(w, d);
  return [-span * 0.12, span * 0.5, span * 0.62];
}

export function Scene(props: Props) {
  return (
    <Canvas
      camera={{ fov: 40, near: 1, far: 20000, position: perspectiveAt(props.model.size) }}
      dpr={[1, 2]}
      onPointerMissed={() => props.onSelect(null)}
      gl={{ antialias: true }}
    >
      <Contents {...props} />
    </Canvas>
  );
}

function Contents({ model, layers, palette, selected, onSelect, view }: Props) {
  const controls = useRef<MapControlsImpl>(null);
  const { camera, scene } = useThree();
  const [w, d] = model.size;

  useEffect(() => {
    scene.background = new THREE.Color(palette.sky);
  }, [scene, palette.sky]);

  // Move the camera when a view button is pressed, or to the picked building.
  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const span = Math.max(w, d);
    if (view.name === "top") camera.position.set(0, span * 1.25, 1);
    else camera.position.set(...perspectiveAt(model.size));
    c.target.set(0, 0, 0);
    c.update();
  }, [view, camera, w, d]);

  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const offset = camera.position.clone().sub(c.target);
    const dist = Math.min(offset.length(), selected.kind === "public" ? 260 : 160);
    offset.setLength(dist);
    c.target.copy(selected.center).setY(0);
    camera.position.copy(c.target).add(offset);
    c.update();
  }, [selected, camera]);

  const groupGeo = useMemo(() => {
    const g = model.groups.find((x) => x.kind === selected?.kind);
    return g && selected ? subsetGeometry(g, selected) : null;
  }, [model, selected]);

  const visible = (k: "house" | "public") => (k === "house" ? layers.houses : layers.publics);

  return (
    <>
      <hemisphereLight args={[palette.sky, palette.ground, 1.4]} />
      <directionalLight position={[-600, 900, 400]} intensity={1.6} />
      <ambientLight intensity={0.35} />

      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[w * 1.6, d * 1.8]} />
        <meshBasicMaterial color={palette.ground} />
      </mesh>

      {layers.fills && model.fills && (
        <mesh geometry={model.fills}>
          <meshBasicMaterial color={palette.fill} side={THREE.DoubleSide} />
        </mesh>
      )}
      {layers.plan && model.lines.plan && (
        <lineSegments geometry={model.lines.plan}>
          <lineBasicMaterial color={palette.line} />
        </lineSegments>
      )}
      {layers.details && model.lines.details && (
        <lineSegments geometry={model.lines.details}>
          <lineBasicMaterial color={palette.detail} />
        </lineSegments>
      )}
      {layers.floors && model.lines.floors && (
        <lineSegments geometry={model.lines.floors}>
          <lineBasicMaterial color={palette.edge} />
        </lineSegments>
      )}

      {model.groups.map((g) =>
        visible(g.kind) ? (
          <group key={g.kind}>
            <mesh
              geometry={g.geometry}
              onClick={(e: ThreeEvent<MouseEvent>) => {
                e.stopPropagation();
                if (e.faceIndex != null) onSelect(buildingAt(g, e.faceIndex));
              }}
              onPointerOver={() => (document.body.style.cursor = "pointer")}
              onPointerOut={() => (document.body.style.cursor = "")}
            >
              <meshStandardMaterial
                color={g.kind === "house" ? palette.house : palette.public}
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

      {groupGeo && (
        <mesh geometry={groupGeo}>
          <meshStandardMaterial color={palette.pick} emissive={palette.pick} emissiveIntensity={0.35} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      )}

      {layers.codes &&
        model.codes.map((c, i) => (
          <Html key={i} position={[c.position.x, 12, c.position.z]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
            <span className={c.text.startsWith("DISTRICT") ? "tag tag-district" : "tag"}>{c.text}</span>
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
