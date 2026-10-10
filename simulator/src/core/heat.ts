// Palm IR thermometer model (PLAN.md section 0.6, "Heat model").
//   spot diameter at d   = 2·d·tan(FOV/2)
//   fill factor          = min(1, object diameter / spot diameter)
//   reported temperature = fill·(ε·T_obj + (1−ε)·T_amb) + (1−fill)·T_amb
// Reflection of the surroundings is folded into (1−ε)·T_amb. Emissivities: world.EMISSIVITY.

import { EMISSIVITY, castRay, type Material, type Obstacle, type Pose } from "./world";
import { COLD_C, HOT_C, WARN_CM } from "./glove";
import type { HeatRecord } from "./types";

export const IR_FOV_DEG = 10; // with the printed tube
export const HAND_HEIGHT_M = 1.0; // reaching height in the S5 kitchen
export const ARM_REACH_M = 0.9;
export const PALM_MAX_CM = 60;
export const PALM_MIN_CM = 2;

export function spotDiameter(distM: number, fovDeg = IR_FOV_DEG) {
  return 2 * distM * Math.tan(((fovDeg / 2) * Math.PI) / 180);
}

export function reportedTemp(tObj: number, emissivity: number, tAmb: number, distM: number, objDiamM: number, fovDeg = IR_FOV_DEG) {
  const spot = spotDiameter(distM, fovDeg);
  const fill = spot <= 0 ? 1 : Math.min(1, objDiamM / spot);
  return { reported: fill * (emissivity * tObj + (1 - emissivity) * tAmb) + (1 - fill) * tAmb, fill };
}

export function heatPattern(reportedC: number, distCm: number): HeatRecord["pattern"] {
  if (distCm >= WARN_CM) return "NONE";
  if (reportedC >= HOT_C) return "HOT";
  if (reportedC <= COLD_C) return "COLD";
  return "NONE";
}

export interface HeatReading extends HeatRecord {
  fill: number;
  emissivity: number;
  target: string | null;
  material: Material | null;
}

const diameterOf = (o: Obstacle) => (o.type === "circle" ? 2 * o.r : Math.min(o.w, o.h));

/**
 * Scene heat (S5): the palm faces away from the body, along avatar → hand. The nearest
 * object at hand height inside the 10° cone is the target.
 */
export function sceneHeat(obstacles: Obstacle[], avatar: Pose, hand: { x: number; y: number }, ambientC: number): HeatReading {
  const aim = Math.atan2(hand.y - avatar.y, hand.x - avatar.x);
  const half = ((IR_FOV_DEG / 2) * Math.PI) / 180;
  let best: { d: number; o: Obstacle } | null = null;
  for (let i = 0; i < 5; i++) {
    const az = aim - half + (2 * half * i) / 4;
    // flat ray at hand height; step back a few cm so an object the hand already touches is found
    const back = 0.05;
    const r = castRay(obstacles, hand.x - back * Math.cos(az), hand.y - back * Math.sin(az), HAND_HEIGHT_M, az, 0, {
      glassTransparent: false,
      includeFloor: false,
      maxRange: PALM_MAX_CM / 100 + back,
    });
    if (r.hit && r.hit !== "floor" && (!best || r.d - back < best.d)) best = { d: Math.max(0, r.d - back), o: r.hit };
  }
  if (!best) {
    return { ir_reported_c: ambientC, true_c: ambientC, palm_dist_cm: PALM_MAX_CM, pattern: "NONE", fill: 0, emissivity: 0, target: null, material: null };
  }
  const material = best.o.material ?? "matte";
  const eps = EMISSIVITY[material];
  const trueC = best.o.temp_c ?? ambientC;
  const distCm = Math.max(PALM_MIN_CM, best.d * 100);
  const { reported, fill } = reportedTemp(trueC, eps, ambientC, distCm / 100, diameterOf(best.o));
  return {
    ir_reported_c: reported,
    true_c: trueC,
    palm_dist_cm: distCm,
    pattern: heatPattern(reported, distCm),
    fill,
    emissivity: eps,
    target: best.o.label ?? null,
    material,
  };
}

export interface ManualHeat {
  enabled: boolean;
  tempC: number; // −10 .. 120
  distCm: number; // 2 .. 60
  material: Material;
  diameterM: number;
  ambientC: number;
}

export const HEAT_MATERIALS: { id: Material; label: string }[] = [
  { id: "matte", label: "Matte mug" },
  { id: "ceramic", label: "Ceramic" },
  { id: "steel_polished", label: "Shiny stainless steel" },
  { id: "glass", label: "Glass" },
];

export function manualHeat(m: ManualHeat): HeatReading {
  const eps = EMISSIVITY[m.material];
  const { reported, fill } = reportedTemp(m.tempC, eps, m.ambientC, m.distCm / 100, m.diameterM);
  return {
    ir_reported_c: reported,
    true_c: m.tempC,
    palm_dist_cm: m.distCm,
    pattern: heatPattern(reported, m.distCm),
    fill,
    emissivity: eps,
    target: "heat module",
    material: m.material,
  };
}
