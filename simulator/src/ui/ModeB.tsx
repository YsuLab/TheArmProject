import { useCallback, useEffect, useRef, useState } from "react";
import { ARM_REACH_M } from "../core/heat";
import { labelsCsv, stat, toJsonl } from "../core/recorder";
import { SCENARIOS, scenarioByName } from "../core/scenarios";
import { DEFAULT_CONFIG, Sim, type ModelConfig, type SimConfig } from "../core/sim";
import type { EventV1 } from "../core/types";
import { depthImage } from "../core/world";
import { Sonifier, Vibrator } from "./audio";
import { HandPanel } from "./HandPanel";
import { DecisionPanel, DepthPanel, GloveControls, HeatModule, MetricsPanel, Timeline } from "./panels";
import { drawScene, sceneScale } from "./scene";
import { download } from "./util";

export interface RecordedRun {
  name: string;
  events: EventV1[];
  video?: Blob;
}

const KEYMAP: Record<string, "forward" | "back" | "left" | "right"> = {
  ArrowUp: "forward",
  ArrowDown: "back",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "forward",
  s: "back",
  a: "left",
  d: "right",
};

export function ModeB({ onOpenReplay }: { onOpenReplay: (r: RecordedRun) => void }) {
  const [scenario, setScenario] = useState(SCENARIOS[0].name);
  const [cfg, setCfg] = useState<SimConfig>(structuredClone(DEFAULT_CONFIG));
  const [autopilot, setAutopilot] = useState(false);
  const [paused, setPaused] = useState(false);
  const [glovePrefs, setGlovePrefs] = useState({ rightHand: true, palmDown: true, heatOverStop: true, audio: false, vibrate: false });
  const [manual, setManual] = useState(() => new Sim(scenarioByName(SCENARIOS[0].name)).manual);
  const [recState, setRecState] = useState<"idle" | "rec" | "done">("idle");
  const [lastRun, setLastRun] = useState<RecordedRun | null>(null);
  const [, setTick] = useState(0);

  const simRef = useRef<Sim | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trail = useRef<{ x: number; y: number }[]>([]);
  const sonifier = useRef(new Sonifier());
  const vibrator = useRef(new Vibrator());
  const mediaRec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const depthImg = useRef<{ t: number; img: number[][] | null }>({ t: -1, img: null });

  const latest = useRef({ cfg, autopilot, glovePrefs, manual });
  latest.current = { cfg, autopilot, glovePrefs, manual };

  // (re)create the sim on scenario change, new seed or Reset
  const reset = useCallback(() => {
    const { cfg, autopilot, glovePrefs, manual } = latest.current;
    const sim = new Sim(scenarioByName(scenario), structuredClone(cfg));
    sim.autopilot = autopilot;
    sim.glove.rightHand = glovePrefs.rightHand;
    sim.glove.palmDown = glovePrefs.palmDown;
    sim.glove.heatOverStop = glovePrefs.heatOverStop;
    sim.manual = { ...manual, ambientC: sim.scenario.ambient_c };
    if (sim.scenario.hand_mode) sim.hand = { x: sim.pose.x, y: sim.pose.y - 0.5 };
    simRef.current = sim;
    trail.current = [];
    setRecState("idle");
  }, [scenario, cfg.seed]);
  useEffect(reset, [reset]);

  // live config / prefs
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.cfg = { ...sim.cfg, ...cfg, sensor: { ...cfg.sensor }, model: sim.cfg.model };
    sim.setModel(cfg.model);
  }, [cfg]);
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.autopilot = autopilot;
    sim.glove.rightHand = glovePrefs.rightHand;
    sim.glove.palmDown = glovePrefs.palmDown;
    sim.glove.heatOverStop = glovePrefs.heatOverStop;
    sim.manual = { ...manual, ambientC: sim.scenario.ambient_c };
    if (glovePrefs.audio) sonifier.current.enable();
    else sonifier.current.disable();
    vibrator.current.enabled = glovePrefs.vibrate;
    if (!glovePrefs.vibrate) vibrator.current.stop();
  }, [autopilot, glovePrefs, manual]);

  // keyboard
  useEffect(() => {
    const isField = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      return el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.getAttribute("role") === "slider");
    };
    const handle = (down: boolean) => (e: KeyboardEvent) => {
      if (isField(e)) return;
      const k = KEYMAP[e.key];
      if (!k || !simRef.current) return;
      e.preventDefault();
      simRef.current.controls[k] = down;
    };
    const kd = handle(true);
    const ku = handle(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    const blur = () => simRef.current && (simRef.current.controls = { forward: false, back: false, left: false, right: false });
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // animation loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const loop = (now: number) => {
      const sim = simRef.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (sim && !paused) {
        // fixed 1/120 s physics sub-steps keep sensor timing honest at any frame rate
        let rem = dt;
        while (rem > 1e-6) {
          const h = Math.min(1 / 120, rem);
          sim.step(h);
          rem -= h;
        }
        const tp = trail.current;
        const lp = tp[tp.length - 1];
        if (!lp || Math.hypot(lp.x - sim.pose.x, lp.y - sim.pose.y) > 0.05) tp.push({ x: sim.pose.x, y: sim.pose.y });
        if (tp.length > 2000) tp.shift();
      }
      if (sim) {
        const c = canvasRef.current;
        const { ppm } = sceneScale(sim.scenario.size_m);
        if (c) drawScene(c.getContext("2d")!, sim, ppm, trail.current);
        sonifier.current.update(sim.gloveOut.duties, sim.gloveOut.physicalOrder);
        vibrator.current.update(sim.gloveOut.duties);
      }
      if (now - lastUi > 33) {
        lastUi = now;
        setTick((x) => x + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused]);

  useEffect(
    () => () => {
      sonifier.current.disable();
      vibrator.current.stop();
    },
    [],
  );

  const sim = simRef.current;
  if (!sim) return null;
  const sc = sim.scenario;
  const { w, h, ppm } = sceneScale(sc.size_m);
  const f = sim.frame;

  // depth heatmap at ~5 Hz
  if (f && f.t - depthImg.current.t > 0.2) {
    depthImg.current = { t: f.t, img: null };
    depthImg.current.img = depthImage(sim.obstacles(), sim.pose, sim.cfg.sensor, 32, sim.maxRange);
  }

  const onMouse = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!sc.hand_mode) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * w;
    const y = ((e.clientY - r.top) / r.height) * h;
    let hx = x / ppm;
    let hy = y / ppm;
    const d = Math.hypot(hx - sim.pose.x, hy - sim.pose.y);
    if (d > ARM_REACH_M) {
      hx = sim.pose.x + ((hx - sim.pose.x) / d) * ARM_REACH_M;
      hy = sim.pose.y + ((hy - sim.pose.y) / d) * ARM_REACH_M;
    }
    sim.hand = { x: hx, y: hy };
  };

  const startRec = () => {
    sim.startRecording();
    chunks.current = [];
    const c = canvasRef.current;
    if (c && "captureStream" in c && typeof MediaRecorder !== "undefined") {
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(c.captureStream(30), mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (ev) => ev.data.size && chunks.current.push(ev.data);
      mr.start(250);
      mediaRec.current = mr;
    }
    setRecState("rec");
  };
  const stopRec = () => {
    const events = sim.stopRecording();
    const name = `${sc.name}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
    const finish = (video?: Blob) => {
      setLastRun({ name, events, video });
      setRecState("done");
    };
    const mr = mediaRec.current;
    if (mr && mr.state !== "inactive") {
      mr.onstop = () => finish(new Blob(chunks.current, { type: "video/webm" }));
      mr.stop();
    } else finish();
    mediaRec.current = null;
  };

  const m = sim.metrics;
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)} %` : "—");
  const setModel = (patch: Partial<ModelConfig>) => setCfg({ ...cfg, model: { ...cfg.model, ...patch } });

  return (
    <div className="mode-grid">
      <section className="panel scene-panel" aria-labelledby="scene-h">
        <div className="scene-head">
          <h2 id="scene-h">Scene</h2>
          <label>
            <span className="sr-only">Scenario</span>
            <select value={scenario} onChange={(e) => setScenario(e.target.value)} aria-label="Scenario">
              {SCENARIOS.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.title ?? s.name}
                </option>
              ))}
            </select>
          </label>
          <button onClick={reset}>Reset</button>
          <button onClick={() => setPaused(!paused)} aria-pressed={paused}>
            {paused ? "Resume" : "Pause"}
          </button>
          <label className="check">
            <input type="checkbox" checked={autopilot} onChange={(e) => setAutopilot(e.target.checked)} /> Autopilot user
          </label>
          {recState !== "rec" ? (
            <button className="rec" onClick={startRec}>
              ● Record
            </button>
          ) : (
            <button className="rec on" onClick={stopRec}>
              ■ Stop
            </button>
          )}
        </div>
        <p className="muted small">{sc.description}</p>
        <canvas
          ref={canvasRef}
          width={w}
          height={h}
          className="scene-canvas"
          onMouseMove={onMouse}
          tabIndex={0}
          aria-label={`Top-down scene ${sc.title}. Arrow keys: up walks, left/right turn, down steps back.${sc.hand_mode ? " Mouse moves the hand." : ""}`}
        />
        <p className="muted small">
          Keys: ↑ walk · ← → turn · ↓ step back{sc.hand_mode ? " · mouse = hand (reach 0.9 m)" : ""}. Dots = nearest ToF return per column; dashed = ultrasonic cone; dashed outlines = overhead obstacles.
        </p>
        {recState === "done" && lastRun && (
          <div className="recorded">
            <strong>Recorded {lastRun.events.length} frames.</strong>
            <button onClick={() => download(`${lastRun.name}_events.jsonl`, new Blob([toJsonl(lastRun.events)], { type: "application/x-ndjson" }))}>events.jsonl</button>
            <button onClick={() => download(`${lastRun.name}_labels.csv`, new Blob([labelsCsv(lastRun.events)], { type: "text/csv" }))}>labels.csv</button>
            {lastRun.video && <button onClick={() => download(`${lastRun.name}_scene.webm`, lastRun.video!)}>scene.webm</button>}
            <button onClick={() => download(`${lastRun.name}_report.json`, new Blob([JSON.stringify(reportJson(sim), null, 2)], { type: "application/json" }))}>report.json</button>
            <button className="primary" onClick={() => onOpenReplay(lastRun)}>
              Open in replay (Mode A)
            </button>
          </div>
        )}
      </section>

      <HandPanel glove={sim.gloveOut} rightHand={glovePrefs.rightHand} palmDown={glovePrefs.palmDown} tMs={sim.tMs} />

      {f && (
        <DepthPanel
          grid={f.grid}
          depthImage={depthImg.current.img}
          clearance={f.clearance}
          ultrasonic={f.ultrasonic}
          stopM={cfg.stopM}
          warnM={cfg.warnM}
          maxRange={sim.maxRange}
          ignoreBottomRows={cfg.ignoreBottomRows}
        />
      )}
      {f && (
        <DecisionPanel
          info={{ ...f.decision }}
          safety={f.safety}
          safetyBy={f.safetyBy}
          final={f.final}
          expected={f.expected}
          log={sim.overrideLog}
        />
      )}

      <GloveControls
        {...glovePrefs}
        bleLink={cfg.bleLink}
        vibrateSupported={vibrator.current.supported}
        onChange={(k, v) => (k === "bleLink" ? setCfg({ ...cfg, bleLink: v }) : setGlovePrefs({ ...glovePrefs, [k]: v }))}
      />
      <HeatModule manual={manual} reading={sim.heat} handMode={!!sc.hand_mode} onChange={setManual} />

      <section className="panel settings-panel" aria-labelledby="set-h">
        <h2 id="set-h">Settings</h2>
        <fieldset>
          <legend>Decision model</legend>
          <div className="seg" role="group" aria-label="Decision model">
            {(["stub", "endpoint", "off"] as const).map((k) => (
              <button key={k} aria-pressed={cfg.model.kind === k} onClick={() => setModel({ kind: k })}>
                {k === "stub" ? "In-browser stub" : k === "endpoint" ? "Endpoint" : "Off"}
              </button>
            ))}
          </div>
          {cfg.model.kind === "endpoint" && (
            <>
              <label className="slider">
                <span>Base URL</span>
                <input type="url" value={cfg.model.url} onChange={(e) => setModel({ url: e.target.value })} />
                <span />
              </label>
              <label className="slider">
                <span>Model</span>
                <input value={cfg.model.modelName} onChange={(e) => setModel({ modelName: e.target.value })} />
                <span />
              </label>
              <p className="muted small">POST {cfg.model.url.replace(/\/+$/, "")}/v1/systemone · e.g. java mock-server/MockDecisionServer.java --port 8000</p>
            </>
          )}
          {cfg.model.kind === "stub" && (
            <>
              <Slider label="Latency" unit="ms" min={0} max={4000} step={50} value={cfg.model.latencyMs} onChange={(v) => setModel({ latencyMs: v })} />
              <Slider label="Jitter" unit="ms" min={0} max={500} step={10} value={cfg.model.jitterMs} onChange={(v) => setModel({ jitterMs: v })} />
              <Slider label="Error rate" unit="" min={0} max={1} step={0.05} value={cfg.model.errorRate} onChange={(v) => setModel({ errorRate: v })} />
            </>
          )}
          <Slider label="Answer TTL" unit="ms" min={250} max={5000} step={250} value={cfg.ttlMs} onChange={(v) => setCfg({ ...cfg, ttlMs: v })} />
          <Slider label="Clearance hold (exp.)" unit="ms" min={0} max={1000} step={50} value={cfg.clearanceHoldMs} onChange={(v) => setCfg({ ...cfg, clearanceHoldMs: v })} />
        </fieldset>
        <fieldset>
          <legend>Sensors &amp; safety</legend>
          <label className="check">
            <input type="checkbox" checked={cfg.sunlight} onChange={(e) => setCfg({ ...cfg, sunlight: e.target.checked })} /> Strong sunlight (ToF range → {cfg.sunlightRangeM} m, placeholder)
          </label>
          <Slider label="Stop" unit="m" min={0.3} max={2} step={0.05} value={cfg.stopM} onChange={(v) => setCfg({ ...cfg, stopM: v })} />
          <Slider label="Warn" unit="m" min={0.5} max={4} step={0.1} value={cfg.warnM} onChange={(v) => setCfg({ ...cfg, warnM: v })} />
          <Slider label="Ignore bottom rows" unit="" min={0} max={4} step={1} value={cfg.ignoreBottomRows} onChange={(v) => setCfg({ ...cfg, ignoreBottomRows: v })} />
          <Slider label="Sensor tilt (down)" unit="°" min={0} max={30} step={1} value={cfg.sensor.tiltDeg} onChange={(v) => setCfg({ ...cfg, sensor: { ...cfg.sensor, tiltDeg: v } })} />
          <Slider label="ToF noise" unit="%" min={0} max={10} step={0.5} value={cfg.sensor.noiseFrac * 100} onChange={(v) => setCfg({ ...cfg, sensor: { ...cfg.sensor, noiseFrac: v / 100 } })} />
          <Slider label="Walking speed" unit="m/s" min={0.5} max={1.8} step={0.1} value={cfg.walkSpeed} onChange={(v) => setCfg({ ...cfg, walkSpeed: v })} />
          <button onClick={() => setCfg({ ...cfg, seed: cfg.seed + 1 })}>New random seed ({cfg.seed})</button>
        </fieldset>
      </section>

      <MetricsPanel
        stages={[
          ["ToF raycast", stat(m.tofMs)],
          ["safety", stat(m.safetyMs)],
          ["detect (sim)", stat(m.detectMs)],
          ["decision", stat(m.decisionMs)],
          ["safety → motor*", stat(m.safetyToMotorMs)],
        ]}
        rows={[
          ["Decision accuracy vs ground truth", `${pct(m.agree, m.labeled)} (${m.labeled} frames)`],
          ["Missed STOP frames", String(m.missedStops)],
          ["Collisions", `${m.collisions} (${m.distanceM > 0 ? ((m.collisions / m.distanceM) * 100).toFixed(1) : "0"} per 100 m)`],
          ["  … model cue active, obstacle in view", String(m.modelCollisions)],
          ["  … model cue active, obstacle out of view", String(m.outOfViewCollisions)],
          ["Near-misses (< 15 cm)", String(m.nearMisses)],
          ["Distance walked", `${m.distanceM.toFixed(1)} m`],
          ["Model answers / stale", `${m.answers} / ${m.staleAnswers}`],
          ["Unsafe answers overridden", `${m.unsafeOverridden} / ${m.unsafeAnswers}`],
          ["HOT detected (true ≥ 50 °C, < 30 cm)", `${m.hotDetected} / ${m.hotChances} frames`],
          ["COLD detected (true ≤ 5 °C, < 30 cm)", `${m.coldDetected} / ${m.coldChances} frames`],
          ["Goal reached", sim.goalReachedT !== null ? `${sim.goalReachedT.toFixed(1)} s` : "—"],
          ["* simulated compute, excl. BLE radio", ""],
        ]}
      />
      <Timeline start={0} end={Math.max(10, sim.t)} t={sim.t} markers={sim.markers} />
    </div>
  );
}

