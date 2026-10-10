# Haptic Guide — wearable assistant for blind users

Software prototype for a shoulder-mounted sensor unit plus a vibrating glove. `PLAN.md` is the
single source of truth for the design; this README covers what has been built from it, how to
run it, and what the simulator has found so far.

**Status (PLAN.md §0.3 build order)**

| Step | What | Status |
|---|---|---|
| 1 | Shared logic + test vectors | Done. `shared/test_vectors.json` (453 vectors) from `pipeline.py`; the TypeScript port matches 100 % (A13) |
| 2 | Mock decision server | Done. `pipeline.py --decision-url http://localhost:8000` runs end to end against it (see note on depth below) |
| 3 | Simulator Mode B | Done. Acceptance tests A1–A13 pass, **except A6's "zero model-caused collisions" criterion** — see [Findings](#findings-from-the-simulator) |
| 4 | Run recorder | Done. Exports `events.jsonl`, `labels.csv`, a WebM of the scene and `report.json` |
| 5 | Simulator Mode A | Done. Replays recorder exports and `pipeline.py` output folders in sync, with scrubbing |
| 6 | Project document | **Not started.** Waiting on the §0.2 answers (deadline, audience, length, team names) |
| 7 | Mode C (Habitat-Sim) | Optional, not started |

## Repository layout

```
PLAN.md                         design, research notes and spec (source of truth)
assets/hand-haptic-map.svg      glove motor map (generated from simulator/src/hand/geometry.ts)
pipeline/pipeline.py            video -> depth -> ToF emulation -> safety -> decision -> events.jsonl
mock-server/MockDecisionServer.java   Jev-compatible mock, Java 21, no dependencies
firmware/glove_sim.ino          glove firmware for the Wokwi ESP32 simulator (+ diagram.json)
shared/                         gen_test_vectors.py -> test_vectors.json
simulator/                      Vite + React + TypeScript simulator (Modes A and B)
  scenarios/S1..S6 *.json       Mode B worlds
  src/core/                     headless engine: shared-logic port, raycast world, heat, glove, model, recorder
  src/ui/                       panels
  public/samples/               runs for Mode A demos
docs/                           test report template (the project document will go here)
data/, runs/                    real recordings + labels / pipeline and recorder outputs (later)
```

## Running it

**Simulator** (Node 18+):

```bash
cd simulator
npm install
npm run dev          # http://localhost:5173
npm test             # vectors, acceptance tests A1–A13, replay, Java-mock parity
npm run build        # static site in simulator/dist
```

Mode B: pick a scenario, walk with ↑ / ← → (↓ steps back). In S5 the mouse moves the hand.
"Autopilot user" walks a simulated user who obeys the glove. "Record" → "Open in replay" sends
the run to Mode A. Mode A also opens a `pipeline.py` output folder or the built-in samples.

**Mock decision server** (Java 21):

```bash
java mock-server/MockDecisionServer.java --port 8000 --latency-ms 150 --jitter-ms 50 --error-rate 0.05
```

In the simulator, Settings → Decision model → Endpoint → `http://localhost:8000` calls it from the browser.

**Pipeline** (Python 3.10+):

```bash
pip install opencv-python numpy pillow torch transformers requests
python pipeline/pipeline.py --video walk.mp4 --out runs/walk1 --decision-url http://localhost:8000 --decision-model mock
```

`--depth-model test-pattern` replaces Depth Anything with a fake brightness-to-distance map so the
plumbing can be tested without downloading model weights. **Its distances are meaningless.** Step 2
was verified this way, because the build environment cannot reach Hugging Face; a real
Depth Anything V2 run has not been done yet. The annotated video is written as `annotated.mp4`
(H.264) when OpenCV can encode it, otherwise `annotated.webm` (VP8), because browsers cannot play
OpenCV's default `mp4v`.

**Test vectors** — after changing `emulate_tof`, `safety_layer`, `arbitrate`, `build_state` or
`extract_choice`: `python3 shared/gen_test_vectors.py`, then mirror the change in
`simulator/src/core/pipeline.ts` until `npm test` passes.

**Firmware** — see `firmware/README.md` (Wokwi). Not compiled here: there is no Arduino toolchain
in the build environment.

## Acceptance tests (PLAN.md §0.8)

All in `simulator/src/core/__tests__/`, run by `npm test`.

| # | Result |
|---|---|
| A1 S1 straight walk | Pass: no STOP, model TICK_FORWARD present, no collisions |
| A2 S2 chair 1.5 m ahead | Pass: SWEEP_RIGHT from the safety layer |
| A3 S3 glass door | Pass: ToF clear, ultrasonic STOP, no collision |
| A4 S4 head-height cabinet door | Pass: STOP from the ToF safety layer, only rows 0–2 see it |
| A5 S6 person crosses at 1 m | Pass: STOP within one sensor frame (≤ 66.7 ms) of entering stop range |
| A6 always-wrong model | **Partial.** Every unsafe answer is overridden and logged (pass). "Zero collisions caused by the model" **fails** — kept as a visible `it.fails` test |
| A7 3000 ms model latency | Pass: stale answers ignored, safety STOP still fires |
| A8 hand → ceramic mug 70 °C | Pass: HOT, strength rises as the hand closes in |
| A9 hand → polished kettle 90 °C | Pass (documented limitation): reads ~35 °C, no HOT |
| A10 palm up during SWEEP_RIGHT | Pass: motor order reverses, the sweep still moves to the user's right |
| A11 HOT and STOP together | Pass: HOT plays (priority 1) |
| A12 sunlight in S2 | Pass: ToF range ≤ 1.5 m; collisions and near-misses recorded |
| A13 TS vs Python vectors | Pass: 100 % match |

