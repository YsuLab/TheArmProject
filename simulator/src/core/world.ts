// Mode B world: scenario format, 2.5D raycasting for the shoulder ToF and ultrasonic
// sensors, collisions and moving obstacles (PLAN.md section 0.6).
//
// Coordinates: metres, x to the right, y DOWN (screen-like). Heading 0 = +x; a positive
// angle turns clockwise on screen, i.e. to the avatar's RIGHT.

import { Rng } from "./rng";
import type { Grid } from "./types";

export type Material = "glass" | "furniture" | "wall" | "door" | "steel_polished" | "ceramic" | "matte" | "plastic" | "person";

export interface ObstacleBase {
  z_min: number;
  z_max: number;
  material?: Material;
  label?: string;
  temp_c?: number;
}
export interface RectObstacle extends ObstacleBase {
  type: "rect";
  x: number; // min corner
  y: number;
  w: number;
  h: number;
}
export interface CircleObstacle extends ObstacleBase {
  type: "circle";
  x: number;
  y: number;
  r: number;
}
export type Obstacle = RectObstacle | CircleObstacle;

export interface Mover {
  label: string;
  r: number;
  path: [number, number][];
  speed: number;
  z_max: number;
}

export interface Scenario {
  name: string;
  title?: string;
  description?: string;
  size_m: [number, number];
  start: { x: number; y: number; heading_deg: number };
  goal: { x: number; y: number; label: string };
  ambient_c: number;
  obstacles: Obstacle[];
  movers?: Mover[];
  /** Hand position controlled by the mouse (S5). */
  hand_mode?: boolean;
}

export const EMISSIVITY: Record<Material, number> = {
  matte: 0.95,
  ceramic: 0.95,
  glass: 0.9,
  steel_polished: 0.15, // ~0.1–0.2 — VERIFY
  plastic: 0.95,
  furniture: 0.9,
  wall: 0.9,
  door: 0.9,
  person: 0.98,
};

export const WALL_HEIGHT = 2.5;
export const AVATAR_RADIUS = 0.25;
export const AVATAR_HEIGHT = 1.75;

export interface Pose {
  x: number;
  y: number;
  heading: number; // radians
}

export interface SensorConfig {
  mountH: number; // 1.45 m
  fovDeg: number; // 45
  tiltDeg: number; // 10 (downward)
  zones: number; // 8
  maxRange: number; // 4.0
  noiseFrac: number; // 0.02
}

const deg = Math.PI / 180;

/** Build the full obstacle list at time t: scenario obstacles + boundary walls + movers. */
export function obstaclesAt(sc: Scenario, t: number): Obstacle[] {
  const [W, H] = sc.size_m;
  const th = 0.2;
  const walls: Obstacle[] = [
    { type: "rect", x: -th, y: -th, w: W + 2 * th, h: th, z_min: 0, z_max: WALL_HEIGHT, material: "wall", label: "wall" },
    { type: "rect", x: -th, y: H, w: W + 2 * th, h: th, z_min: 0, z_max: WALL_HEIGHT, material: "wall", label: "wall" },
    { type: "rect", x: -th, y: 0, w: th, h: H, z_min: 0, z_max: WALL_HEIGHT, material: "wall", label: "wall" },
    { type: "rect", x: W, y: 0, w: th, h: H, z_min: 0, z_max: WALL_HEIGHT, material: "wall", label: "wall" },
  ];
  const movers: Obstacle[] = (sc.movers ?? []).map((m) => {
    const p = moverPosition(m, t);
    return { type: "circle", x: p.x, y: p.y, r: m.r, z_min: 0, z_max: m.z_max, material: "person", label: m.label };
  });
  return [...sc.obstacles, ...walls, ...movers];
}

/** Movers walk their path back and forth at constant speed. */
export function moverPosition(m: Mover, t: number): { x: number; y: number } {
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < m.path.length; i++) {
    const d = Math.hypot(m.path[i + 1][0] - m.path[i][0], m.path[i + 1][1] - m.path[i][1]);
    segs.push(d);
    total += d;
  }
  if (total === 0) return { x: m.path[0][0], y: m.path[0][1] };
  let s = (t * m.speed) % (2 * total);
  if (s > total) s = 2 * total - s;
  for (let i = 0; i < segs.length; i++) {
    if (s <= segs[i] || i === segs.length - 1) {
      const f = segs[i] ? Math.min(1, s / segs[i]) : 0;
      return {
        x: m.path[i][0] + (m.path[i + 1][0] - m.path[i][0]) * f,
        y: m.path[i][1] + (m.path[i + 1][1] - m.path[i][1]) * f,
      };
    }
    s -= segs[i];
  }
  return { x: m.path[0][0], y: m.path[0][1] };
}

