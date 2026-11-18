import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, MapControls } from "@react-three/drei";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import { buildingAt, subsetGeometry, type Building, type Model } from "./model";
import type { FacilitySpec, Placement } from "./data";

export interface Layers {
  houses: boolean;
  publics: boolean;
  plan: boolean;
  details: boolean;
  floors: boolean;
  fills: boolean;
  codes: boolean;
}

export type Palette = Record<
  "ground" | "house" | "public" | "line" | "detail" | "fill" | "edge" | "pick" | "sky" | "facility",
  string
>;

export type ViewName = "perspective" | "top";

// Ask the camera to look at a point from a given distance; seq makes repeated requests distinct.
export interface Focus {
  point: THREE.Vector3;
  dist: number;
  seq: number;
}

interface Props {
  model: Model;
  layers: Layers;
  palette: Palette;
  selected: Building | null;
  onSelect: (b: Building | null) => void;
  view: { name: ViewName; seq: number };
  focus: Focus | null;
  facility: FacilitySpec | null;
  placement: Placement | null;
  facilitySelected: boolean;
  onSelectFacility: () => void;
  placing: boolean;
  onPlace: (x: number, z: number) => void;
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
      className={props.placing ? "placing" : undefined}
    >
      <Contents {...props} />
    </Canvas>
  );
}

function Contents(props: Props) {
  const { model, layers, palette, selected, onSelect, view, focus, placing, onPlace } = props;
  const controls = useRef<MapControlsImpl>(null);
  const { camera, scene } = useThree();
  const [w, d] = model.size;

  useEffect(() => {
    scene.background = new THREE.Color(palette.sky);
  }, [scene, palette.sky]);

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
    if (!c || !focus) return;
    const offset = camera.position.clone().sub(c.target);
    offset.setLength(Math.min(offset.length(), focus.dist));
    c.target.copy(focus.point).setY(0);
    camera.position.copy(c.target).add(offset);
    c.update();
  }, [focus, camera]);

  const pickGeo = useMemo(() => {
    const g = model.groups.find((x) => x.kind === selected?.kind);
    return g && selected ? subsetGeometry(g, selected) : null;
  }, [model, selected]);

  const visible = (k: "house" | "public") => (k === "house" ? layers.houses : layers.publics);

  // While placing, any click on the ground or a building drops the facility there.
  const placeAt = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onPlace(e.point.x, e.point.z);
  };

  return (
    <>
      <hemisphereLight args={[palette.sky, palette.ground, 1.4]} />
      <directionalLight position={[-600, 900, 400]} intensity={1.6} />
      <ambientLight intensity={0.35} />

      <mesh
        rotation-x={-Math.PI / 2}
        position-y={-0.05}
        onClick={(e) => (placing ? placeAt(e) : onSelect(null))}
      >
        <planeGeometry args={[w * 1.6, d * 1.8]} />
        <meshBasicMaterial color={palette.ground} />
      </mesh>

      {layers.fills && model.fills && (
        <mesh geometry={model.fills} raycast={() => null}>
          <meshBasicMaterial color={palette.fill} side={THREE.DoubleSide} />
        </mesh>
      )}
      {layers.plan && model.lines.plan && (
        <lineSegments geometry={model.lines.plan} raycast={() => null}>
          <lineBasicMaterial color={palette.line} />
        </lineSegments>
      )}
      {layers.details && model.lines.details && (
        <lineSegments geometry={model.lines.details} raycast={() => null}>
          <lineBasicMaterial color={palette.detail} />
        </lineSegments>
      )}
      {layers.floors && model.lines.floors && (
        <lineSegments geometry={model.lines.floors} raycast={() => null}>
          <lineBasicMaterial color={palette.edge} />
        </lineSegments>
      )}

      {model.groups.map((g) =>
        visible(g.kind) ? (
          <group key={g.kind}>
            <mesh
              geometry={g.geometry}
              onClick={(e: ThreeEvent<MouseEvent>) => {
                if (placing) return placeAt(e);
                e.stopPropagation();
                if (e.faceIndex != null) onSelect(buildingAt(g, e.faceIndex));
              }}
              onPointerOver={() => (document.body.style.cursor = placing ? "crosshair" : "pointer")}
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
            <lineSegments geometry={g.edges} raycast={() => null}>
              <lineBasicMaterial color={palette.edge} transparent opacity={0.55} />
            </lineSegments>
          </group>
        ) : null,
      )}

      {pickGeo && (
        <mesh geometry={pickGeo} raycast={() => null}>
          <meshStandardMaterial color={palette.pick} emissive={palette.pick} emissiveIntensity={0.35} polygonOffset polygonOffsetFactor={-1} />
        </mesh>
      )}

      {props.facility && props.placement && <Facility {...props} spec={props.facility} at={props.placement} />}

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
        minDistance={20}
        maxDistance={Math.max(w, d) * 2.5}
      />
    </>
  );
}

// The placed facility: a main room and an optional annex (e.g. its transformer) beside it.
function Facility({ spec, at, palette, facilitySelected, onSelectFacility, placing }: Props & { spec: FacilitySpec; at: Placement }) {
  const [fw, fd] = spec.footprint;
  const color = facilitySelected ? palette.pick : palette.facility;
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (placing) return; // let the click fall through to the ground and move it
    e.stopPropagation();
    onSelectFacility();
  };
  const box = (size: [number, number, number], pos: [number, number, number], c: string) => (
    <group position={pos}>
      <mesh position-y={size[1] / 2} onClick={click} raycast={placing ? () => null : undefined}>
        <boxGeometry args={size} />
        <meshStandardMaterial color={c} roughness={0.7} emissive={c} emissiveIntensity={facilitySelected ? 0.3 : 0.08} />
      </mesh>
      <lineSegments position-y={size[1] / 2} raycast={() => null}>
        <edgesGeometry args={[new THREE.BoxGeometry(...size)]} />
        <lineBasicMaterial color={palette.edge} />
      </lineSegments>
    </group>
  );
  return (
    <group position={[at.x, 0, at.z]} rotation-y={THREE.MathUtils.degToRad(at.rot)}>
      {box([fw, spec.height, fd], [0, 0, 0], color)}
      {spec.annex && box([spec.annex.footprint[0], spec.annex.height, spec.annex.footprint[1]], [fw / 2 + 1.5 + spec.annex.footprint[0] / 2, 0, 0], palette.edge)}
      <Html position={[0, spec.height + 6, 0]} center zIndexRange={[12, 11]} style={{ pointerEvents: "none" }}>
        <span className="tag tag-facility">{spec.name}</span>
      </Html>
    </group>
  );
}