## Findings from the simulator

These numbers come from running the simulator (`npx vite-node scripts/findings.ts` in
`simulator/`). They come from simulation, not hardware measurements, and they depend on
modelling choices noted below.

1. **Low obstacles are invisible to the shoulder unit at stop distance.** With the plan's
   defaults (1.45 m mount, 45° vertical FOV, 10° down-tilt), the lowest ray is at about 0.94 m
   height at the 0.9 m stop distance. Walking straight at a box: anything ≤ 0.9 m tall never
   triggered STOP and was hit, with or without `ignore_bottom_rows`. Boxes ≥ 1.05 m triggered STOP
   at a 0.66 m gap. The ultrasonic (30° cone, same tilt) only acts below 0.9 m and sees nothing
   under ~1.0 m there either. "Angle the sensors slightly downward" (§5) is not enough. Low
   obstacles stay the cane's job, unless the sensor is tilted much further or a second,
   lower sensor is added. This should be stated plainly in the document.
2. **A6 is not met by the current arbitration rule.** `arbitrate()` blocks a left/right answer
   only if that side's clearance is below `stop_m` in the current frame. With an always-wrong
   model and the autopilot user, the simulator recorded 16 collisions over 200 one-minute runs
   (3.3 km) where a model cue steered the user into an obstacle the safety layer had within range.
   Two causes showed up: obstacles to the side between stop and warn distance, and a corner
   flickering in and out of the edge columns from frame to frame. An experimental "clearance
   hold" (Settings, default 0 = plan behaviour) cut this to 1–6 per 200 runs, but not to zero, so
   it was not adopted. Separately, 119 collisions in those runs were with obstacles outside the
   sensors' view, mostly low furniture beside the user. Caveat: the autopilot turns at 90°/s while
   walking at half speed on a sweep. A real user's response to a sweep is unknown, so these counts
   only compare rules with each other. They do not predict real-world rates.
3. **The ultrasonic reading between 0.9 m and 2 m is unused.** Per §0.6 it only forces STOP below
   `stop_m`. It does not feed the clearances that arbitration and the model see, even when it is
   the only sensor that sees a low table.
4. **COLD at 5 °C is too strict.** In a 25 °C room at 10 cm, a 4 °C glass bottle reads 6.1 °C and
   a 4 °C matte object reads 5.1 °C, so neither triggers COLD. 0 °C objects do. The S5 cold
   bottle therefore never triggers COLD. The threshold needs tuning with real objects (§7 already
   flags thresholds as "to tune").
5. **Shiny steel**, as expected: the 90 °C polished kettle reads about 35 °C (ε ≈ 0.15, VERIFY)
   and never triggers HOT (A9).
6. **In the kitchen the obstacle cues compete with heat cues.** Standing at the S5 counter, the
   shoulder unit sees it at about 1 m and keeps sending SWEEP cues. HOT/COLD outrank them on the
   glove, but the constant sweeps are noise while the user is handling objects.

## Decisions and deviations from PLAN.md

- `pipeline.py`: heavy imports (`cv2`, `PIL`, `transformers`) moved inside functions so the shared
  logic imports with numpy alone. Added `--depth-model test-pattern` for plumbing tests. Video is
  written as browser-playable H.264/VP8 (see above). Logic is unchanged.
- The ToF raycast reports horizontal distance. Whether the VL53L5CX reports radial or
  perpendicular distance is **VERIFY**.
- Simulated object detection is ground truth (conf 1.0) inside a 60° camera view. Collisions
  count when the avatar's 0.25 m circle touches anything with `z_min` below 1.75 m.
- "Ground truth direction" for labels: STOP if the true clearance ahead is below `stop_m`, the
  freer side if below `warn_m`, otherwise toward the goal (±30°) or forward.
- Model answers age from the moment their state was captured. The TTL (1.5 s) applies to that age.
- S5: the goal marker was moved off the counter, and a 4 °C bottle was kept as specified even
  though it never triggers COLD (finding 4).
- Collision attribution (A6) counts a collision as model-caused only if a model cue was active and
  the safety layer had that obstacle in its acting range (ToF rows in use < `warn_m`, or
  ultrasonic < `stop_m`) within the last 0.15 s.

## Still to VERIFY (from PLAN.md, unchanged)

- Jev request/response field names and auth header (`extract_choice`, `DecisionClient`). The mock
  server's response shape is an assumption.
- VL53L5CX field of view and distance convention. Polished-steel emissivity. ARCore depth device support.
- Every source and price in §3 and §8, before they appear in the project document.
