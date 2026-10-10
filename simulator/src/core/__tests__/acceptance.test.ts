// Simulator acceptance tests A1–A12 (PLAN.md section 0.8). A13 is in vectors.test.ts.
import { describe, expect, it } from "vitest";
import { Glove, dutyFromDistance } from "../glove";
import { scenarioByName } from "../scenarios";
import { Sim, type Frame, type SimConfig } from "../sim";
import { trueClearance } from "../world";

const DT = 1 / 60;
const FRAME_S = 1 / 15;

function make(name: string, cfg: Partial<SimConfig> = {}) {
  return new Sim(scenarioByName(name), cfg);
}

/** Step the sim for `seconds`; `each` runs after every step and may return true to stop early. */
function run(sim: Sim, seconds: number, each?: (s: Sim) => boolean | void) {
  const frames: Frame[] = [];
  let last: Frame | null = null;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT);
    if (sim.frame && sim.frame !== last) frames.push((last = sim.frame));
    if (each?.(sim)) break;
  }
  return frames;
}

/** A user who walks forward and stops the instant the glove plays STOP. */
const walkUntilStop = (s: Sim) => {
  const stop = s.frame?.final.pattern === "STOP";
  s.controls.forward = !stop;
  return stop;
};

describe("Mode B acceptance tests", () => {
  it("A1 — S1 straight walk: no STOP, occasional TICK_FORWARD from the model", () => {
    const sim = make("S1");
    sim.controls.forward = true;
    const frames = run(sim, 9);
    expect(frames.length).toBeGreaterThan(120);
    expect(frames.filter((f) => f.final.pattern === "STOP")).toHaveLength(0);
    const ticks = frames.filter((f) => f.final.pattern === "TICK_FORWARD" && f.final.source === "decision");
    expect(ticks.length).toBeGreaterThan(0);
    expect(sim.metrics.collisions).toBe(0);
  });

  it("A2 — S2 chair 1.5 m ahead, more room on the right: SWEEP_RIGHT from the safety layer", () => {
    const sim = make("S2");
    sim.controls.forward = true;
    const frames = run(sim, 3, (s) => !!s.frame && s.frame.trueAhead <= 1.5);
    const f = frames[frames.length - 1];
    expect(f.trueAhead).toBeGreaterThan(1.35);
    expect(f.safety.pattern).toBe("SWEEP_RIGHT");
    expect(f.safety.source).toBe("safety");
    expect(f.clearance.right).toBeGreaterThan(f.clearance.left);
  });

  it("A3 — S3 glass door: ToF grid clear, ultrasonic STOP before collision", () => {
    const sim = make("S3");
    const frames = run(sim, 8, walkUntilStop);
    const f = frames[frames.length - 1];
    expect(f.final.pattern).toBe("STOP");
    expect(f.safetyBy).toBe("ultrasonic");
    expect(f.safetyTof.pattern).toBe("NONE");
    expect(f.clearance.ahead).toBeGreaterThanOrEqual(sim.cfg.warnM);
    expect(f.pose.x).toBeLessThan(6 - 0.25); // still in front of the glass
    expect(sim.metrics.collisions).toBe(0);
  });

  it("A4 — S4 open cabinet door at head height: STOP from the upper grid rows", () => {
    const sim = make("S4");
    const frames = run(sim, 8, walkUntilStop);
    const f = frames[frames.length - 1];
    expect(f.final.pattern).toBe("STOP");
    expect(f.safetyTof.pattern).toBe("STOP"); // the ToF safety layer itself, not only ultrasonic
    const hitRows = f.grid.map((row, i) => (row.slice(2, 6).some((v) => v < sim.cfg.stopM) ? i : -1)).filter((i) => i >= 0);
    expect(hitRows.length).toBeGreaterThan(0);
    expect(Math.max(...hitRows)).toBeLessThanOrEqual(2); // only rows 0–2 (upper) see it
    expect(sim.metrics.collisions).toBe(0);
  });

  it("A5 — S6 person crosses at 1 m: STOP within one sensor frame of entering stop range", () => {
    const sim = make("S6");
    sim.pose = { x: 3.0, y: 3.0, heading: 0 }; // person's path is at x = 4
    let entered: number | null = null;
    let stopped: number | null = null;
    run(sim, 6, (s) => {
      if (entered === null && trueClearance(s.obstacles(), s.pose, s.cfg.sensor).ahead < s.cfg.stopM) entered = s.t;
      if (entered !== null && s.frame && s.frame.t >= entered && s.frame.final.pattern === "STOP") stopped = s.frame.t;
      return stopped !== null;
    });
    expect(entered).not.toBeNull();
    expect(stopped).not.toBeNull();
    expect(stopped! - entered!).toBeLessThanOrEqual(FRAME_S + 1e-9);
  });

  it("A6 — model always wrong: zero model-caused collisions, every unsafe answer overridden and logged", () => {
    const blind: string[] = [];
    for (const name of ["S1", "S2", "S3", "S4", "S6"]) {
      const sim = make(name, { model: { kind: "stub", errorRate: 1.0, latencyMs: 150, jitterMs: 50 } as SimConfig["model"] });
      sim.autopilot = true;
      const frames = run(sim, 60);
      const m = sim.metrics;
      blind.push(`${name}: ${m.outOfViewCollisions}`);
      expect(m.answers, name).toBeGreaterThan(50);
      expect(m.modelCollisions, name).toBe(0);
      expect(m.unsafeOverridden, name).toBe(m.unsafeAnswers);
      // no frame lets a model cue through while safety says STOP, or into a blocked side
      for (const f of frames) {
        if (f.final.source !== "decision") continue;
        expect(f.safety.pattern, name).not.toBe("STOP");
        if (f.final.pattern === "SWEEP_LEFT") expect(f.clearance.left).toBeGreaterThanOrEqual(sim.cfg.stopM);
        if (f.final.pattern === "SWEEP_RIGHT") expect(f.clearance.right).toBeGreaterThanOrEqual(sim.cfg.stopM);
        if (f.final.pattern === "TICK_FORWARD") expect(f.safety.pattern).toBe("NONE");
      }
      if (m.unsafeAnswers > 0) expect(sim.overrideLog.length, name).toBeGreaterThan(0);
    }
 // Not an arbitration failure, but reported: obstacles outside the shoulder sensors' current view.
    console.log("A6 out-of-view collisions while a model cue was active — " + blind.join(", "));
  });

  it("A7 — 3000 ms model latency: stale answers ignored after 1.5 s, safety still works", () => {
    const sim = make("S6", { model: { kind: "stub", latencyMs: 3000, jitterMs: 0, errorRate: 0 } as SimConfig["model"] });
    sim.pose = { x: 3.0, y: 3.0, heading: 0 };
    const frames = run(sim, 12);
    expect(sim.metrics.staleAnswers).toBeGreaterThan(0);
    for (const f of frames) {
      if (f.decision.choice !== null) expect(f.decision.ageMs!).toBeLessThanOrEqual(1500);
      expect(f.final.source).not.toBe("decision");
    }
    expect(frames.some((f) => f.final.pattern === "STOP" && f.final.source === "safety")).toBe(true);
  });

  const approach = (name: string, x: number, edgeY: number) => {
    const sim = make("S5");
    sim.pose = { x, y: 2.0, heading: -Math.PI / 2 };
    run(sim, 0.5); // let the power-on buzz finish
    const out: { cm: number; reported: number; trueC: number; pattern: string; glove: string; duty: number }[] = [];
    for (let cm = 40; cm >= 3; cm -= 1) {
      sim.hand = { x, y: edgeY + cm / 100 };
      sim.step(DT);
      out.push({ cm: sim.heat.palm_dist_cm, reported: sim.heat.ir_reported_c, trueC: sim.heat.true_c, pattern: sim.heat.pattern, glove: sim.gloveOut.pattern, duty: dutyFromDistance(sim.heat.palm_dist_cm) });
    }
    void name;
    return out;
  };

  it("A8 — S5 hand approaches the ceramic mug: HOT, strength rising as the hand gets closer", () => {
    const r = approach("mug", 3.0, 0.75 + 0.045);
    const near = r.filter((x) => x.cm < 30);
    expect(near.length).toBeGreaterThan(20);
    for (const x of near) {
      expect(x.pattern).toBe("HOT");
      expect(x.glove).toBe("HOT");
    }
    for (const x of r.filter((x) => x.cm > 30.5)) expect(x.pattern).toBe("NONE");
    for (let i = 1; i < near.length; i++) expect(near[i].duty).toBeGreaterThanOrEqual(near[i - 1].duty);
    expect(near[near.length - 1].duty).toBeGreaterThan(near[0].duty);
  });

  it("A9 — S5 hand approaches the polished kettle: reported temp below threshold, no HOT", () => {
    const r = approach("kettle", 2.0, 0.75 + 0.1);
    for (const x of r) {
      expect(x.trueC).toBe(90);
      expect(x.reported).toBeLessThan(50);
      expect(x.pattern).not.toBe("HOT");
      expect(x.glove).not.toBe("HOT");
    }
  });

  it("A10 — palm up while SWEEP_RIGHT plays: motor order reverses, sweep still moves to the user's right", () => {
    const g = new Glove(null);
    const sequence = () => {
      const motors: number[] = [];
      const physical: number[] = [];
      for (let step = 0; step < 5; step++) {
        const t = 10_080 + step * 90 + 45; // 10080 = start of a sweep cycle (multiple of 720)
        g.receive("SWEEP_RIGHT", 1.0, t);
        const o = g.update(t, 25, 60);
        const m = o.duties.findIndex((d) => d > 0);
        motors.push(m);
        physical.push(o.physicalOrder.indexOf(m));
      }
      return { motors, physical };
    };
    const down = sequence();
    g.palmDown = false;
    const up = sequence();
    expect(down.motors).toEqual([0, 1, 2, 3, 4]);
    expect(up.motors).toEqual([4, 3, 2, 1, 0]);
    expect(down.physical).toEqual([0, 1, 2, 3, 4]);
    expect(up.physical).toEqual([0, 1, 2, 3, 4]);
  });

  it("A11 — HOT and STOP at the same time: HOT plays", () => {
    const sim = make("S3");
    sim.manual = { ...sim.manual, enabled: true, tempC: 90, distCm: 10, material: "ceramic" };
    run(sim, 8, walkUntilStop);
    expect(sim.frame!.final.pattern).toBe("STOP");
    expect(sim.heat.pattern).toBe("HOT");
    expect(sim.gloveOut.pattern).toBe("HOT");
    expect(sim.gloveOut.priority).toBe(1);
  });

  it("A12 — sunlight in S2: detection range drops, collisions / near-misses recorded", () => {
    const go = (sunlight: boolean) => {
      const sim = make("S2", { sunlight });
      sim.autopilot = true;
      run(sim, 60);
      return sim.metrics;
    };
    const shade = go(false);
    const sun = go(true);
    expect(shade.maxTofReadingM).toBeGreaterThan(3);
    expect(sun.maxTofReadingM).toBeLessThanOrEqual(1.5);
    for (const m of [shade, sun]) {
      expect(Number.isInteger(m.collisions)).toBe(true);
      expect(Number.isInteger(m.nearMisses)).toBe(true);
      expect(m.distanceM).toBeGreaterThan(5);
    }
    console.log(`A12 S2 60 s autopilot — shade: ${shade.collisions} collisions, ${shade.nearMisses} near-misses, ${shade.distanceM.toFixed(1)} m; ` +
      `sun: ${sun.collisions} collisions, ${sun.nearMisses} near-misses, ${sun.distanceM.toFixed(1)} m`);
  });
});
