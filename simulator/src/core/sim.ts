// Mode B engine. Deterministic for a given seed (stub model latency is simulated time),
// headless (no DOM), so the UI and the acceptance tests drive exactly the same code.

import { callEndpoint, StubModel, type DecisionAnswer } from "./decision";
import { Glove, type GloveOutput } from "./glove";
import { manualHeat, sceneHeat, type HeatReading, type ManualHeat } from "./heat";
import { arbitrate, buildState, explainArbitration, MAX_CLEAR, patternToDirection, safetyLayer, type ArbitrationStatus } from "./pipeline";
import { Rng } from "./rng";
import type { Clearance, DetectedObject, Direction, EventV1, Grid, Haptic, HubPattern } from "./types";
import {
  AVATAR_RADIUS,
  bodyClearance,
  castRay,
  normAngle,
  obstaclesAt,
  tofGrid,
  trueClearance,
  ultrasonic,
  ULTRASONIC,
  type Obstacle,
  type Pose,
  type Scenario,
  type SensorConfig,
} from "./world";

export interface ModelConfig {
  kind: "stub" | "endpoint" | "off";
  latencyMs: number;
  jitterMs: number;
  errorRate: number;
  url: string;
  modelName: string;
  apiKey?: string;
}

export interface SimConfig {
  stopM: number;
  warnM: number;
  ignoreBottomRows: number;
  sensor: SensorConfig;
  sunlight: boolean;
  sunlightRangeM: number;
  tofHz: number;
  decideEveryMs: number;
  ttlMs: number;
  model: ModelConfig;
  walkSpeed: number;
  turnRateDeg: number;
  bleLink: boolean;
  seed: number;
}

export const DEFAULT_CONFIG: SimConfig = {
  stopM: 0.9,
  warnM: 2.0,
  ignoreBottomRows: 2,
  sensor: { mountH: 1.45, fovDeg: 45, tiltDeg: 10, zones: 8, maxRange: 4.0, noiseFrac: 0.02 },
  sunlight: false,
  sunlightRangeM: 1.5, // placeholder until the outdoor test
  tofHz: 15,
  decideEveryMs: 500,
  ttlMs: 1500,
  model: { kind: "stub", latencyMs: 150, jitterMs: 50, errorRate: 0, url: "http://localhost:8000", modelName: "mock" },
  walkSpeed: 1.4,
  turnRateDeg: 90,
  bleLink: true,
  seed: 1,
};

