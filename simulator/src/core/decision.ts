// Decision models for Mode B: the in-browser stub (same logic and stress options as
// mock-server/MockDecisionServer.java) or a real Jev-compatible endpoint.

import { QUESTIONS, extractChoice } from "./pipeline";
import { Rng } from "./rng";
import type { Direction } from "./types";

export const OPTIONS: Direction[] = ["forward", "left", "right", "stop"];

export interface StubOptions {
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
}

export interface DecisionAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
  latencyMs: number;
  deliberatelyWrong?: boolean;
  error?: string;
}

const CLEARANCE = /\b(left|ahead|right) (?:clear beyond ([0-9.]+) m|([0-9.]+) m)/g;

/** Parse "left X m, ahead Y m, right Z m" out of build_state() text. Missing = 4.0. */
export function parseClearance(state: string): [number, number, number] {
  const c: [number, number, number] = [4, 4, 4];
  const line = state.split("\n").find((l) => l.startsWith("Free space")) ?? state;
  for (const m of line.matchAll(CLEARANCE)) {
    const v = Number(m[2] ?? m[3]);
    if (m[1] === "left") c[0] = v;
    else if (m[1] === "ahead") c[1] = v;
    else c[2] = v;
  }
  return c;
}

/** Identical to MockDecisionServer.decide(). */
export function stubDecide(state: string, wrong: boolean): { choice: Direction; probabilities: Record<string, number>; deliberatelyWrong: boolean } {
  const [left, ahead, right] = parseClearance(state);
  let correct: number;
  if (left < 0.9 && ahead < 0.9 && right < 0.9) correct = 3;
  else if (ahead > 2.0) correct = 0;
  else correct = left > right ? 1 : 2;
  let chosen = correct;
  if (wrong) {
    const clr = [ahead, left, right];
    chosen = -1;
    for (let i = 0; i < 3; i++) {
      if (i === correct) continue;
      if (chosen < 0 || clr[i] < clr[chosen]) chosen = i;
    }
  }
  const raw = [ahead - 2.0, left / 2.0, right / 2.0, 0.9 - Math.min(left, ahead, right)];
  const score = raw.map((v, i) => (i === chosen ? 3.0 : Math.max(-2, Math.min(2, v))));
  const e = score.map((s) => Math.exp(s - 3.0));
  const sum = e.reduce((a, b) => a + b, 0);
  const probabilities: Record<string, number> = {};
  OPTIONS.forEach((o, i) => (probabilities[o] = Math.round((e[i] / sum) * 1e4) / 1e4));
  return { choice: OPTIONS[chosen], probabilities, deliberatelyWrong: chosen !== correct };
}

export class StubModel {
  constructor(public opts: StubOptions, private rng = new Rng(7)) {}
  /** Returns the answer and how long it "takes" (simulated). */
  decide(state: string): DecisionAnswer {
    const delay = Math.max(0, this.opts.latencyMs + (this.opts.jitterMs > 0 ? (this.rng.next() * 2 - 1) * this.opts.jitterMs : 0));
    const wrong = this.rng.next() < this.opts.errorRate;
    const d = stubDecide(state, wrong);
    return { ...d, latencyMs: delay };
  }
}

/** POST {base}/v1/systemone — hosted Jev, a local Jev-style server, or the Java mock. */
export async function callEndpoint(baseUrl: string, model: string, state: string, apiKey?: string, timeoutMs = 5000): Promise<DecisionAnswer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`; // VERIFY auth scheme
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetch(baseUrl.replace(/\/+$/, "") + "/v1/systemone", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, state, questions: QUESTIONS }),
      signal: ctrl.signal,
    });
    const latencyMs = performance.now() - t0;
    if (!r.ok) return { choice: null, probabilities: {}, latencyMs, error: `HTTP ${r.status}` };
    const json = await r.json();
    const { choice, probabilities } = extractChoice(json, "direction");
    return { choice, probabilities, latencyMs, deliberatelyWrong: json?.mock?.deliberately_wrong };
  } catch (e) {
    return { choice: null, probabilities: {}, latencyMs: performance.now() - t0, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
