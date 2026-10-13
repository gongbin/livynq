/**
 * 3D home view (design doc §16.4), generated from the floor plan data: room floors, walls extruded
 * along the outlines (shared walls once), levels stacked by elevation, live device markers and real
 * lights. Lazy-loaded: this file is the only importer of three / R3F / drei.
 */
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { DeviceDTO, Level, Room } from '@livynq/model';
import { deviceKind, describe, lightState, type LightState } from '../../lib/devices.ts';
import { ALL_LEVELS, WALL_HEIGHT, boundsOf, placedOn, placementHeight, pointInPolygon, roomColor, type Bounds, type Pt } from '../../lib/floorplan.ts';
import { useT } from '../../lib/i18n.ts';
import { DeviceMarker, MARKER_SIZES, markerStyle } from './device-marker.tsx';
import { MapButton } from './plan-view.tsx';

const MAX_REAL_LIGHTS = 8;
const WALL_T = 0.12;
const SLAB_T = 0.08;

interface Palette {
  floor: string;
  lit: string;
  wall: string;
  wallFaded: number;
  plinth: string;
  ambient: number;
  hemi: number;
  sun: number;
  lightBoost: number;
}

const DAY: Palette = { floor: '#f6f1ea', lit: '#fff0cf', wall: '#ece6dd', wallFaded: 0.16, plinth: '#e3dbcf', ambient: 0.55, hemi: 0.75, sun: 1.5, lightBoost: 1 };
const NIGHT: Palette = { floor: '#3b3631', lit: '#5a4a32', wall: '#57504a', wallFaded: 0.2, plinth: '#25211d', ambient: 0.12, hemi: 0.2, sun: 0.25, lightBoost: 2.2 };

// ------------------------------------------------------------------------------- geometry helpers

/** Room edges merged per line so a wall shared by two rooms is drawn once. */
export function wallSegments(polygons: Pt[][]): [Pt, Pt][] {
  const lines = new Map<string, { u: Pt; n: Pt; off: number; spans: [number, number][] }>();
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.05) continue;
      let u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      // Canonical direction so both orientations of a shared edge land on the same line.
      if (u[0] < -1e-9 || (Math.abs(u[0]) < 1e-9 && u[1] < 0)) u = [-u[0], -u[1]];
      const n: Pt = [-u[1], u[0]];
      const off = a[0] * n[0] + a[1] * n[1];
      const key = `${Math.round(Math.atan2(u[1], u[0]) * 200)}|${Math.round(off * 20)}`;
      const t0 = a[0] * u[0] + a[1] * u[1];
      const t1 = b[0] * u[0] + b[1] * u[1];
      const line = lines.get(key) ?? { u, n, off, spans: [] };
      line.spans.push([Math.min(t0, t1), Math.max(t0, t1)]);
      lines.set(key, line);
    }
  }
  const out: [Pt, Pt][] = [];
  for (const { u, n, off, spans } of lines.values()) {
    spans.sort((x, y) => x[0] - y[0]);
    let cur: [number, number] | null = null;
    const emit = (s: [number, number]) => out.push([[u[0] * s[0] + n[0] * off, u[1] * s[0] + n[1] * off], [u[0] * s[1] + n[0] * off, u[1] * s[1] + n[1] * off]]);
    for (const s of spans) {
      if (cur && s[0] <= cur[1] + 0.03) cur[1] = Math.max(cur[1], s[1]);
      else {
        if (cur) emit(cur);
        cur = [s[0], s[1]];
      }
    }
    if (cur) emit(cur);
  }
  return out;
}

function kelvinToColor(k: number): THREE.Color {
  const t = k / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return new THREE.Color().setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

function lightColor(l: LightState): THREE.Color {
  if (l.hasHue && (l.colorMode === 'hs' || l.colorMode === 'xy') && l.hueDeg !== undefined) {
    return new THREE.Color().setHSL(l.hueDeg / 360, 0.35 + ((l.satPct ?? 100) / 100) * 0.6, 0.6, THREE.SRGBColorSpace);
  }
  if (l.kelvin !== undefined) return kelvinToColor(l.kelvin);
  return new THREE.Color('#ffc978');
}

/** Radial falloff texture for light halos. */
function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function useDisposable<T extends { dispose(): void }>(make: () => T, deps: unknown[]): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const v = useMemo(make, deps);
  useEffect(() => () => v.dispose(), [v]);
  return v;
}