export interface Controls {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

export interface DecisionView {
  choice: string | null; // fresh answer used this frame
  lastChoice: string | null; // most recent answer, fresh or not
  probabilities: Record<string, number>;
  latencyMs: number;
  ageMs: number | null;
  status: ArbitrationStatus;
  reason: string;
  unsafe: boolean;
  deliberatelyWrong: boolean;
  state: string;
  error?: string;
}

export interface Frame {
  t: number;
  pose: Pose;
  grid: Grid;
  clearance: Clearance;
  ultrasonic: number | null;
  safetyTof: Haptic;
  safety: Haptic;
  safetyBy: "tof" | "ultrasonic" | null;
  objects: DetectedObject[];
  decision: DecisionView;
  final: Haptic;
  expected: Direction;
  trueAhead: number;
  timings: { tof: number; safety: number; detect: number; decision: number | null };
  safetyToMotorMs: number;
}

export interface Marker {
  t: number;
  kind: "stop" | "override" | "disagree" | "collision";
  note: string;
}

export class Metrics {
  tofMs: number[] = [];
  safetyMs: number[] = [];
  detectMs: number[] = [];
  decisionMs: number[] = [];
  safetyToMotorMs: number[] = [];
  labeled = 0;
  agree = 0;
  missedStops = 0;
  collisions = 0;
  /**
   * Collision while a model cue was active AND the obstacle was in the safety sensors' current
   * view (last ~2 frames) — i.e. arbitration had the information and still let the cue through.
   */
  modelCollisions = 0;
  /**
   * Collision while a model cue was active, into an obstacle NOT in the sensors' current view
   * (low and close, or outside the 45° FOV after a turn). Arbitration cannot see these; reported
   * as a sensor-coverage finding.
   */
  outOfViewCollisions = 0;
  nearMisses = 0;
  distanceM = 0;
  answers = 0;
  unsafeAnswers = 0;
  unsafeOverridden = 0;
  overrides = 0;
  staleAnswers = 0;
  hotChances = 0;
  hotDetected = 0;
  coldChances = 0;
  coldDetected = 0;
  maxTofReadingM = 0;
}

interface Pending {
  requestT: number;
  arriveT: number | null; // null = endpoint call still running
  answer: DecisionAnswer | null;
}

const EVENT_DECIMALS = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export class Sim {
  readonly scenario: Scenario;
  cfg: SimConfig;
  t = 0;
  pose: Pose;
  controls: Controls = { forward: false, back: false, left: false, right: false };
  autopilot = false;
  hand: { x: number; y: number } | null = null;
  manual: ManualHeat;
  glove = new Glove(0);
  gloveOut: GloveOutput;
  heat: HeatReading;
  frame: Frame | null = null;
  metrics = new Metrics();
  markers: Marker[] = [];
  overrideLog: { t: number; choice: string; reason: string }[] = [];
  recording: EventV1[] | null = null;
  recordStart = 0;
  lastCollisionT = -1;
  goalReachedT: number | null = null;

  private rng: Rng;
  private model: StubModel;
  private nextTof = 0;
  private nextUs = 0;
  private us: number | null = null;
  private lastRequestT = -1e9;
  private pending: Pending | null = null;
  private latest: { requestT: number; answer: DecisionAnswer } | null = null;
  private decisionMsThisFrame: number | null = null;
  private inContact = false;
  private inNearMiss = false;
  private stopSince: number | null = null;
  private lastSweepRight = true;
  private lastExpected: Direction | null = null;
  /** Obstacle index (in obstaclesAt order) -> last time the safety sensors registered it. */
  private seenBySafety = new Map<number, number>();

  constructor(scenario: Scenario, cfg: Partial<SimConfig> = {}) {
    this.scenario = scenario;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg, sensor: { ...DEFAULT_CONFIG.sensor, ...cfg.sensor }, model: { ...DEFAULT_CONFIG.model, ...cfg.model } };
    this.rng = new Rng(this.cfg.seed);
    this.model = new StubModel(this.cfg.model, new Rng(this.cfg.seed * 7919 + 13));
    const s = scenario.start;
    this.pose = { x: s.x, y: s.y, heading: (s.heading_deg * Math.PI) / 180 };
    this.manual = { enabled: false, tempC: 25, distCm: 40, material: "matte", diameterM: 0.08, ambientC: scenario.ambient_c };
    this.heat = this.readHeat(obstaclesAt(scenario, 0));
    this.gloveOut = this.glove.update(0, this.heat.ir_reported_c, this.heat.palm_dist_cm);
  }

  get tMs() {
    return this.t * 1000;
  }

  /** Change stub options on the fly (UI sliders). */
  setModel(m: Partial<ModelConfig>) {
    Object.assign(this.cfg.model, m);
    this.model.opts = this.cfg.model;
  }

  get maxRange() {
    return this.cfg.sunlight ? Math.min(this.cfg.sunlightRangeM, this.cfg.sensor.maxRange) : this.cfg.sensor.maxRange;
  }

  obstacles(): Obstacle[] {
    return obstaclesAt(this.scenario, this.t);
  }

  startRecording() {
    this.recording = [];
    this.recordStart = this.t;
  }

  stopRecording(): EventV1[] {
    const r = this.recording ?? [];
    this.recording = null;
    return r;
  }