/** 2D ray vs obstacle footprint: [entry, exit] distances along the ray, or null. */
export function rayInterval(ox: number, oy: number, dx: number, dy: number, o: Obstacle): [number, number] | null {
  if (o.type === "circle") {
    const fx = ox - o.x;
    const fy = oy - o.y;
    const b = fx * dx + fy * dy;
    const c = fx * fx + fy * fy - o.r * o.r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t0 = -b - sq;
    const t1 = -b + sq;
    if (t1 < 0) return null;
    return [Math.max(0, t0), t1];
  }
  let tmin = -Infinity;
  let tmax = Infinity;
  for (const [o0, d, lo, hi] of [
    [ox, dx, o.x, o.x + o.w],
    [oy, dy, o.y, o.y + o.h],
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (o0 < lo || o0 > hi) return null;
    } else {
      let t1 = (lo - o0) / d;
      let t2 = (hi - o0) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
    }
  }
  if (tmax < Math.max(tmin, 0)) return null;
  return [Math.max(0, tmin), tmax];
}

/**
 * Earliest horizontal distance at which a ray starting at height h0 with slope
 * tanE (rise per metre) is inside [zMin, zMax] while within [d0, d1].
 */
function heightHit(h0: number, tanE: number, zMin: number, zMax: number, d0: number, d1: number): number | null {
  let lo = d0;
  let hi = d1;
  if (Math.abs(tanE) < 1e-12) {
    return h0 >= zMin && h0 <= zMax ? lo : null;
  }
  const a = (zMin - h0) / tanE;
  const b = (zMax - h0) / tanE;
  lo = Math.max(lo, Math.min(a, b));
  hi = Math.min(hi, Math.max(a, b));
  return lo <= hi ? lo : null;
}

export interface RayOpts {
  glassTransparent: boolean;
  includeFloor: boolean;
  maxRange: number;
}

/** One 3D-ish ray: horizontal distance to the first hit, or Infinity. */
export function castRay(
  obstacles: Obstacle[],
  ox: number,
  oy: number,
  h0: number,
  azimuth: number,
  elevation: number,
  opts: RayOpts,
): { d: number; hit: Obstacle | "floor" | null } {
  const dx = Math.cos(azimuth);
  const dy = Math.sin(azimuth);
  const tanE = Math.tan(elevation);
  let best = Infinity;
  let hit: Obstacle | "floor" | null = null;
  if (opts.includeFloor && tanE < 0) {
    best = h0 / -tanE;
    hit = "floor";
  }
  for (const o of obstacles) {
    if (opts.glassTransparent && o.material === "glass") continue;
    const iv = rayInterval(ox, oy, dx, dy, o);
    if (!iv || iv[0] >= best) continue;
    const d = heightHit(h0, tanE, o.z_min, o.z_max, iv[0], Math.min(iv[1], best));
    if (d !== null && d < best) {
      best = d;
      hit = o;
    }
  }
  if (best > opts.maxRange) return { d: Infinity, hit: null };
  return { d: best, hit };
}

/** Angles (radians) of zone centres: column -> azimuth offset, row -> elevation. */
export function zoneAngles(cfg: SensorConfig) {
  const step = cfg.fovDeg / cfg.zones;
  const az = Array.from({ length: cfg.zones }, (_, j) => (-cfg.fovDeg / 2 + (j + 0.5) * step) * deg);
  const el = Array.from({ length: cfg.zones }, (_, i) => (-cfg.tiltDeg + cfg.fovDeg / 2 - (i + 0.5) * step) * deg);
  return { az, el };
}

/**
 * Shoulder ToF: zones x zones rays. Glass is transparent, the floor is returned (that is
 * why ignore_bottom_rows exists), Gaussian noise of noiseFrac x distance.
 * Reports horizontal distance (simplification; the real sensor's distance convention — VERIFY).
 */
