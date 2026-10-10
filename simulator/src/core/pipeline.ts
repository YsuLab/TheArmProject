// TypeScript port of the shared logic in pipeline/pipeline.py.
// Must reproduce shared/test_vectors.json exactly (acceptance test A13) — change the
// Python first, regenerate the vectors, then mirror the change here.

import type { Clearance, DetectedObject, Grid, Haptic } from "./types";

export const MAX_CLEAR = 99.0; // stand-in for "no target" used by safety_layer

/** numpy.percentile(values, q) with the default 'linear' method. */
export function npPercentile(values: number[], q: number): number {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  const virtual = (n - 1) * (q / 100);
  const prev = Math.floor(virtual);
  const next = Math.min(prev + 1, n - 1);
  const t = virtual - prev;
  const lo = a[prev];
  const hi = a[next];
  const diff = hi - lo;
  // numpy's _lerp: switches formula at t >= 0.5 for monotonicity
  return t >= 0.5 ? hi - diff * (1 - t) : lo + diff * t;
}

/** pipeline.emulate_tof. `gauss` (standard normal draws) replaces numpy's rng when noise > 0. */
export function emulateTof(
  depth: number[][],
  zones = 8,
  fovFrac = 0.6,
  maxRange = 4.0,
  noise = 0.02,
  gauss: (() => number) | null = null,
): Grid {
  const h = depth.length;
  const w = depth[0].length;
  const ch = Math.trunc(h * fovFrac);
  const cw = Math.trunc(w * fovFrac);
  const y0 = Math.floor((h - ch) / 2);
  const x0 = Math.floor((w - cw) / 2);
  const zh = Math.floor(ch / zones);
  const zw = Math.floor(cw / zones);
  const grid: Grid = [];
  for (let i = 0; i < zones; i++) {
    const row: number[] = [];
    for (let j = 0; j < zones; j++) {
      const cell: number[] = [];
      for (let y = y0 + i * zh; y < y0 + (i + 1) * zh; y++) {
        for (let x = x0 + j * zw; x < x0 + (j + 1) * zw; x++) cell.push(depth[y][x]);
      }
      row.push(Math.fround(npPercentile(cell, 10))); // grid is float32 in Python
    }
    grid.push(row);
  }
  if (gauss && noise > 0) {
    for (const row of grid) for (let j = 0; j < row.length; j++) row[j] = Math.fround(row[j] + Math.fround(gauss() * noise) * row[j]);
  }
  for (const row of grid) for (let j = 0; j < row.length; j++) if (row[j] > maxRange) row[j] = Infinity;
  return grid;
}

function clip(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** pipeline.safety_layer — deterministic obstacle rules, every frame, never waits on a model. */
export function safetyLayer(
  grid: Grid,
  stopM: number,
  warnM: number,
  ignoreBottomRows: number,
): { haptic: Haptic; clearance: Clearance } {
  const rows = ignoreBottomRows ? grid.slice(0, Math.max(0, grid.length - ignoreBottomRows)) : grid;
  const n = grid[0].length;
  const third = Math.max(1, Math.floor(n / 3));
  const minCols = (c0: number, c1: number) => {
    let m = Infinity;
    for (const row of rows) for (let j = c0; j < c1; j++) m = Math.min(m, Number.isFinite(row[j]) ? row[j] : MAX_CLEAR);
    return m; // numpy .min() of an empty slice would raise; rows is never empty with sane settings
  };
  const left = minCols(0, third);
  const ahead = minCols(third, n - third);
  const right = minCols(n - third, n);
  const clearance = { left, ahead, right };
  const strength = (d: number) => clip((warnM - d) / Math.max(warnM - stopM, 1e-6), 0.2, 1.0);

  if (ahead < stopM) return { haptic: { pattern: "STOP", intensity: 1.0, source: "safety" }, clearance };
  if (ahead < warnM) {
    const side = left > right ? "SWEEP_LEFT" : "SWEEP_RIGHT";
    return { haptic: { pattern: side, intensity: strength(ahead), source: "safety" }, clearance };
  }
  return { haptic: { pattern: "NONE", intensity: 0.0, source: "none" }, clearance };
}

/** pipeline.arbitrate — safety always wins; a model decision is only used when it is not unsafe. */
export function arbitrate(safety: Haptic, decision: string | null, clearance: Clearance, stopM: number): Haptic {
  if (safety.pattern === "STOP") return safety;
  if (decision === null) return safety;
  if (decision === "stop") return { pattern: "STOP", intensity: 0.8, source: "decision" };
  if ((decision === "left" || decision === "right") && clearance[decision] < stopM) return safety;
  if (decision === "left") return { pattern: "SWEEP_LEFT", intensity: 0.6, source: "decision" };
  if (decision === "right") return { pattern: "SWEEP_RIGHT", intensity: 0.6, source: "decision" };
  if (safety.pattern !== "NONE") return safety;
  return { pattern: "TICK_FORWARD", intensity: 0.3, source: "decision" };
}

export type ArbitrationStatus = "no_answer" | "stale" | "accepted" | "overridden";

/**
 * Why arbitrate() did what it did (decision panel + override log). Not in pipeline.py;
 * it re-derives the branches of arbitrate() and never changes the outcome.
 * `unsafe` = the answer would have moved the user toward a side/heading the safety
 * layer considers blocked.
 */
export function explainArbitration(
  safety: Haptic,
  fresh: string | null,
  hadStale: boolean,
  clearance: Clearance,
  stopM: number,
): { status: ArbitrationStatus; reason: string; unsafe: boolean } {
  if (fresh === null) {
    return hadStale
      ? { status: "stale", reason: "Model answer older than the TTL — ignored; safety layer only.", unsafe: false }
      : { status: "no_answer", reason: "No model answer yet — safety layer only.", unsafe: false };
  }
  if (safety.pattern === "STOP")
    return {
      status: "overridden",
      reason: `Safety STOP always wins (model said "${fresh}").`,
      unsafe: fresh !== "stop",
    };
  if (fresh === "stop") return { status: "accepted", reason: "Model asked to stop.", unsafe: false };
  if (fresh === "left" || fresh === "right") {
    if (clearance[fresh] < stopM)
      return {
        status: "overridden",
        reason: `Model pointed ${fresh} into a blocked side (${fmtM(clearance[fresh])} < stop ${stopM} m).`,
        unsafe: true,
      };
    return { status: "accepted", reason: `Model direction "${fresh}" is not unsafe.`, unsafe: false };
  }
  if (fresh === "forward") {
    if (safety.pattern !== "NONE")
      return {
        status: "overridden",
        reason: `Model said forward but the safety layer sees an obstacle ahead (${fmtM(clearance.ahead)}).`,
        unsafe: true,
      };
    return { status: "accepted", reason: "Path ahead clear; forward accepted.", unsafe: false };
  }
  return { status: "overridden", reason: `Unrecognised answer "${fresh}" ignored.`, unsafe: false };
}

function fmtM(d: number) {
  return d >= MAX_CLEAR ? "clear" : `${d.toFixed(2)} m`;
}

/** Python's f"{x:.1f}" (round-half-even on exact binary ties, which JS toFixed rounds up). */
export function pyFixed1(x: number): string {
  const s = x.toFixed(1);
  if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) {
    // x = k + 0.25 or k + 0.75: an exact tie at one decimal; choose the even digit
    const down = (Math.floor(x * 10) / 10).toFixed(1);
    const up = (Math.ceil(x * 10) / 10).toFixed(1);
    const lastDigit = (v: string) => Number(v[v.length - 1]);
    return lastDigit(down) % 2 === 0 ? down : up;
  }
  return s;
}