  /** Advance the world by dt seconds (UI calls this per animation frame; tests in a loop). */
  step(dt: number) {
    this.t += dt;
    const obstacles = this.obstacles();

    // ---- avatar motion
    const c = this.autopilot ? this.autopilotControls() : this.controls;
    let speed = 0;
    let turn = 0;
    if (c.forward) speed = this.cfg.walkSpeed;
    if (c.back) speed = -this.cfg.walkSpeed * 0.5;
    if (this.autopilot && (this.gloveOut.pattern === "SWEEP_LEFT" || this.gloveOut.pattern === "SWEEP_RIGHT")) speed *= 0.5;
    if (c.left) turn -= 1;
    if (c.right) turn += 1;
    this.pose.heading = normAngle(this.pose.heading + (turn * this.cfg.turnRateDeg * Math.PI * dt) / 180);
    const nx = this.pose.x + Math.cos(this.pose.heading) * speed * dt;
    const ny = this.pose.y + Math.sin(this.pose.heading) * speed * dt;
    const here = bodyClearance(obstacles, this.pose.x, this.pose.y);
    const there = bodyClearance(obstacles, nx, ny);
    let blocked = false;
    if (speed !== 0 && there.d < 0 && there.d < here.d) blocked = true;
    else if (speed !== 0) {
      this.metrics.distanceM += Math.abs(speed * dt);
      this.pose.x = nx;
      this.pose.y = ny;
    }
    const contact = blocked || bodyClearance(obstacles, this.pose.x, this.pose.y).d < 0;
    if (contact && !this.inContact) {
      this.metrics.collisions++;
      this.lastCollisionT = this.t;
      const hitObj = blocked ? there.o : bodyClearance(obstacles, this.pose.x, this.pose.y).o;
      const seenAt = hitObj ? this.seenBySafety.get(obstacles.indexOf(hitObj)) : undefined;
      const seen = seenAt !== undefined && this.t - seenAt <= 0.15;
      let note = hitObj?.label ?? "obstacle";
      if (this.frame?.final.source === "decision") {
        if (seen) this.metrics.modelCollisions++;
        else this.metrics.outOfViewCollisions++;
        note += seen ? " — model cue active, obstacle in sensor view" : " — model cue active, obstacle out of sensor view";
      } else if (!seen) note += " — obstacle out of sensor view";
      this.markers.push({ t: this.t, kind: "collision", note });
    }
    this.inContact = contact;
    const clr = bodyClearance(obstacles, this.pose.x, this.pose.y).d;
    if (!contact && clr < 0.15 && !this.inNearMiss) {
      this.metrics.nearMisses++;
      this.inNearMiss = true;
    } else if (clr > 0.25) this.inNearMiss = false;
    if (this.goalReachedT === null && Math.hypot(this.pose.x - this.scenario.goal.x, this.pose.y - this.scenario.goal.y) < 0.6) {
      this.goalReachedT = this.t;
    }

    // ---- decision responses arriving
    if (this.pending && this.pending.arriveT !== null && this.t >= this.pending.arriveT && this.pending.answer) {
      this.receiveAnswer(this.pending.requestT, this.pending.answer);
      this.pending = null;
    }

    // ---- ultrasonic (10 Hz) and ToF frames (15 Hz)
    while (this.nextUs <= this.t) {
      const u = ultrasonic(obstacles, this.pose, this.cfg.sensor.mountH, this.cfg.sensor.tiltDeg, this.rng);
      this.us = u.d;
      if (u.hit) this.seenBySafety.set(obstacles.indexOf(u.hit), this.t);
      this.nextUs += 1 / ULTRASONIC.hz;
    }
    if (this.nextTof <= this.t) {
      this.sensorFrame(obstacles);
      while (this.nextTof <= this.t) this.nextTof += 1 / this.cfg.tofHz;
    }

    // ---- glove (runs continuously; heat is decided locally)
    this.heat = this.readHeat(obstacles);
    this.gloveOut = this.glove.update(this.tMs, this.heat.ir_reported_c, this.heat.palm_dist_cm);
  }

  private readHeat(obstacles: Obstacle[]): HeatReading {
    if (this.manual.enabled) return manualHeat({ ...this.manual, ambientC: this.scenario.ambient_c });
    if (this.scenario.hand_mode && this.hand) return sceneHeat(obstacles, this.pose, this.hand, this.scenario.ambient_c);
    const amb = this.scenario.ambient_c;
    return { ir_reported_c: amb, true_c: amb, palm_dist_cm: 60, pattern: "NONE", fill: 0, emissivity: 0, target: null, material: null };
  }

