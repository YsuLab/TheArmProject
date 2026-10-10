// A13: the TypeScript safety / arbitration logic matches the Python test vectors 100 %.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { arbitrate, buildState, emulateTof, extractChoice, patternToDirection, safetyLayer } from "../pipeline";
import type { Grid, Haptic } from "../types";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../shared/test_vectors.json", import.meta.url)), "utf8"),
);
const toGrid = (rows: (number | null)[][]): Grid => rows.map((r) => r.map((v) => (v === null ? Infinity : v)));
const fromGrid = (g: Grid) => g.map((r) => r.map((v) => (Number.isFinite(v) ? v : null)));

describe("A13 — TypeScript port vs Python test vectors", () => {
  it("emulate_tof", () => {
    for (const v of vectors.emulate_tof) {
      const { depth_m, zones, fov_frac, max_range } = v.input;
      expect(fromGrid(emulateTof(depth_m, zones, fov_frac, max_range, 0, null))).toEqual(v.expected);
    }
  });
  it("safety_layer", () => {
    for (const v of vectors.safety_layer) {
      const { grid_m, stop_m, warn_m, ignore_bottom_rows } = v.input;
      const out = safetyLayer(toGrid(grid_m), stop_m, warn_m, ignore_bottom_rows);
      expect(out.haptic).toEqual(v.expected.haptic);
      expect(out.clearance).toEqual(v.expected.clearance);
    }
  });
  it("arbitrate", () => {
    for (const v of vectors.arbitrate) {
      const { safety, decision, clearance, stop_m } = v.input;
      expect(arbitrate(safety as Haptic, decision, clearance, stop_m)).toEqual(v.expected);
    }
  });
  it("build_state", () => {
    for (const v of vectors.build_state) expect(buildState(v.input.goal, v.input.clearance, v.input.objects)).toBe(v.expected);
  });
  it("extract_choice", () => {
    for (const v of vectors.extract_choice) expect(extractChoice(v.input.response, v.input.key)).toEqual(v.expected);
  });
  it("pattern_to_direction", () => {
    for (const v of vectors.pattern_to_direction) expect(patternToDirection(v.input)).toBe(v.expected);
  });
  it("covers every vector", () => {
    const n = ["emulate_tof", "safety_layer", "arbitrate", "build_state", "extract_choice", "pattern_to_direction"]
      .reduce((s, k) => s + vectors[k].length, 0);
    expect(n).toBeGreaterThan(400);
  });
});
