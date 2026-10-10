// Depth, decision, heat, glove-control, metrics and timeline panels (shared by Modes A and B).

import { useEffect, useRef } from "react";
import { COLD_C, HOT_C, WARN_CM } from "../core/glove";
import { HEAT_MATERIALS, type HeatReading, type ManualHeat } from "../core/heat";
import { MAX_CLEAR, patternToDirection } from "../core/pipeline";
import type { Stat } from "../core/recorder";
import type { Haptic } from "../core/types";
import type { Material } from "../core/world";

// ----------------------------------------------------------------------------- depth

const fmtM = (v: number | null | undefined) => (v === null || v === undefined || v >= MAX_CLEAR || !Number.isFinite(v) ? "clear" : `${v.toFixed(2)} m`);

function depthColor(d: number, maxRange: number) {
  if (!Number.isFinite(d)) return "rgb(20,24,34)";
  const x = Math.max(0, Math.min(1, d / maxRange));
  // near = hot orange, far = cool blue
  const r = Math.round(255 * (1 - x) + 40 * x);
  const g = Math.round(110 * (1 - x) + 90 * x);
  const b = Math.round(40 * (1 - x) + 200 * x);
  return `rgb(${r},${g},${b})`;
}

export function DepthPanel(props: {
  grid: number[][];
  depthImage?: number[][] | null;
  clearance: { left: number | null; ahead: number | null; right: number | null };
  ultrasonic?: number | null;
  stopM: number;
  warnM: number;
  maxRange: number;
  ignoreBottomRows: number;
}) {
  const { grid, depthImage, clearance, ultrasonic, stopM, warnM, maxRange, ignoreBottomRows } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const img = depthImage ?? grid;
    const n = img.length;
    const s = c.width / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = depthColor(img[i][j], maxRange);
        ctx.fillRect(j * s, i * s, s + 0.5, s + 0.5);
      }
  }, [grid, depthImage, maxRange]);
  const zones = grid.length;
  const bar = (label: string, v: number | null) => {
    const d = v === null || v >= MAX_CLEAR ? maxRange : v;
    const pct = Math.max(0, Math.min(100, (d / maxRange) * 100));
    const cls = d < stopM ? "stop" : d < warnM ? "warn" : "ok";
    return (
      <div className="cbar" key={label}>
        <span>{label}</span>
        <div className="cbar-track" role="meter" aria-valuemin={0} aria-valuemax={maxRange} aria-valuenow={d} aria-label={`${label} clearance`}>
          <div className={`cbar-fill ${cls}`} style={{ width: `${pct}%` }} />
          <div className="cbar-mark" style={{ left: `${(stopM / maxRange) * 100}%` }} title="stop" />
          <div className="cbar-mark warn" style={{ left: `${(warnM / maxRange) * 100}%` }} title="warn" />
        </div>
        <span className="num">{fmtM(v)}</span>
      </div>
    );
  };
  return (
    <section className="panel depth-panel" aria-labelledby="depth-h">
      <h2 id="depth-h">Depth</h2>
      <div className="depth-row">
        <figure>
          <canvas ref={canvas} width={160} height={160} className="depth-canvas" aria-label="depth heatmap" />
          <figcaption>{depthImage ? "depth heatmap (sensor optics)" : "grid as heatmap"}</figcaption>
        </figure>
        <figure>
          <table className="tof-grid" aria-label={`${zones} by ${zones} ToF grid, metres`}>
            <tbody>
              {grid.map((row, i) => (
                <tr key={i} className={i >= zones - ignoreBottomRows ? "ignored" : undefined}>
                  {row.map((v, j) => {
                    const cls = !Number.isFinite(v) ? "inf" : v < stopM ? "stop" : v < warnM ? "warn" : "";
                    const sector = j < Math.floor(zones / 3) ? "l" : j >= zones - Math.floor(zones / 3) ? "r" : "a";
                    return (
                      <td key={j} className={`${cls} s-${sector}`} style={{ background: depthColor(v, maxRange) }}>
                        {Number.isFinite(v) ? v.toFixed(1) : "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <figcaption>8×8 ToF (m) · faded rows ignored (floor)</figcaption>
        </figure>
      </div>
      {bar("Left", clearance.left)}
      {bar("Ahead", clearance.ahead)}
      {bar("Right", clearance.right)}
      {ultrasonic !== undefined && (
        <div className="kv">
          <span>Ultrasonic</span>
          <strong className={ultrasonic !== null && ultrasonic < stopM ? "txt-stop" : undefined}>{ultrasonic === null ? "no echo" : `${ultrasonic.toFixed(2)} m`}</strong>
        </div>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------- decision

export interface DecisionInfo {
  state: string;
  choice: string | null;
  lastChoice: string | null;
  probabilities: Record<string, number>;
  latencyMs: number;
  ageMs: number | null;
  status: string;
  reason: string;
  deliberatelyWrong?: boolean;
  error?: string;
}

const STATUS_TEXT: Record<string, string> = {
  accepted: "ACCEPTED",
  overridden: "OVERRIDDEN",
  stale: "STALE — ignored",
  no_answer: "no answer",
};

export function DecisionPanel(props: {
  info: DecisionInfo;
  safety: Haptic;
  safetyBy?: string | null;
  final: Haptic;
  expected: string | null;
  log?: { t: number; reason: string }[];
}) {
  const { info, safety, safetyBy, final, expected, log } = props;
  const probs = Object.entries(info.probabilities);
  const got = patternToDirection(final.pattern);
  return (
    <section className="panel decision-panel" aria-labelledby="dec-h">
      <h2 id="dec-h">Decision</h2>
      <details open>
        <summary>State sent to the model</summary>
        <pre className="state">{info.state || "—"}</pre>
      </details>
      <div className="kv">
        <span>Model answer</span>
        <strong>
          {info.lastChoice ?? "—"}
          {info.deliberatelyWrong ? <em className="tag bad"> deliberately wrong</em> : null}
        </strong>
      </div>
      <div className="probs">
        {probs.length === 0 && <span className="muted">no probabilities</span>}
        {probs.map(([k, p]) => (
          <div key={k} className="prob">
            <span>{k}</span>
            <div className="prob-track">
              <div className={`prob-fill ${k === info.lastChoice ? "chosen" : ""}`} style={{ width: `${p * 100}%` }} />
            </div>
            <span className="num">{(p * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
      <div className="kv">
        <span>Latency / age</span>
        <strong>
          {info.latencyMs ? `${info.latencyMs.toFixed(0)} ms` : "—"}
          {info.ageMs !== null ? ` · ${(info.ageMs / 1000).toFixed(2)} s old` : ""}
        </strong>
      </div>
      {info.error && <div className="txt-stop small">endpoint error: {info.error}</div>}
      <div className={`arb arb-${info.status}`} role="status">
        <strong>{STATUS_TEXT[info.status] ?? info.status}</strong> {info.reason}
      </div>
      <div className="kv">
        <span>Safety layer</span>
        <strong>
          {safety.pattern} {safety.pattern !== "NONE" ? `(${safety.intensity.toFixed(2)})` : ""} {safetyBy ? `· ${safetyBy}` : ""}
        </strong>
      </div>
      <div className="kv">
        <span>Final cue → glove</span>
        <strong>
          {final.pattern} · {final.source}
        </strong>
      </div>
      {expected && (
        <div className="kv">
          <span>Ground truth</span>
          <strong className={expected === got ? "txt-ok" : "txt-stop"}>
            {expected} {expected === got ? "✓" : `✗ (cue means ${got})`}
          </strong>
        </div>
      )}
      {log && log.length > 0 && (
        <details>
          <summary>Override log ({log.length})</summary>
          <ol className="log">
            {log.slice(-12).reverse().map((l, i) => (
              <li key={i}>
                <span className="num">{l.t.toFixed(1)} s</span> {l.reason}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------- glove controls

export function GloveControls(props: {
  rightHand: boolean;
  palmDown: boolean;
  heatOverStop: boolean;
  bleLink?: boolean;
  audio: boolean;
  vibrate: boolean;
  vibrateSupported: boolean;
  onChange: (k: "rightHand" | "palmDown" | "heatOverStop" | "bleLink" | "audio" | "vibrate", v: boolean) => void;
}) {
  const p = props;
  return (
    <section className="panel controls-panel" aria-labelledby="gc-h">
      <h2 id="gc-h">Glove controls</h2>
      <div className="seg" role="group" aria-label="Hand">
        <button aria-pressed={p.rightHand} onClick={() => p.onChange("rightHand", true)}>Right hand</button>
        <button aria-pressed={!p.rightHand} onClick={() => p.onChange("rightHand", false)}>Left hand</button>
      </div>
      <div className="seg" role="group" aria-label="Palm orientation (IMU)">
        <button aria-pressed={p.palmDown} onClick={() => p.onChange("palmDown", true)}>Palm down</button>
        <button aria-pressed={!p.palmDown} onClick={() => p.onChange("palmDown", false)}>Palm up</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={p.heatOverStop} onChange={(e) => p.onChange("heatOverStop", e.target.checked)} /> HOT/COLD outrank STOP
      </label>
      {p.bleLink !== undefined && (
        <label className="check">
          <input type="checkbox" checked={p.bleLink} onChange={(e) => p.onChange("bleLink", e.target.checked)} /> BLE link to hub (off = cues expire after 1.5 s)
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={p.audio} onChange={(e) => p.onChange("audio", e.target.checked)} /> Sonify motors (5 pitches, panned left→right)
      </label>
      <label className="check">
        <input type="checkbox" checked={p.vibrate} disabled={!p.vibrateSupported} onChange={(e) => p.onChange("vibrate", e.target.checked)} /> Phone vibration
        {!p.vibrateSupported && <span className="muted"> (not supported here)</span>}
      </label>
    </section>
  );
}

// ----------------------------------------------------------------------------- heat

export function HeatModule(props: { manual: ManualHeat; reading: HeatReading | null; handMode: boolean; onChange: (m: ManualHeat) => void; readOnly?: boolean }) {
  const { manual, reading, handMode, onChange, readOnly } = props;
  const set = (patch: Partial<ManualHeat>) => onChange({ ...manual, ...patch });
  const r = reading;
  return (
    <section className="panel heat-panel" aria-labelledby="heat-h">
      <h2 id="heat-h">Heat / cold</h2>
      {!readOnly && (
        <>
          <label className="check">
            <input type="checkbox" checked={manual.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Use sliders
            {handMode && !manual.enabled && <span className="muted"> (now: mouse-controlled hand in the scene)</span>}
          </label>
          <fieldset disabled={!manual.enabled}>
            <label className="slider">
              <span>Object temperature</span>
              <input type="range" min={-10} max={120} value={manual.tempC} onChange={(e) => set({ tempC: +e.target.value })} />
              <span className="num">{manual.tempC} °C</span>
            </label>
            <label className="slider">
              <span>Hand distance</span>
              <input type="range" min={2} max={60} value={manual.distCm} onChange={(e) => set({ distCm: +e.target.value })} />
              <span className="num">{manual.distCm} cm</span>
            </label>
            <label className="slider">
              <span>Material</span>
              <select value={manual.material} onChange={(e) => set({ material: e.target.value as Material })}>
                {HEAT_MATERIALS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <span />
            </label>
          </fieldset>
        </>
      )}
      {r ? (
        <>
          <div className="temps">
            <div>
              <span>True</span>
              <strong>{r.true_c.toFixed(1)} °C</strong>
            </div>
            <div>
              <span>IR reports</span>
              <strong className={r.ir_reported_c >= HOT_C ? "txt-hot" : r.ir_reported_c <= COLD_C ? "txt-cold" : undefined}>{r.ir_reported_c.toFixed(1)} °C</strong>
            </div>
            <div>
              <span>Palm distance</span>
              <strong>{r.palm_dist_cm >= 60 ? "> 60 cm" : `${r.palm_dist_cm.toFixed(0)} cm`}</strong>
            </div>
          </div>
          <div className="kv small">
            <span>Target</span>
            <span>
              {r.target ?? "none"}
              {"emissivity" in r && r.emissivity ? ` · ε ${(r as HeatReading).emissivity.toFixed(2)} · fill ${(r as HeatReading).fill.toFixed(2)}` : ""}
            </span>
          </div>
          <div className={`arb ${r.pattern === "NONE" ? "" : "arb-hot"}`}>
            Pattern: <strong>{r.pattern}</strong> · HOT ≥ {HOT_C} °C, COLD ≤ {COLD_C} °C, within {WARN_CM} cm
            {r.true_c >= HOT_C && r.palm_dist_cm < WARN_CM && r.pattern !== "HOT" && (
              <div className="txt-stop">Missed: the object is hot but the IR sensor reads it below the threshold (low emissivity / small spot fill).</div>
            )}
            {r.true_c <= COLD_C && r.palm_dist_cm < WARN_CM && r.pattern !== "COLD" && (
              <div className="txt-stop">Missed: the object is cold but the reading is above the COLD threshold.</div>
            )}
          </div>
        </>
      ) : (
        <p className="muted">No heat data in this run.</p>
      )}
    </section>
  );
}

// ----------------------------------------------------------------------------- metrics

export function MetricsPanel({ stages, rows }: { stages: [string, Stat][]; rows: [string, string][] }) {
  const f = (v: number | null) => (v === null ? "—" : v < 1 ? v.toFixed(2) : v.toFixed(1));
  return (
    <section className="panel metrics-panel" aria-labelledby="met-h">
      <h2 id="met-h">Metrics</h2>
      <table className="metrics">
        <thead>
          <tr>
            <th scope="col">Stage (ms)</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
            <th scope="col">n</th>
          </tr>
        </thead>
        <tbody>
          {stages.map(([k, s]) => (
            <tr key={k}>
              <th scope="row">{k}</th>
              <td>{f(s.p50)}</td>
              <td>{f(s.p95)}</td>
              <td>{s.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="metric-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ----------------------------------------------------------------------------- timeline

export interface TimelineMarker {
  t: number;
  kind: string;
  note: string;
}

export function Timeline(props: { start: number; end: number; t: number; markers: TimelineMarker[]; onSeek?: (t: number) => void }) {
  const { start, end, t, markers, onSeek } = props;
  const span = Math.max(1e-6, end - start);
  const ref = useRef<HTMLDivElement>(null);
  const seekFromEvent = (clientX: number) => {
    if (!onSeek || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    onSeek(start + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span);
  };
  return (
    <section className="panel timeline-panel" aria-labelledby="tl-h">
      <h2 id="tl-h">
        Timeline <span className="muted small">{t.toFixed(2)} s / {end.toFixed(1)} s</span>
      </h2>
      <div
        ref={ref}
        className={`timeline ${onSeek ? "seekable" : ""}`}
        role={onSeek ? "slider" : undefined}
        tabIndex={onSeek ? 0 : undefined}
        aria-label="Run timeline"
        aria-valuemin={start}
        aria-valuemax={end}
        aria-valuenow={t}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => e.buttons && seekFromEvent(e.clientX)}
        onKeyDown={(e) => {
          if (!onSeek) return;
          if (e.key === "ArrowLeft") onSeek(Math.max(start, t - 1));
          if (e.key === "ArrowRight") onSeek(Math.min(end, t + 1));
        }}
      >
        {markers.map((m, i) => (
          <div key={i} className={`tl-mark tl-${m.kind}`} style={{ left: `${((m.t - start) / span) * 100}%` }} title={`${m.t.toFixed(2)} s — ${m.note}`} />
        ))}
        <div className="tl-head" style={{ left: `${((t - start) / span) * 100}%` }} />
      </div>
      <div className="legend small">
        <span className="lg lg-stop">STOP fired</span>
        <span className="lg lg-override">model overridden</span>
        <span className="lg lg-disagree">label disagrees</span>
        <span className="lg lg-collision">collision</span>
      </div>
    </section>
  );
}