function Slider(p: { label: string; unit: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>{p.label}</span>
      <input type="range" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(+e.target.value)} />
      <span className="num">
        {Number.isInteger(p.step) ? p.value : p.value.toFixed(2)} {p.unit}
      </span>
    </label>
  );
}

function reportJson(sim: Sim) {
  const m = sim.metrics;
  const s = (xs: number[]) => {
    const r = stat(xs);
    return { p50: r.p50, p95: r.p95, n: r.n };
  };
  return {
    source: "Haptic Guide Simulator — Mode B",
    scenario: sim.scenario.name,
    config: sim.cfg,
    tof: s(m.tofMs),
    safety: s(m.safetyMs),
    decision: s(m.decisionMs),
    safety_to_motor_sim: s(m.safetyToMotorMs),
    accuracy_vs_labels: m.labeled ? m.agree / m.labeled : null,
    missed_stops: m.missedStops,
    labeled_frames: m.labeled,
    collisions: m.collisions,
    model_collisions_in_view: m.modelCollisions,
    model_collisions_out_of_view: m.outOfViewCollisions,
    near_misses: m.nearMisses,
    distance_m: m.distanceM,
    unsafe_answers: m.unsafeAnswers,
    unsafe_overridden: m.unsafeOverridden,
    stale_answers: m.staleAnswers,
    hot: { chances: m.hotChances, detected: m.hotDetected },
    cold: { chances: m.coldChances, detected: m.coldDetected },
  };
}