  private receiveAnswer(requestT: number, answer: DecisionAnswer) {
    this.metrics.answers++;
    this.metrics.decisionMs.push(answer.latencyMs);
    this.decisionMsThisFrame = answer.latencyMs;
    if ((this.t - requestT) * 1000 > this.cfg.ttlMs) this.metrics.staleAnswers++;
    this.latest = { requestT, answer };
  }

  private requestDecision(state: string) {
    const m = this.cfg.model;
    if (m.kind === "off" || this.pending) return;
    if ((this.t - this.lastRequestT) * 1000 < this.cfg.decideEveryMs) return;
    this.lastRequestT = this.t;
    if (m.kind === "stub") {
      const answer = this.model.decide(state);
      this.pending = { requestT: this.t, arriveT: this.t + answer.latencyMs / 1000, answer };
    } else {
      const p: Pending = { requestT: this.t, arriveT: null, answer: null };
      this.pending = p;
      callEndpoint(m.url, m.modelName, state, m.apiKey).then((answer) => {
        if (this.pending !== p) return;
        p.answer = answer;
        p.arriveT = this.t; // arrives "now" in sim time (the UI runs in real time)
      });
    }
  }

  private detectObjects(obstacles: Obstacle[]): DetectedObject[] {
    // Simulated detector: labelled obstacles in a 60° camera view, line of sight, ≤ 6 m.
    const out: DetectedObject[] = [];
    for (const o of obstacles) {
      if (!o.label || o.label === "wall") continue;
      const cx = o.type === "circle" ? o.x : o.x + o.w / 2;
      const cy = o.type === "circle" ? o.y : o.y + o.h / 2;
      const bearing = normAngle(Math.atan2(cy - this.pose.y, cx - this.pose.x) - this.pose.heading);
      if (Math.abs(bearing) > (30 * Math.PI) / 180) continue;
      const centre = Math.hypot(cx - this.pose.x, cy - this.pose.y);
      if (centre > 6) continue;
      const r = castRay(obstacles, this.pose.x, this.pose.y, Math.min(o.z_max, 1.45), this.pose.heading + bearing, 0, {
        glassTransparent: o.material !== "glass",
        includeFloor: false,
        maxRange: 6,
      });
      if (r.hit !== o) continue;
      const side = bearing < (-10 * Math.PI) / 180 ? "left" : bearing > (10 * Math.PI) / 180 ? "right" : "ahead";
      out.push({ label: o.label, conf: 1.0, side, dist_m: EVENT_DECIMALS(r.d) });
    }
    out.sort((a, b) => a.dist_m - b.dist_m);
    return out.slice(0, 8);
  }

  expectedDirection(obstacles: Obstacle[]): { dir: Direction; ahead: number } {
    const tc = trueClearance(obstacles, this.pose, this.cfg.sensor);
    if (tc.ahead < this.cfg.stopM) return { dir: "stop", ahead: tc.ahead };
    if (tc.ahead < this.cfg.warnM) return { dir: tc.left > tc.right ? "left" : "right", ahead: tc.ahead };
    const g = this.scenario.goal;
    const bearing = normAngle(Math.atan2(g.y - this.pose.y, g.x - this.pose.x) - this.pose.heading);
    const lim = (30 * Math.PI) / 180;
    return { dir: bearing < -lim ? "left" : bearing > lim ? "right" : "forward", ahead: tc.ahead };
  }