/** pipeline.build_state — scene -> text for the decision model. */
export function buildState(goal: string, clearance: Clearance, objs: DetectedObject[]): string {
  const fmt = (d: number) => (d >= 99 ? "clear beyond 4 m" : `${pyFixed1(d)} m`);
  const lines = [
    `User goal: ${goal}.`,
    `Free space measured by the shoulder sensor: left ${fmt(clearance.left)}, ` +
      `ahead ${fmt(clearance.ahead)}, right ${fmt(clearance.right)}.`,
  ];
  if (objs.length) {
    lines.push("Objects seen: " + objs.map((o) => `${o.label} ${o.side} at about ${pyFixed1(o.dist_m)} m`).join("; ") + ".");
  } else {
    lines.push("No objects detected.");
  }
  return lines.join("\n");
}

type Json = unknown;
const isDict = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const pyTruthy = (v: Json) =>
  !(v === null || v === undefined || v === false || v === 0 || v === "" ||
    (Array.isArray(v) && v.length === 0) || (isDict(v) && Object.keys(v).length === 0));

/** pipeline.extract_choice — defensively pull the winning option + probabilities. VERIFY field names. */
export function extractChoice(resp: Json, key: string): { choice: string | null; probabilities: Record<string, number> } {
  let node: Json = null;
  if (isDict(resp)) {
    for (const container of ["answers", "results", "decisions", "outputs"]) {
      const c = resp[container];
      if (isDict(c) && key in c) {
        node = c[key];
        break;
      }
    }
    if (node === null && isDict(resp[key])) node = resp[key];
  }
  if (!isDict(node)) return { choice: null, probabilities: {} };
  const probs = (pyTruthy(node.probabilities) ? node.probabilities : pyTruthy(node.probs) ? node.probs : {}) as Record<string, number>;
  for (const k of ["choice", "selected", "selected_key", "answer", "value"]) {
    if (typeof node[k] === "string") return { choice: node[k] as string, probabilities: probs };
  }
  if (pyTruthy(probs)) {
    let best: string | null = null;
    for (const [k, v] of Object.entries(probs)) if (best === null || v > probs[best]) best = k;
    return { choice: best, probabilities: probs };
  }
  return { choice: null, probabilities: probs };
}

/** pipeline.pattern_to_direction */
export function patternToDirection(p: string): string {
  return ({ STOP: "stop", SWEEP_LEFT: "left", SWEEP_RIGHT: "right" } as Record<string, string>)[p] ?? "forward";
}

/** pipeline.QUESTIONS — the typed questions sent with every decision request. */
export const QUESTIONS = {
  direction: {
    type: "choice",
    instructions:
      "You guide a blind pedestrian. Choose the safest next movement that also " +
      "makes progress toward the user's goal, using only the supplied state.",
    criteria: {
      forward: "The path straight ahead is clear enough to keep walking.",
      left: "The user should veer or turn left.",
      right: "The user should veer or turn right.",
      stop: "The user should stop because continuing is unsafe or unclear.",
    },
  },
  goal_visible: {
    type: "noul",
    condition: "The thing the user is trying to reach is visible in the scene.",
    threshold: 0.5,
  },
};