// ------------------------------------------------------------------------------- scene parts

interface LevelData {
  level: Level;
  rooms: { room: Room; polygon: Pt[]; index: number }[];
  devices: (DeviceDTO & { placement: NonNullable<DeviceDTO['placement']> })[];
}

function Floors({ data, palette, litRooms }: { data: LevelData; palette: Palette; litRooms: Set<string> }) {
  const geos = useMemo(
    () =>
      data.rooms.map((r) => {
        const shape = new THREE.Shape(r.polygon.map(([x, y]) => new THREE.Vector2(x, -y)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: SLAB_T, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        return { id: r.room.id, geo, color: roomColor(r.room, r.index) };
      }),
    [data.rooms],
  );
  useEffect(() => () => geos.forEach((g) => g.geo.dispose()), [geos]);
  return (
    <>
      {geos.map((g) => {
        const color = new THREE.Color(litRooms.has(g.id) ? palette.lit : palette.floor).lerp(new THREE.Color(g.color), 0.32);
        return (
          <mesh key={g.id} geometry={g.geo} position={[0, data.level.elevation, 0]} receiveShadow>
            <meshStandardMaterial color={color} roughness={0.85} metalness={0} />
          </mesh>
        );
      })}
    </>
  );
}

function Walls({ data, palette, center }: { data: LevelData; palette: Palette; center: THREE.Vector3 }) {
  const segs = useMemo(() => wallSegments(data.rooms.map((r) => r.polygon)), [data.rooms]);
  const box = useDisposable(() => new THREE.BoxGeometry(1, 1, 1), []);
  const solid = useDisposable(() => new THREE.MeshStandardMaterial({ color: palette.wall, roughness: 0.9 }), [palette.wall]);
  const faded = useDisposable(() => new THREE.MeshStandardMaterial({ color: palette.wall, roughness: 0.9, transparent: true, opacity: palette.wallFaded, depthWrite: false }), [palette.wall, palette.wallFaded]);
  const group = useRef<THREE.Group>(null);
  const tmp = useMemo(() => ({ cam: new THREE.Vector3(), mid: new THREE.Vector3() }), []);

  // Cut-away: walls between the camera and the middle of the floor fade out so rooms stay visible.
  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    tmp.cam.set(camera.position.x - center.x, 0, camera.position.z - center.z).normalize();
    for (const child of g.children) {
      const m = child as THREE.Mesh;
      tmp.mid.set(m.position.x - center.x, 0, m.position.z - center.z);
      const len = tmp.mid.length();
      const facing = len > 0.3 ? tmp.mid.divideScalar(len).dot(tmp.cam) : 0;
      m.material = facing > 0.3 ? faded : solid;
    }
  });

  const h = WALL_HEIGHT;
  return (
    <group ref={group}>
      {segs.map(([a, b], i) => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        return (
          <mesh
            key={i}
            geometry={box}
            material={solid}
            position={[(a[0] + b[0]) / 2, data.level.elevation + SLAB_T + h / 2, (a[1] + b[1]) / 2]}
            rotation={[0, -angle, 0]}
            scale={[len + WALL_T, h, WALL_T]}
          />
        );
      })}
    </group>
  );
}

function Plinth({ bounds, elevation, palette }: { bounds: Bounds; elevation: number; palette: Palette }) {
  const m = 0.7;
  const w = bounds.maxX - bounds.minX + m * 2;
  const d = bounds.maxY - bounds.minY + m * 2;
  return (
    <mesh position={[(bounds.minX + bounds.maxX) / 2, elevation - 0.09, (bounds.minY + bounds.maxY) / 2]} receiveShadow>
      <boxGeometry args={[w, 0.18, d]} />
      <meshStandardMaterial color={palette.plinth} roughness={1} />
    </mesh>
  );
}

interface LitLight {
  id: string;
  pos: THREE.Vector3;
  color: THREE.Color;
  level: number;
}