export function tofGrid(
  obstacles: Obstacle[],
  pose: Pose,
  cfg: SensorConfig,
  maxRange: number,
  rng: Rng | null,
  onHit?: (row: number, col: number, o: Obstacle) => void,
): Grid {
  const { az, el } = zoneAngles(cfg);
  const grid: Grid = [];
  for (let i = 0; i < cfg.zones; i++) {
    const row: number[] = [];
    for (let j = 0; j < cfg.zones; j++) {
      const r = castRay(obstacles, pose.x, pose.y, cfg.mountH, pose.heading + az[j], el[i], {
        glassTransparent: true,
        includeFloor: true,
        maxRange: Infinity,
      });
      let d = r.d;
      if (onHit && r.hit && r.hit !== "floor" && d <= maxRange) onHit(i, j, r.hit);
      if (rng && cfg.noiseFrac > 0 && Number.isFinite(d)) d = d * (1 + rng.gauss() * cfg.noiseFrac);
      row.push(d > maxRange ? Infinity : d);
    }
    grid.push(row);
  }
  return grid;
}

/** A finer noise-free depth image for the depth panel heatmap (same optics). */
export function depthImage(obstacles: Obstacle[], pose: Pose, cfg: SensorConfig, res: number, maxRange: number): Grid {
  return tofGrid(obstacles, pose, { ...cfg, zones: res, noiseFrac: 0 }, maxRange, null);
}

export const ULTRASONIC = { coneDeg: 30, minM: 0.02, maxM: 4.0, hz: 10 };

/** HC-SR04-like: 30° cone, nearest echo, sees glass, ignores the floor. */
export function ultrasonic(
  obstacles: Obstacle[],
  pose: Pose,
  mountH: number,
  tiltDeg: number,
  rng: Rng | null,
): { d: number | null; hit: Obstacle | null } {
  const half = (ULTRASONIC.coneDeg / 2) * deg;
  let best = Infinity;
  let hit: Obstacle | null = null;
  const N = 9;
  for (let a = 0; a < N; a++) {
    for (let e = 0; e < 5; e++) {
      const az = pose.heading - half + (2 * half * a) / (N - 1);
      const elv = -tiltDeg * deg - half + (2 * half * e) / 4;
      const r = castRay(obstacles, pose.x, pose.y, mountH, az, elv, {
        glassTransparent: false,
        includeFloor: false,
        maxRange: ULTRASONIC.maxM,
      });
      if (r.d < best) {
        best = r.d;
        hit = r.hit === "floor" ? null : r.hit;
      }
    }
  }
  if (!Number.isFinite(best) || best < ULTRASONIC.minM) return { d: null, hit: null };
  if (rng) best *= 1 + rng.gauss() * 0.01;
  return { d: best, hit };
}

/** Distance from the avatar's edge to the nearest body-height obstacle (negative = overlap). */
export function bodyClearance(obstacles: Obstacle[], x: number, y: number, r = AVATAR_RADIUS): { d: number; o: Obstacle | null } {
  let best = Infinity;
  let which: Obstacle | null = null;
  for (const o of obstacles) {
    if (o.z_min >= AVATAR_HEIGHT || o.z_max <= 0) continue;
    let d: number;
    if (o.type === "circle") d = Math.hypot(x - o.x, y - o.y) - o.r - r;
    else {
      const cx = Math.max(o.x, Math.min(x, o.x + o.w));
      const cy = Math.max(o.y, Math.min(y, o.y + o.h));
      d = Math.hypot(x - cx, y - cy) - r;
    }
    if (d < best) {
      best = d;
      which = o;
    }
  }
  return { d: best, o: which };
}

export function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Ground-truth clearance a person would actually walk into: noise-free 2D rays across the
 * sensor's horizontal FOV, everything that intersects body height, glass included.
 * Sectors use the same column split as safety_layer (left 2, ahead 4, right 2 of 8).
 */
export function trueClearance(obstacles: Obstacle[], pose: Pose, cfg: SensorConfig) {
  const body = obstacles.filter((o) => o.z_min < AVATAR_HEIGHT && o.z_max > 0);
  const n = cfg.zones;
  const third = Math.max(1, Math.floor(n / 3));
  const sub = 3; // rays per column
  const out = { left: Infinity, ahead: Infinity, right: Infinity };
  for (let j = 0; j < n; j++) {
    for (let s = 0; s < sub; s++) {
      const off = (-cfg.fovDeg / 2 + ((j + (s + 0.5) / sub) * cfg.fovDeg) / n) * deg;
      const dx = Math.cos(pose.heading + off);
      const dy = Math.sin(pose.heading + off);
      let best = Infinity;
      for (const o of body) {
        const iv = rayInterval(pose.x, pose.y, dx, dy, o);
        if (iv) best = Math.min(best, iv[0]);
      }
      const key = j < third ? "left" : j >= n - third ? "right" : "ahead";
      out[key] = Math.min(out[key], best);
    }
  }
  return out;
}
