// Glove model — a line-for-line port of firmware/glove_sim.ino. The haptic timing table in
// PLAN.md section 0.7 is the single source of truth; this file and the firmware must match it.

import type { HubPattern, Pattern } from "./types";

export const HOT_C = 50.0;
export const COLD_C = 5.0;
export const WARN_CM = 30.0;
export const MIN_CM = 3.0;
export const MIN_DUTY = 80;
export const CUE_TIMEOUT_MS = 1500;
export const POWER_ON_MS = 400;
export const SWEEP_DUTY = 200;
export const TICK_DUTY = 140;

export type Cue = "NONE" | "LEFT" | "RIGHT" | "STOP" | "FORWARD";
export const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"] as const; // motor M1..M5

export const PRIORITY: Record<string, number> = { HOT: 1, COLD: 1, STOP: 2, SWEEP_LEFT: 3, SWEEP_RIGHT: 3, TICK_FORWARD: 4 };

export interface GloveOutput {
  /** Duty 0–255 per motor index (0 = thumb … 4 = pinky). */
  duties: number[];
  /** What is playing: a Pattern, "POWER_ON", or "NONE". */
  pattern: Pattern | "POWER_ON";
  /** 1 = HOT/COLD … 4 = TICK; 0 when idle / power-on. */
  priority: number;
  /** Motor index at each physical position, user's left (0) → right (4). */
  physicalOrder: number[];
  hubCue: Cue;
}

const toCue: Record<HubPattern, Cue> = {
  NONE: "NONE",
  STOP: "STOP",
  SWEEP_LEFT: "LEFT",
  SWEEP_RIGHT: "RIGHT",
  TICK_FORWARD: "FORWARD",
};

export function dutyFromDistance(cm: number): number {
  let s = (WARN_CM - cm) / (WARN_CM - MIN_CM);
  s = Math.min(1, Math.max(0, s));
  return MIN_DUTY + Math.trunc(s * (255 - MIN_DUTY));
}

export class Glove {
  rightHand = true;
  palmDown = true;
  /** HOT/COLD outrank STOP (firmware default). False swaps them — open question 2. */
  heatOverStop = true;
  hubCue: Cue = "NONE";
  cueStart = 0;
  cueIntensity = 1;
  powerOnAt: number | null;

  constructor(powerOnAtMs: number | null = 0) {
    this.powerOnAt = powerOnAtMs;
  }

  /** Motor index at physical position k (0 = user's leftmost finger, 4 = rightmost). */
  physicalToMotor(k: number): number {
    const thumbOnLeft = this.rightHand === this.palmDown;
    return thumbOnLeft ? k : 4 - k;
  }

  /** A cue from the shoulder hub (one per sensor frame over BLE). */
  receive(p: HubPattern, intensity: number, tMs: number) {
    this.hubCue = toCue[p];
    this.cueIntensity = intensity;
    this.cueStart = tMs;
  }

  update(tMs: number, tempC: number, distCm: number): GloveOutput {
    const t = Math.max(0, Math.floor(tMs));
    const duties = [0, 0, 0, 0, 0];
    const physicalOrder = [0, 1, 2, 3, 4].map((k) => this.physicalToMotor(k));
    const out = (pattern: GloveOutput["pattern"]): GloveOutput => ({
      duties,
      pattern,
      priority: PRIORITY[pattern] ?? 0,
      physicalOrder,
      hubCue: this.hubCue,
    });

    if (this.powerOnAt !== null && t - this.powerOnAt < POWER_ON_MS && t >= this.powerOnAt) {
      duties.fill(255);
      return out("POWER_ON");
    }
    if (this.hubCue !== "NONE" && t - this.cueStart > CUE_TIMEOUT_MS) this.hubCue = "NONE";

    const near = distCm < WARN_CM;
    const hot = near && tempC >= HOT_C;
    const cold = near && tempC <= COLD_C;
    const heatFirst = this.heatOverStop || this.hubCue !== "STOP";

    if (heatFirst && hot) {
      duties.fill(Math.floor(t / 80) % 2 === 0 ? dutyFromDistance(distCm) : 0);
      return out("HOT");
    }
    if (heatFirst && cold) {
      const duty = dutyFromDistance(distCm);
      for (let k = 0; k < 5; k++) {
        const phase = ((t % 1200) / 1200.0) * 2 * Math.PI - k * 0.9;
        const v = (Math.sin(phase) + 1) / 2;
        duties[this.physicalToMotor(k)] = Math.trunc(v * duty);
      }
      return out("COLD");
    }
    switch (this.hubCue) {
      case "STOP": {
        const p = t % 1400;
        duties.fill(p < 300 || (p >= 450 && p < 750) ? 255 : 0);
        return out("STOP");
      }
      case "LEFT":
      case "RIGHT": {
        const step = Math.floor(t / 90) % 8; // 5 steps + 3 steps pause
        if (step < 5) {
          const k = this.hubCue === "RIGHT" ? step : 4 - step;
          duties[this.physicalToMotor(k)] = Math.round(SWEEP_DUTY * this.cueIntensity);
        }
        return out(this.hubCue === "RIGHT" ? "SWEEP_RIGHT" : "SWEEP_LEFT");
      }
      case "FORWARD":
        if (t % 1500 < 60) duties[2] = TICK_DUTY;
        return out("TICK_FORWARD");
    }
    return out("NONE");
  }
}