function Lights({ lights, glow, palette }: { lights: LitLight[]; glow: THREE.Texture; palette: Palette }) {
  // The brightest few get a real point light; the rest glow without lighting the scene.
  const real = [...lights].sort((a, b) => b.level - a.level).slice(0, MAX_REAL_LIGHTS);
  const realIds = new Set(real.map((l) => l.id));
  return (
    <>
      {lights.map((l) => (
        <group key={l.id} position={l.pos}>
          {realIds.has(l.id) && <pointLight color={l.color} intensity={(1.5 + l.level * 4.5) * palette.lightBoost} distance={7.5} decay={1.4} />}
          <mesh>
            <sphereGeometry args={[0.09, 16, 12]} />
            <meshBasicMaterial color={l.color} toneMapped={false} />
          </mesh>
          <sprite scale={[1.1 + l.level * 0.9, 1.1 + l.level * 0.9, 1]}>
            <spriteMaterial map={glow} color={l.color} transparent opacity={0.45 + l.level * 0.4} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
          </sprite>
        </group>
      ))}
    </>
  );
}

/** Small emissive "pin" under each marker: dot at the device, faint line to the floor. */
function Pins({ data, palette }: { data: LevelData; palette: Palette }) {
  const t = useT();
  return (
    <>
      {data.devices.map((d) => {
        const v = describe(d, t);
        if (v.kind === 'light' && v.on) return null;
        const h = placementHeight(d.placement, d);
        const s = markerStyle(v);
        const color = v.tone === 'alert' ? '#e0583a' : v.tone === 'active' ? '#f2b544' : palette === NIGHT ? '#8d857c' : '#a59d93';
        const base = data.level.elevation + SLAB_T;
        return (
          <group key={d.id} position={[d.placement.x, 0, d.placement.y]}>
            <mesh position={[0, base + h, 0]}>
              <sphereGeometry args={[0.07, 12, 10]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={s.halo ? 1.2 : 0.15} toneMapped={!s.halo} />
            </mesh>
            <mesh position={[0, base + h / 2, 0]}>
              <cylinderGeometry args={[0.012, 0.012, h, 6]} />
              <meshBasicMaterial color={color} transparent opacity={0.35} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

function Markers({ data, onOpen, large }: { data: LevelData; onOpen: (id: string) => void; large?: boolean }) {
  const size = large ? 'lg' : 'md';
  const box = MARKER_SIZES[size].box;
  return (
    <>
      {data.devices.map((d) => {
        const h = placementHeight(d.placement, d);
        return (
          <Html key={d.id} position={[d.placement.x, data.level.elevation + SLAB_T + h, d.placement.y]} zIndexRange={[30, 0]} style={{ transform: `translate(-50%, -${box / 2}px)` }}>
            <DeviceMarker device={d} size={size} onOpen={() => onOpen(d.id)} />
          </Html>
        );
      })}
    </>
  );
}

function RoomTags({ data }: { data: LevelData }) {
  return (
    <>
      {data.rooms.map((r) => {
        const b = boundsOf(r.polygon);
        return (
          <Html key={r.room.id} position={[(b.minX + b.maxX) / 2, data.level.elevation + 0.1, (b.minY + b.maxY) / 2]} zIndexRange={[5, 0]} pointerEvents="none" center>
            <span className="pointer-events-none rounded-full bg-surface/75 px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-muted shadow-card backdrop-blur-sm select-none">{r.room.name}</span>
          </Html>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------------------- camera

function framing(bounds: Bounds, elevation: number, aspect: number): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minY + bounds.maxY) / 2;
  const target = new THREE.Vector3(cx, elevation + 0.6, cz);
  const radius = Math.max(3, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2 + 0.6);
  const fov = (40 * Math.PI) / 180;
  const fit = radius / Math.sin(fov / 2) / Math.min(1, Math.max(0.55, aspect / 1.2));
  const dir = new THREE.Vector3(-0.62, 1.15, 0.95).normalize();
  return { pos: target.clone().addScaledVector(dir, fit * 0.92), target };
}

type Controls = ComponentRef<typeof OrbitControls>;

function CameraRig({ bounds, elevation, resetKey, controls }: { bounds: Bounds; elevation: number; resetKey: string; controls: React.RefObject<Controls | null> }) {
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    const f = framing(bounds, elevation, size.width / Math.max(1, size.height));
    camera.position.copy(f.pos);
    const c = controls.current;
    if (c) {
      c.target.copy(f.target);
      c.update();
    } else camera.lookAt(f.target);
    invalidate();
    // Reframe on level change / reset, not on every size or data tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  return null;
}

// ------------------------------------------------------------------------------- root

export default function Scene3D({
  levels,
  levelId,
  rooms,
  devices,
  dark,
  onOpen,
  large,
}: {
  levels: Level[];
  levelId: string;
  rooms: Room[];
  devices: DeviceDTO[];
  dark: boolean;
  onOpen: (id: string) => void;
  large?: boolean;
}) {
  const t = useT();
  const palette = dark ? NIGHT : DAY;
  const controls = useRef<Controls | null>(null);
  const [resetKey, setResetKey] = useState(0);
  // drei <Html> mounted in the Canvas' first commit can lose its content when the event target
  // connects right after; mount the HTML overlays once the canvas exists.
  const [created, setCreated] = useState(false);

  const shown = levelId === ALL_LEVELS ? levels : levels.filter((l) => l.id === levelId);
  const data: LevelData[] = useMemo(
    () =>
      shown.map((level) => ({
        level,
        rooms: rooms.flatMap((room, index) => (room.levelId === level.id && room.polygon && room.polygon.length >= 3 ? [{ room, polygon: room.polygon, index }] : [])),
        devices: placedOn(devices, level.id),
      })),
    [shown, rooms, devices],
  );

  const all = data.flatMap((d) => [...d.rooms.flatMap((r) => r.polygon), ...d.devices.map((x) => [x.placement.x, x.placement.y] as Pt)]);
  const bounds = all.length ? boundsOf(all) : { minX: 0, minY: 0, maxX: 8, maxY: 6 };
  const baseElevation = Math.min(...shown.map((l) => l.elevation), 0);
  const topElevation = levelId === ALL_LEVELS ? baseElevation : (shown[0]?.elevation ?? 0);
  const center = useMemo(() => new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minY + bounds.maxY) / 2), [bounds.minX, bounds.maxX, bounds.minY, bounds.maxY]);
  const glow = useDisposable(glowTexture, []);

  const lights: LitLight[] = [];
  const litRooms = new Set<string>();
  for (const d of data) {
    for (const dev of d.devices) {
      if (deviceKind(dev) !== 'light' || dev.availability === 'offline') continue;
      const l = lightState(dev);
      if (!l?.on) continue;
      const pos = new THREE.Vector3(dev.placement.x, d.level.elevation + SLAB_T + placementHeight(dev.placement, dev), dev.placement.y);
      lights.push({ id: dev.id, pos, color: lightColor(l), level: (l.percent ?? 100) / 100 });
      const room = d.rooms.find((r) => pointInPolygon(dev.placement.x, dev.placement.y, r.polygon));
      if (room) litRooms.add(room.room.id);
    }
  }

  return (
    <div className="absolute inset-0">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.75]}
        camera={{ fov: 40, near: 0.1, far: 400, position: [-8, 12, 12] }}
        gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
        style={{ touchAction: 'none' }}
        onCreated={() => requestAnimationFrame(() => setCreated(true))}
      >
        <ambientLight intensity={palette.ambient} />
        <hemisphereLight args={[dark ? '#4a5470' : '#fffaf2', dark ? '#1a1612' : '#d9cfc2', palette.hemi]} />
        <directionalLight position={[center.x - 6, 14, center.z + 8]} intensity={palette.sun} color={dark ? '#9fb0d8' : '#fff4e2'} />
        {data.map((d, i) => (
          <group key={d.level.id}>
            {(i === 0 || levelId !== ALL_LEVELS) && <Plinth bounds={bounds} elevation={d.level.elevation} palette={palette} />}
            <Floors data={d} palette={palette} litRooms={litRooms} />
            <Walls data={d} palette={palette} center={center} />
            <Pins data={d} palette={palette} />
            {created && <Markers data={d} onOpen={onOpen} large={large} />}
            {created && data.length === 1 && <RoomTags data={d} />}
          </group>
        ))}
        <Lights lights={lights} glow={glow} palette={palette} />
        <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.12} maxPolarAngle={Math.PI * 0.47} minDistance={2.5} maxDistance={90} screenSpacePanning={false} />
        <CameraRig bounds={bounds} elevation={topElevation} resetKey={`${levelId}:${resetKey}:${all.length > 0}`} controls={controls} />
      </Canvas>
      <div className="absolute right-3 bottom-3 flex flex-col gap-1.5">
        <MapButton
          icon="rotateCcw"
          label={t('plan.resetView')}
          onClick={() => setResetKey((n) => n + 1)}
        />
      </div>
    </div>
  );
}
