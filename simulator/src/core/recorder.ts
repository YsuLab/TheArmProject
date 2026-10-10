// events.jsonl (schema v1) + labels.csv: writing (Mode B recorder) and reading (Mode A replay).

import { npPercentile, patternToDirection } from "./pipeline";
import { DIRECTIONS, type Direction, type EventV1 } from "./types";

export function toJsonl(events: EventV1[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

/** labels.csv (start_s,end_s,expected) — the format pipeline.py --labels reads. */
export function labelsCsv(events: EventV1[]): string {
  const rows: string[] = ["start_s,end_s,expected"];
  let start: EventV1 | null = null;
  let prev: EventV1 | null = null;
  for (const e of [...events, null]) {
    if (start && (e === null || e.expected !== start.expected)) {
      if (start.expected) rows.push(`${start.t.toFixed(3)},${prev!.t.toFixed(3)},${start.expected}`);
      start = null;
    }
    if (e && !start) start = e;
    prev = e;
  }
  return rows.join("\n") + "\n";
}

export interface ParseResult {
  events: EventV1[];
  errors: string[];
}

export function parseJsonl(text: string): ParseResult {
  const events: EventV1[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const e = JSON.parse(line);
      if (e.schema_version !== 1) errors.push(`line ${i + 1}: schema_version ${e.schema_version} (expected 1)`);
      if (typeof e.t !== "number" || !Array.isArray(e.grid_m) || !e.haptic) {
        errors.push(`line ${i + 1}: missing t / grid_m / haptic`);
        return;
      }
      e.expected ??= null;
      e.objects ??= [];
      e.decision ??= { choice: null, probabilities: {}, latency_ms: 0 };
      e.safety ??= e.haptic;
      e.timings_ms ??= { depth: null, tof: null, safety: null, detect: null, decision: null };
      e.clearance_m ??= { left: null, ahead: null, right: null };
      events.push(e as EventV1);
    } catch (err) {
      errors.push(`line ${i + 1}: ${String(err)}`);
    }
  });
  events.sort((a, b) => a.t - b.t);
  return { events, errors };
}

export type Label = [number, number, Direction];

export function parseLabelsCsv(text: string): Label[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(",").map((s) => s.trim());
  const [si, ei, xi] = ["start_s", "end_s", "expected"].map((k) => head.indexOf(k));
  if (si < 0 || ei < 0 || xi < 0) throw new Error("labels.csv needs columns start_s,end_s,expected");
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    const exp = c[xi].trim().toLowerCase() as Direction;
    if (!DIRECTIONS.includes(exp)) throw new Error(`bad label "${c[xi]}"`);
    return [Number(c[si]), Number(c[ei]), exp];
  });
}

/** pipeline.label_at */
export function labelAt(labels: Label[], t: number): Direction | null {
  for (const [s, e, exp] of labels) if (s <= t && t <= e) return exp;
  return null;
}

/** Fill `expected` from labels (labels win, as in pipeline.py --labels). */
export function applyLabels(events: EventV1[], labels: Label[]): EventV1[] {
  return events.map((e) => ({ ...e, expected: labelAt(labels, e.t) ?? e.expected }));
}

/** Index of the last event with t <= time (binary search). */
export function eventIndexAt(events: EventV1[], time: number): number {
  let lo = 0;
  let hi = events.length - 1;
  if (hi < 0 || time < events[0].t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (events[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Stat {
  p50: number | null;
  p95: number | null;
  n: number;
}
export function stat(xs: number[]): Stat {
  if (!xs.length) return { p50: null, p95: null, n: 0 };
  return { p50: npPercentile(xs, 50), p95: npPercentile(xs, 95), n: xs.length };
}

export type ReplayMarkerKind = "stop" | "override" | "disagree";

export function isOverride(e: EventV1) {
  return e.decision.choice !== null && e.haptic.source !== "decision";
}

export function replayMarkers(events: EventV1[]): { t: number; kind: ReplayMarkerKind; note: string }[] {
  const out: { t: number; kind: ReplayMarkerKind; note: string }[] = [];
  let prev: EventV1 | null = null;
  for (const e of events) {
    if (e.haptic.pattern === "STOP" && prev?.haptic.pattern !== "STOP") out.push({ t: e.t, kind: "stop", note: `STOP (${e.haptic.source})` });
    if (isOverride(e) && !(prev && isOverride(prev))) out.push({ t: e.t, kind: "override", note: `model "${e.decision.choice}" overridden` });
    const got = patternToDirection(e.haptic.pattern);
    const dis = e.expected !== null && got !== e.expected;
    const prevDis = prev && prev.expected !== null && patternToDirection(prev.haptic.pattern) !== prev.expected;
    if (dis && !prevDis) out.push({ t: e.t, kind: "disagree", note: `expected ${e.expected}, got ${got}` });
    prev = e;
  }
  return out;
}

export interface ReplayMetrics {
  stages: Record<string, Stat>;
  frames: number;
  labeled: number;
  accuracy: number | null;
  missedStops: number;
  stops: number;
  overrides: number;
  hotChances: number;
  hotDetected: number;
  coldChances: number;
  coldDetected: number;
}

export function replayMetrics(events: EventV1[]): ReplayMetrics {
  const stages: Record<string, number[]> = { depth: [], tof: [], safety: [], detect: [], decision: [] };
  let labeled = 0, agree = 0, missedStops = 0, stops = 0, overrides = 0;
  let hotChances = 0, hotDetected = 0, coldChances = 0, coldDetected = 0;
  for (const e of events) {
    for (const k of Object.keys(stages)) {
      const v = (e.timings_ms as Record<string, number | null>)[k];
      if (typeof v === "number") stages[k].push(v);
    }
    const got = patternToDirection(e.haptic.pattern);
    if (e.expected) {
      labeled++;
      if (got === e.expected) agree++;
      if (e.expected === "stop" && got !== "stop") missedStops++;
    }
    if (e.haptic.pattern === "STOP") stops++;
    if (isOverride(e)) overrides++;
    if (e.heat && e.heat.palm_dist_cm < 30) {
      if (e.heat.true_c >= 50) {
        hotChances++;
        if (e.heat.pattern === "HOT") hotDetected++;
      }
      if (e.heat.true_c <= 5) {
        coldChances++;
        if (e.heat.pattern === "COLD") coldDetected++;
      }
    }
  }
  return {
    stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, stat(v)])),
    frames: events.length,
    labeled,
    accuracy: labeled ? agree / labeled : null,
    missedStops,
    stops,
    overrides,
    hotChances,
    hotDetected,
    coldChances,
    coldDetected,
  };
}
