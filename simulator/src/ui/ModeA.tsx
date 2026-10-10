import { useEffect, useMemo, useRef, useState } from "react";
import { Glove } from "../core/glove";
import { buildState, MAX_CLEAR } from "../core/pipeline";
import { applyLabels, eventIndexAt, isOverride, parseJsonl, parseLabelsCsv, replayMarkers, replayMetrics } from "../core/recorder";
import type { EventV1, HubPattern } from "../core/types";
import { Sonifier, Vibrator } from "./audio";
import { HandPanel } from "./HandPanel";
import type { RecordedRun } from "./ModeB";
import { DecisionPanel, DepthPanel, GloveControls, HeatModule, MetricsPanel, Timeline } from "./panels";

interface Loaded {
  name: string;
  events: EventV1[];
  videoUrl: string | null;
  report: Record<string, unknown> | null;
  notes: string[];
}

interface SampleEntry {
  id: string;
  title: string;
  files: string[];
}

const HUB = new Set(["NONE", "STOP", "SWEEP_LEFT", "SWEEP_RIGHT", "TICK_FORWARD"]);

async function loadFiles(files: File[], name: string): Promise<Loaded> {
  const notes: string[] = [];
  const by = (pred: (f: File) => boolean) => files.find(pred);
  const ev = by((f) => f.name.endsWith(".jsonl"));
  if (!ev) throw new Error("No events.jsonl among the selected files.");
  const parsed = parseJsonl(await ev.text());
  notes.push(...parsed.errors.slice(0, 5));
  let events = parsed.events;
  const lab = by((f) => f.name.endsWith(".csv"));
  if (lab) {
    events = applyLabels(events, parseLabelsCsv(await lab.text()));
    notes.push(`labels from ${lab.name}`);
  }
  const vid = by((f) => /\.(webm|mp4|mov|m4v)$/i.test(f.name));
  const rep = by((f) => f.name.endsWith("report.json"));
  return {
    name,
    events,
    videoUrl: vid ? URL.createObjectURL(vid) : null,
    report: rep ? JSON.parse(await rep.text()) : null,
    notes,
  };
}

