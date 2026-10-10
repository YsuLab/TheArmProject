// Shared types. Field names follow events.jsonl schema v1 (PLAN.md section 0.4).

export type Pattern = "NONE" | "STOP" | "SWEEP_LEFT" | "SWEEP_RIGHT" | "TICK_FORWARD" | "HOT" | "COLD";
export type HubPattern = Exclude<Pattern, "HOT" | "COLD">;
export type Direction = "forward" | "left" | "right" | "stop";
export const DIRECTIONS: Direction[] = ["forward", "left", "right", "stop"];

export interface Haptic {
  pattern: Pattern;
  intensity: number; // 0..1
  source: string; // safety | decision | none
}

/** Distances in metres. 99 = clear beyond max range (as in pipeline.safety_layer). */
export interface Clearance {
  left: number;
  ahead: number;
  right: number;
}

/** 8x8 (zones x zones) grid; Infinity = no target within range. Row 0 = top. */
export type Grid = number[][];

export interface DetectedObject {
  label: string;
  conf: number;
  side: "left" | "ahead" | "right";
  dist_m: number;
}

export interface HeatRecord {
  ir_reported_c: number;
  true_c: number;
  palm_dist_cm: number;
  pattern: "NONE" | "HOT" | "COLD";
}

export interface EventV1 {
  schema_version: 1;
  t: number;
  timings_ms: {
    depth: number | null;
    tof: number | null;
    safety: number | null;
    detect: number | null;
    decision: number | null;
  };
  grid_m: (number | null)[][];
  clearance_m: { left: number | null; ahead: number | null; right: number | null };
  objects: DetectedObject[];
  safety: Haptic;
  decision: { choice: string | null; probabilities: Record<string, number>; latency_ms: number };
  haptic: Haptic;
  expected: Direction | null;
  ultrasonic_m?: number | null;
  heat?: HeatRecord;
  scenario?: string;
}
