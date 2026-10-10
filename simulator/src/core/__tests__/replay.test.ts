// Step 4/5: recorder export (events.jsonl + labels.csv) and Mode A replay of both a recorder
// export and a pipeline.py output folder.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyLabels, eventIndexAt, labelAt, labelsCsv, parseJsonl, parseLabelsCsv, replayMarkers, replayMetrics, toJsonl } from "../recorder";
import { scenarioByName } from "../scenarios";
import { Sim } from "../sim";

const sample = (p: string) => readFileSync(fileURLToPath(new URL(`../../../public/samples/${p}`, import.meta.url)), "utf8");

function recordRun(name: string, seconds: number) {
  const sim = new Sim(scenarioByName(name));
  sim.autopilot = true;
  sim.startRecording();
  for (let i = 0; i < seconds * 120; i++) sim.step(1 / 120);
  return sim.stopRecording();
}

describe("recorder export", () => {
  const events = recordRun("S3", 10);

  it("writes schema v1 events at the sensor rate", () => {
    expect(events.length).toBeGreaterThan(140); // 15 Hz x 10 s
    for (const e of events) {
      expect(e.schema_version).toBe(1);
      expect(e.grid_m).toHaveLength(8);
      for (const row of e.grid_m) expect(row).toHaveLength(8);
      expect(["NONE", "STOP", "SWEEP_LEFT", "SWEEP_RIGHT", "TICK_FORWARD"]).toContain(e.haptic.pattern);
      expect(e.scenario).toBe("S3_glass_door");
      expect(e.heat).toBeDefined();
      expect(e.ultrasonic_m === null || typeof e.ultrasonic_m === "number").toBe(true);
    }
    expect(events[0].t).toBeLessThan(1 / 15);
  });

  it("round-trips through events.jsonl", () => {
    const back = parseJsonl(toJsonl(events));
    expect(back.errors).toEqual([]);
    expect(back.events).toEqual(events);
  });

  it("labels.csv reproduces the ground-truth direction of every frame", () => {
    const labels = parseLabelsCsv(labelsCsv(events));
    expect(labels.length).toBeGreaterThan(0);
    for (const e of events) expect(labelAt(labels, e.t)).toBe(e.expected);
    const relabelled = applyLabels(events.map((e) => ({ ...e, expected: null })), labels);
    expect(relabelled.map((e) => e.expected)).toEqual(events.map((e) => e.expected));
  });

  it("Mode A metrics and markers agree with the run", () => {
    const m = replayMetrics(events);
    expect(m.frames).toBe(events.length);
    expect(m.labeled).toBe(events.length);
    expect(m.stops).toBeGreaterThan(0); // the glass door
    expect(replayMarkers(events).some((k) => k.kind === "stop")).toBe(true);
    expect(m.stages.tof.n).toBe(events.length);
  });
});

describe("Mode A sync", () => {
  it("picks the last event at or before the playback time", () => {
    const { events } = parseJsonl(sample("S3_autopilot/events.jsonl"));
    for (const time of [0, 0.05, 1.234, 7.5, 1e9]) {
      const i = eventIndexAt(events, time);
      expect(events[i].t).toBeLessThanOrEqual(Math.max(time, events[0].t));
      if (i + 1 < events.length) expect(events[i + 1].t).toBeGreaterThan(time);
    }
  });

  it("loads a pipeline.py output folder (events.jsonl + labels)", () => {
    const { events, errors } = parseJsonl(sample("pipeline_testpattern/events.jsonl"));
    expect(errors).toEqual([]);
    expect(events.length).toBeGreaterThan(10);
    const labelled = applyLabels(events, parseLabelsCsv(sample("pipeline_testpattern/labels.csv")));
    const m = replayMetrics(labelled);
    const report = JSON.parse(sample("pipeline_testpattern/report.json"));
    expect(m.labeled).toBe(report.labeled_frames);
    expect(m.accuracy).toBeCloseTo(report.accuracy_vs_labels, 3);
    expect(m.missedStops).toBe(report.missed_stops);
    expect(m.stages.decision.n).toBe(report.decision.n);
  });
});