export function ModeA({ incoming }: { incoming: RecordedRun | null }) {
  const [run, setRun] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [prefs, setPrefs] = useState({ rightHand: true, palmDown: true, heatOverStop: true, audio: false, vibrate: false });
  const video = useRef<HTMLVideoElement>(null);
  const glove = useRef(new Glove(null));
  const sonifier = useRef(new Sonifier());
  const vibrator = useRef(new Vibrator());
  const clock = useRef({ t: 0, last: 0 });

  useEffect(() => {
    fetch("samples/index.json")
      .then((r) => (r.ok ? r.json() : []))
      .then(setSamples)
      .catch(() => setSamples([]));
  }, []);

  useEffect(() => {
    if (!incoming) return;
    setRun({
      name: incoming.name,
      events: incoming.events,
      videoUrl: incoming.video ? URL.createObjectURL(incoming.video) : null,
      report: null,
      notes: ["from the Mode B recorder"],
    });
  }, [incoming]);

  useEffect(() => {
    clock.current.t = run?.events[0]?.t ?? 0;
    setT(clock.current.t);
    setPlaying(false);
  }, [run]);

  useEffect(() => {
    glove.current.rightHand = prefs.rightHand;
    glove.current.palmDown = prefs.palmDown;
    glove.current.heatOverStop = prefs.heatOverStop;
    if (prefs.audio) sonifier.current.enable();
    else sonifier.current.disable();
    vibrator.current.enabled = prefs.vibrate;
    if (!prefs.vibrate) vibrator.current.stop();
  }, [prefs]);
  useEffect(
    () => () => {
      sonifier.current.disable();
      vibrator.current.stop();
    },
    [],
  );

  // playback clock: the video drives time when there is one
  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      const c = clock.current;
      const v = video.current;
      if (v && run?.videoUrl && !Number.isNaN(v.duration)) {
        c.t = v.currentTime;
      } else if (playing && run) {
        c.t += ((now - (c.last || now)) / 1000) * speed;
        const end = run.events[run.events.length - 1]?.t ?? 0;
        if (c.t >= end) {
          c.t = end;
          setPlaying(false);
        }
      }
      c.last = now;
      setT(c.t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, run]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.playbackRate = speed;
    if (playing) v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, speed]);

  const metrics = useMemo(() => (run ? replayMetrics(run.events) : null), [run]);
  const markers = useMemo(() => (run ? replayMarkers(run.events) : []), [run]);

  const seek = (nt: number) => {
    clock.current.t = nt;
    if (video.current && run?.videoUrl) video.current.currentTime = nt;
    setT(nt);
  };

  const loadSample = async (s: SampleEntry) => {
    try {
      setError(null);
      const files = await Promise.all(
        s.files.map(async (f) => {
          const r = await fetch(`samples/${s.id}/${f}`);
          if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
          return new File([await r.blob()], f);
        }),
      );
      setRun(await loadFiles(files, s.title));
    } catch (e) {
      setError(String(e));
    }
  };
  const onPick = async (list: FileList | null, label: string) => {
    if (!list?.length) return;
    try {
      setError(null);
      setRun(await loadFiles([...list], label));
    } catch (e) {
      setError(String(e));
    }
  };

  const ev = run && run.events.length ? run.events[eventIndexAt(run.events, t)] : null;
  let gloveOut = null;
  if (ev) {
    const g = glove.current;
    const tMs = t * 1000;
    if (HUB.has(ev.haptic.pattern)) g.receive(ev.haptic.pattern as HubPattern, ev.haptic.intensity, tMs);
    gloveOut = g.update(tMs, ev.heat?.ir_reported_c ?? 25, ev.heat?.palm_dist_cm ?? 60);
    sonifier.current.update(gloveOut.duties, gloveOut.physicalOrder);
    vibrator.current.update(gloveOut.duties);
  }
  const start = run?.events[0]?.t ?? 0;
  const end = run?.events[run.events.length - 1]?.t ?? 1;
  const toNum = (v: number | null) => (v === null ? MAX_CLEAR : v);

  return (
    <div className="mode-grid">
      <section className="panel scene-panel" aria-labelledby="sceneA-h">
        <div className="scene-head">
          <h2 id="sceneA-h">Replay</h2>
          <label className="file-btn">
            Open run folder…
            <input type="file" multiple onChange={(e) => onPick(e.target.files, "folder")} {...{ webkitdirectory: "", directory: "" }} />
          </label>
          <label className="file-btn">
            Open files…
            <input type="file" multiple accept=".jsonl,.csv,.json,.webm,.mp4,.mov" onChange={(e) => onPick(e.target.files, "files")} />
          </label>
          {samples.map((s) => (
            <button key={s.id} onClick={() => loadSample(s)}>
              Sample: {s.title}
            </button>
          ))}
        </div>
        {error && <p className="txt-stop">{error}</p>}
        {!run && (
          <p className="muted">
            Load a <code>pipeline.py</code> output folder (<code>events.jsonl</code>, <code>annotated.mp4/.webm</code>, <code>report.json</code>, optional labels CSV) or a
            Mode B recorder export (<code>*_events.jsonl</code>, <code>*_labels.csv</code>, <code>*_scene.webm</code>). Or record a run in Mode B and press “Open in replay”.
          </p>
        )}
        {run && (
          <>
            <p className="small">
              <strong>{run.name}</strong> · {run.events.length} frames · {(end - start).toFixed(1)} s{ev?.scenario ? ` · ${ev.scenario}` : ""}
              {run.notes.length ? <span className="muted"> · {run.notes.join(" · ")}</span> : null}
            </p>
            {run.videoUrl ? (
              <video
                ref={video}
                src={run.videoUrl}
                className="replay-video"
                muted
                playsInline
                onEnded={() => setPlaying(false)}
                onLoadedMetadata={(e) => {
                  // MediaRecorder WebM has no duration in its header (Infinity) until the end is
                  // read; seeking far forces Chrome to compute it, so scrubbing works.
                  const v = e.currentTarget;
                  if (v.duration === Infinity) {
                    v.currentTime = 1e101;
                    const back = () => {
                      if (!Number.isFinite(v.duration)) return;
                      v.removeEventListener("timeupdate", back);
                      if (v.currentTime >= v.duration - 0.05) v.currentTime = 0; // still parked at the end
                    };
                    v.addEventListener("timeupdate", back);
                  }
                }}
                aria-label="Recorded scene video"
              />
            ) : (
              <div className="no-video">No video in this run — panels replay from events.jsonl alone.</div>
            )}
            <div className="transport">
              <button onClick={() => setPlaying(!playing)} aria-pressed={playing}>
                {playing ? "Pause" : "Play"}
              </button>
              <button onClick={() => seek(start)}>⏮</button>
              <label>
                Speed{" "}
                <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                  {[0.25, 0.5, 1, 2, 4].map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
              {ev && ev.objects.length > 0 && (
                <span className="small">Objects: {ev.objects.map((o) => `${o.label} ${o.side} ${o.dist_m.toFixed(1)} m`).join(" · ")}</span>
              )}
            </div>
          </>
        )}
      </section>

      {gloveOut ? (
        <HandPanel glove={gloveOut} rightHand={prefs.rightHand} palmDown={prefs.palmDown} tMs={t * 1000} />
      ) : (
        <section className="panel hand-panel">
          <h2>Glove</h2>
          <p className="muted">Load a run to drive the hand.</p>
        </section>
      )}

      {ev && (
        <DepthPanel
          grid={ev.grid_m.map((r) => r.map((v) => (v === null ? Infinity : v)))}
          clearance={ev.clearance_m}
          ultrasonic={ev.ultrasonic_m}
          stopM={0.9}
          warnM={2.0}
          maxRange={4.0}
          ignoreBottomRows={2}
        />
      )}
      {ev && (
        <DecisionPanel
          info={{
            state: buildState("(not recorded)", { left: toNum(ev.clearance_m.left), ahead: toNum(ev.clearance_m.ahead), right: toNum(ev.clearance_m.right) }, ev.objects) + "\n[reconstructed from the event]",
            choice: ev.decision.choice,
            lastChoice: ev.decision.choice,
            probabilities: ev.decision.probabilities,
            latencyMs: ev.decision.latency_ms,
            ageMs: null,
            status: ev.decision.choice === null ? "no_answer" : isOverride(ev) ? "overridden" : "accepted",
            reason:
              ev.decision.choice === null
                ? "No fresh model answer on this frame."
                : isOverride(ev)
                  ? `Final cue came from ${ev.haptic.source}, not the model.`
                  : "The model's cue reached the glove.",
          }}
          safety={ev.safety}
          final={ev.haptic}
          expected={ev.expected}
        />
      )}
      <GloveControls {...prefs} vibrateSupported={vibrator.current.supported} onChange={(k, v) => setPrefs({ ...prefs, [k]: v })} />
      {ev && (
        <HeatModule
          readOnly
          handMode={false}
          manual={{ enabled: false, tempC: 25, distCm: 60, material: "matte", diameterM: 0.08, ambientC: 25 }}
          reading={ev.heat ? { ...ev.heat, fill: 0, emissivity: 0, target: null, material: null } : null}
          onChange={() => {}}
        />
      )}
      {metrics && (
        <MetricsPanel
          stages={Object.entries(metrics.stages)}
          rows={[
            ["Frames", String(metrics.frames)],
            ["Decision accuracy vs labels", metrics.accuracy === null ? "no labels" : `${(metrics.accuracy * 100).toFixed(1)} % (${metrics.labeled} frames)`],
            ["Missed STOP frames", String(metrics.missedStops)],
            ["STOP frames", String(metrics.stops)],
            ["Model overridden (frames)", String(metrics.overrides)],
            ["HOT detected", `${metrics.hotDetected} / ${metrics.hotChances} frames`],
            ["COLD detected", `${metrics.coldDetected} / ${metrics.coldChances} frames`],
            ...(run?.report ? ([["report.json", "loaded — see below"]] as [string, string][]) : []),
          ]}
        />
      )}
      {run?.report && (
        <section className="panel">
          <h2>report.json</h2>
          <pre className="state">{JSON.stringify(run.report, null, 2)}</pre>
        </section>
      )}
      {run && <Timeline start={start} end={end} t={t} markers={markers} onSeek={seek} />}
    </div>
  );
}
