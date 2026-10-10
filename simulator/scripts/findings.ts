// Prints the numbers behind the findings in README.md. All values come from running the
// simulator code; nothing here is measured on hardware.   npx vite-node scripts/findings.ts
import { manualHeat } from "../src/core/heat";
import { scenarioByName } from "../src/core/scenarios";
import { DEFAULT_CONFIG, Sim, type SimConfig } from "../src/core/sim";
import type { Scenario } from "../src/core/world";

// 1. Walk straight at a box of height h (stop as soon as the glove says STOP).
console.log("1) Head-on approach to a box of height h (defaults: tilt 10°, ignore 2 bottom rows, stop 0.9 m)");
for (const h of [0.3, 0.45, 0.75, 0.9, 1.05, 1.2, 1.5]) {
  for (const ignore of [2, 0]) {
    const sc: Scenario = {
      name: "probe", size_m: [10, 4], start: { x: 1, y: 2, heading_deg: 0 }, goal: { x: 9, y: 2, label: "probe" }, ambient_c: 25,
      obstacles: [{ type: "rect", x: 5, y: 1.4, w: 0.6, h: 1.2, z_min: 0, z_max: h, material: "furniture", label: "box" }],
    };
    const sim = new Sim(sc, { model: { ...DEFAULT_CONFIG.model, kind: "off" }, ignoreBottomRows: ignore });
    let firstWarn: number | null = null;
    let stopAt: number | null = null;
    for (let i = 0; i < 8 * 120 && stopAt === null && sim.metrics.collisions === 0; i++) {
      sim.controls.forward = true;
      sim.step(1 / 120);
      const f = sim.frame;
      const gap = 5 - sim.pose.x - 0.25;
      if (f && firstWarn === null && f.final.pattern !== "NONE") firstWarn = gap;
      if (f && f.final.pattern === "STOP") stopAt = gap;
    }
    console.log(`   h=${h.toFixed(2)} m ignore_bottom_rows=${ignore}: first cue at ${firstWarn?.toFixed(2) ?? "never"} m gap, ` +
      `STOP at ${stopAt?.toFixed(2) ?? "never"} m gap, collision=${sim.metrics.collisions > 0}`);
  }
}

// 2. Cold objects.
console.log("\n2) COLD (≤ 5 °C) at 10 cm, 25 °C room, object 8 cm wide");
for (const [mat, t] of [["glass", 4], ["matte", 4], ["glass", 0], ["matte", 0], ["steel_polished", -5]] as const) {
  const r = manualHeat({ enabled: true, tempC: t, distCm: 10, material: mat, diameterM: 0.08, ambientC: 25 });
  console.log(`   ${mat} ${t} °C -> IR ${r.ir_reported_c.toFixed(1)} °C -> ${r.pattern}`);
}

// 3. Always-wrong model, autopilot user, 5 x 60 s per scenario.
console.log("\n3) Model always wrong (error rate 1.0), autopilot user, 5 seeds x 60 s");
for (const name of ["S1", "S2", "S3", "S4", "S6"]) {
  let col = 0, inView = 0, outView = 0, dist = 0, unsafe = 0, overridden = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const sim = new Sim(scenarioByName(name), { seed, model: { kind: "stub", errorRate: 1, latencyMs: 150, jitterMs: 50 } as SimConfig["model"] });
    sim.autopilot = true;
    for (let i = 0; i < 60 * 120; i++) sim.step(1 / 120);
    const m = sim.metrics;
    col += m.collisions; inView += m.modelCollisions; outView += m.outOfViewCollisions; dist += m.distanceM;
    unsafe += m.unsafeAnswers; overridden += m.unsafeOverridden;
  }
  const base = (() => {
    let c = 0, d = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const sim = new Sim(scenarioByName(name), { seed, model: { ...DEFAULT_CONFIG.model, kind: "off" } });
      sim.autopilot = true;
      for (let i = 0; i < 60 * 120; i++) sim.step(1 / 120);
      c += sim.metrics.collisions; d += sim.metrics.distanceM;
    }
    return `${c} collisions / ${d.toFixed(0)} m`;
  })();
  console.log(`   ${name}: ${col} collisions / ${dist.toFixed(0)} m (model cue + obstacle in view: ${inView}; out of view: ${outView}); ` +
    `unsafe answers overridden ${overridden}/${unsafe}; model OFF: ${base}`);
}
