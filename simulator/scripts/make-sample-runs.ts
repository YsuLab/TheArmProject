// Headless Mode B runs -> public/samples/<id>/ (events.jsonl + labels.csv) for Mode A demos
// and tests. Video is only recorded in the browser.  npx vite-node scripts/make-sample-runs.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { labelsCsv, toJsonl } from "../src/core/recorder";
import { scenarioByName } from "../src/core/scenarios";
import { Sim, type SimConfig } from "../src/core/sim";

const root = fileURLToPath(new URL("../public/samples/", import.meta.url));
const runs: { id: string; title: string; scenario: string; seconds: number; cfg?: Partial<SimConfig> }[] = [
  { id: "S3_autopilot", title: "S3 glass door (autopilot, Mode B recorder)", scenario: "S3", seconds: 20 },
  { id: "S2_wrong_model", title: "S2 office, model always wrong (autopilot)", scenario: "S2", seconds: 30, cfg: { model: { kind: "stub", errorRate: 1, latencyMs: 150, jitterMs: 50 } as SimConfig["model"] } },
];
const index = [
  { id: "pipeline_testpattern", title: "pipeline.py plumbing run (test-pattern depth, mock server)", files: ["events.jsonl", "annotated.webm", "report.json", "labels.csv"] },
];
for (const r of runs) {
  const sim = new Sim(scenarioByName(r.scenario), r.cfg ?? {});
  sim.autopilot = true;
  sim.startRecording();
  for (let i = 0; i < r.seconds * 120; i++) sim.step(1 / 120);
  const events = sim.stopRecording();
  mkdirSync(root + r.id, { recursive: true });
  writeFileSync(`${root}${r.id}/events.jsonl`, toJsonl(events));
  writeFileSync(`${root}${r.id}/labels.csv`, labelsCsv(events));
  index.push({ id: r.id, title: r.title, files: ["events.jsonl", "labels.csv"] });
  console.log(`${r.id}: ${events.length} frames, ${sim.metrics.collisions} collisions`);
}
writeFileSync(root + "index.json", JSON.stringify(index, null, 2) + "\n");