  private sensorFrame(obstacles: Obstacle[]) {
    const cfg = this.cfg;
    const w0 = performance.now();
    const usedRows = cfg.sensor.zones - cfg.ignoreBottomRows;
    const grid = tofGrid(obstacles, this.pose, cfg.sensor, this.maxRange, this.rng, (row, _col, o) => {
      if (row < usedRows) this.seenBySafety.set(obstacles.indexOf(o), this.t);
    });
    const w1 = performance.now();
    const tofOut = safetyLayer(grid, cfg.stopM, cfg.warnM, cfg.ignoreBottomRows);
    let safety = tofOut.haptic;
    let safetyBy: Frame["safetyBy"] = safety.pattern === "NONE" ? null : "tof";
    if (this.us !== null && this.us < cfg.stopM && safety.pattern !== "STOP") {
      safety = { pattern: "STOP", intensity: 1.0, source: "safety" }; // ultrasonic catches glass
      safetyBy = "ultrasonic";
    }
    const w2 = performance.now();
    const objects = this.detectObjects(obstacles);
    const w3 = performance.now();
    const clearance = tofOut.clearance;
    const state = buildState(this.scenario.goal.label ? `reach the ${this.scenario.goal.label}` : "walk forward safely", clearance, objects);

    // decision: freshness by the time the state was captured (TTL), then arbitration
    const ageMs = this.latest ? (this.t - this.latest.requestT) * 1000 : null;
    const fresh = this.latest && ageMs! <= cfg.ttlMs ? this.latest.answer.choice : null;
    const final = arbitrate(safety, fresh, clearance, cfg.stopM);
    const why = explainArbitration(safety, fresh, !!this.latest && ageMs! > cfg.ttlMs, clearance, cfg.stopM);
    if (cfg.bleLink) this.glove.receive(final.pattern as HubPattern, final.intensity, this.tMs);
    this.gloveOut = this.glove.update(this.tMs, this.heat.ir_reported_c, this.heat.palm_dist_cm);
    const w4 = performance.now();

    const { dir: expected, ahead: trueAhead } = this.expectedDirection(obstacles);
    const decision: DecisionView = {
      choice: fresh,
      lastChoice: this.latest?.answer.choice ?? null,
      probabilities: this.latest?.answer.probabilities ?? {},
      latencyMs: this.latest?.answer.latencyMs ?? 0,
      ageMs,
      status: why.status,
      reason: why.reason,
      unsafe: why.unsafe,
      deliberatelyWrong: !!this.latest?.answer.deliberatelyWrong,
      state,
      error: this.latest?.answer.error,
    };
    const frame: Frame = {
      t: this.t,
      pose: { ...this.pose },
      grid,
      clearance,
      ultrasonic: this.us,
      safetyTof: tofOut.haptic,
      safety,
      safetyBy,
      objects,
      decision,
      final,
      expected,
      trueAhead,
      timings: { tof: w1 - w0, safety: w2 - w1, detect: w3 - w2, decision: this.decisionMsThisFrame },
      safetyToMotorMs: w4 - w0 - (w3 - w2),
    };
    this.decisionMsThisFrame = null;
    this.record(frame);
    this.frame = frame;
    this.requestDecision(state);
  }

  private record(f: Frame) {
    const m = this.metrics;
    m.tofMs.push(f.timings.tof);
    m.safetyMs.push(f.timings.safety);
    m.detectMs.push(f.timings.detect);
    m.safetyToMotorMs.push(f.safetyToMotorMs);
    for (const row of f.grid) for (const v of row) if (Number.isFinite(v)) m.maxTofReadingM = Math.max(m.maxTofReadingM, v);

    const got = patternToDirection(f.final.pattern);
    m.labeled++;
    if (got === f.expected) m.agree++;
    if (f.expected === "stop" && got !== "stop") m.missedStops++;
    const isNewAnswer = f.decision.status !== "no_answer" && f.timings.decision !== null;
    if (f.decision.status === "overridden") {
      m.overrides++;
      const last = this.overrideLog[this.overrideLog.length - 1];
      if (!last || f.t - last.t > 0.4 || last.reason !== f.decision.reason) {
        this.overrideLog.push({ t: f.t, choice: f.decision.choice ?? "", reason: f.decision.reason });
        if (this.overrideLog.length > 200) this.overrideLog.shift();
        this.markers.push({ t: f.t, kind: "override", note: f.decision.reason });
      }
    }
    if (isNewAnswer && f.decision.unsafe) {
      m.unsafeAnswers++;
      if (f.final.source !== "decision") m.unsafeOverridden++;
    }
    if (f.final.pattern === "STOP" && (this.markers.length === 0 || !this.recentMarker("stop", f.t, 0.5))) {
      this.markers.push({ t: f.t, kind: "stop", note: `STOP (${f.final.source}${f.safetyBy === "ultrasonic" ? ", ultrasonic" : ""})` });
    }
    if (got !== f.expected && (this.lastExpected !== f.expected || !this.recentMarker("disagree", f.t, 0.5))) {
      this.markers.push({ t: f.t, kind: "disagree", note: `expected ${f.expected}, got ${got}` });
    }
    this.lastExpected = f.expected;
    if (this.markers.length > 2000) this.markers.splice(0, this.markers.length - 2000);

    const h = this.heat;
    if (h.palm_dist_cm < 30 && h.true_c >= 50) {
      m.hotChances++;
      if (h.pattern === "HOT") m.hotDetected++;
    }
    if (h.palm_dist_cm < 30 && h.true_c <= 5) {
      m.coldChances++;
      if (h.pattern === "COLD") m.coldDetected++;
    }

    if (this.recording) {
      const nullable = (v: number) => (v >= MAX_CLEAR ? null : EVENT_DECIMALS(v));
      this.recording.push({
        schema_version: 1,
        t: EVENT_DECIMALS(f.t - this.recordStart, 3),
        timings_ms: {
          depth: null,
          tof: EVENT_DECIMALS(f.timings.tof),
          safety: EVENT_DECIMALS(f.timings.safety),
          detect: EVENT_DECIMALS(f.timings.detect),
          decision: f.timings.decision === null ? null : EVENT_DECIMALS(f.timings.decision, 1),
        },
        grid_m: f.grid.map((r) => r.map((v) => (Number.isFinite(v) ? EVENT_DECIMALS(v) : null))),
        clearance_m: { left: nullable(f.clearance.left), ahead: nullable(f.clearance.ahead), right: nullable(f.clearance.right) },
        objects: f.objects,
        safety: { ...f.safety, intensity: EVENT_DECIMALS(f.safety.intensity, 3) },
        decision: { choice: f.decision.choice, probabilities: f.decision.probabilities, latency_ms: EVENT_DECIMALS(f.decision.latencyMs, 1) },
        haptic: { ...f.final, intensity: EVENT_DECIMALS(f.final.intensity, 3) },
        expected: f.expected,
        ultrasonic_m: f.ultrasonic === null ? null : EVENT_DECIMALS(f.ultrasonic),
        heat: {
          ir_reported_c: EVENT_DECIMALS(this.heat.ir_reported_c, 1),
          true_c: EVENT_DECIMALS(this.heat.true_c, 1),
          palm_dist_cm: EVENT_DECIMALS(this.heat.palm_dist_cm, 1),
          pattern: this.heat.pattern,
        },
        scenario: this.scenario.name,
      });
    }
  }

  private recentMarker(kind: Marker["kind"], t: number, within: number) {
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const mk = this.markers[i];
      if (t - mk.t > within) return false;
      if (mk.kind === kind) return true;
    }
    return false;
  }

  /**
   * Simulated user who obeys the glove (tests and demos): STOP = stand still, then turn
   * in place after 1 s; sweep = turn that way while walking at half speed; otherwise walk.
   */
  private autopilotControls(): Controls {
    const p = this.gloveOut.pattern;
    const c: Controls = { forward: false, back: false, left: false, right: false };
    if (p === "STOP") {
      this.stopSince ??= this.t;
      if (this.t - this.stopSince > 1.0) {
        c.right = this.lastSweepRight;
        c.left = !this.lastSweepRight;
      }
      return c;
    }
    this.stopSince = null;
    if (p === "HOT" || p === "COLD" || p === "POWER_ON") return c;
    if (p === "SWEEP_LEFT" || p === "SWEEP_RIGHT") {
      this.lastSweepRight = p === "SWEEP_RIGHT";
      c.right = this.lastSweepRight;
      c.left = !this.lastSweepRight;
    }
    c.forward = true;
    return c;
  }
}

export { AVATAR_RADIUS };
