#!/usr/bin/env python3
"""
Blind-assist device — software-only pipeline prototype.

    recorded video (phone on shoulder)
      -> metric depth (Depth Anything V2)
      -> emulated 8x8 ToF grid (stands in for a VL53L5CX)
      -> SAFETY LAYER (deterministic rules, never waits for a model)
      -> optional object detection (YOLO)
      -> DECISION MODEL via a Jev-compatible /v1/systemone endpoint
         (hosted Jev as baseline, or a local Jev-style server such as Kev)
      -> arbitration -> haptic pattern for the glove
      -> events.jsonl (replayed by the simulator UI) + latency report

Install:
    pip install opencv-python numpy pillow torch transformers requests
    pip install ultralytics            # optional, for --detector

Examples:
    # safety layer only (no decision model)
    python pipeline.py --video walk.mp4 --out runs/walk1

    # with hosted Jev as the baseline
    export TYPESAFE_API_KEY=...
    python pipeline.py --video walk.mp4 --out runs/walk1_jev \
        --decision-url https://api.typesafe.ai --decision-model jev-1.13.0 \
        --detector yolo11n.pt --goal "reach the door at the end of the hallway"

    # with a local Jev-compatible server (e.g. Kev) on port 8000
    python pipeline.py --video walk.mp4 --out runs/walk1_local \
        --decision-url http://localhost:8000 --decision-model kev

    # score against hand labels (CSV: start_s,end_s,expected  where expected in forward/left/right/stop)
    python pipeline.py --video walk.mp4 --out runs/walk1 --labels walk1_labels.csv

NOTE: The request body follows the public Jev payload shape (state + questions).
The auth header and response field names are marked VERIFY — check them against
https://docs.typesafe.ai before trusting results.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time
from dataclasses import dataclass, asdict

import numpy as np

# cv2 / PIL / transformers are imported where they are used, so the shared logic
# (emulate_tof, safety_layer, arbitrate, ...) can be imported with numpy alone —
# shared/gen_test_vectors.py relies on this.

# ----------------------------------------------------------------------------- config

DIRECTIONS = ["forward", "left", "right", "stop"]

QUESTIONS = {
    "direction": {
        "type": "choice",
        "instructions": (
            "You guide a blind pedestrian. Choose the safest next movement that also "
            "makes progress toward the user's goal, using only the supplied state."
        ),
        "criteria": {
            "forward": "The path straight ahead is clear enough to keep walking.",
            "left": "The user should veer or turn left.",
            "right": "The user should veer or turn right.",
            "stop": "The user should stop because continuing is unsafe or unclear.",
        },
    },
    "goal_visible": {
        "type": "noul",
        "condition": "The thing the user is trying to reach is visible in the scene.",
        "threshold": 0.5,
    },
}


@dataclass
class Haptic:
    pattern: str          # NONE | STOP | SWEEP_LEFT | SWEEP_RIGHT | TICK_FORWARD
    intensity: float      # 0..1
    source: str           # safety | decision | none


# ----------------------------------------------------------------------------- depth

TEST_PATTERN = "test-pattern"


def load_depth(model_id: str, device: str):
    if model_id == TEST_PATTERN:
        return TEST_PATTERN
    from transformers import pipeline
    return pipeline("depth-estimation", model=model_id, device=device)


def test_pattern_depth(frame_bgr) -> np.ndarray:
    """PLUMBING TEST ONLY — not a depth estimate.

    Maps brightness to 0.3–6 m (darker = closer) so the rest of the pipeline can be
    exercised end to end where the Depth Anything weights can't be downloaded.
    Numbers produced with this backend say nothing about real distances.
    """
    gray = frame_bgr.mean(axis=2).astype(np.float32) / 255.0
    return 0.3 + gray * 5.7


def depth_map_m(depth_pipe, frame_bgr) -> np.ndarray:
    """Return a metric depth map in metres (requires a *Metric* Depth Anything V2 model)."""
    if depth_pipe == TEST_PATTERN:
        return test_pattern_depth(frame_bgr)
    import cv2
    from PIL import Image
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    out = depth_pipe(Image.fromarray(rgb))
    d = out["predicted_depth"]
    if hasattr(d, "detach"):
        d = d.squeeze().detach().cpu().numpy()
    return np.asarray(d, dtype=np.float32)


# ----------------------------------------------------------------------------- ToF emulation

def emulate_tof(depth_m: np.ndarray, zones: int = 8, fov_frac: float = 0.6,
                max_range: float = 4.0, noise: float = 0.02,
                rng: np.random.Generator | None = None) -> np.ndarray:
    """Shrink a depth map to a zones x zones grid like a multizone ToF sensor.

    fov_frac: the phone camera is wider than the VL53L5CX (~63 deg diagonal, check
    datasheet), so only the central part of the frame is used.
    Each zone reports a near percentile (closest dominant target), plus noise.
    Zones beyond max_range report inf (no target), as the real sensor would.
    """
    h, w = depth_m.shape
    ch, cw = int(h * fov_frac), int(w * fov_frac)
    y0, x0 = (h - ch) // 2, (w - cw) // 2
    crop = depth_m[y0:y0 + ch, x0:x0 + cw]
    zh, zw = ch // zones, cw // zones
    grid = np.empty((zones, zones), np.float32)
    for i in range(zones):
        for j in range(zones):
            cell = crop[i * zh:(i + 1) * zh, j * zw:(j + 1) * zw]
            grid[i, j] = np.percentile(cell, 10)
    if rng is not None and noise > 0:
        grid = grid + rng.normal(0.0, noise, grid.shape).astype(np.float32) * grid
    grid[grid > max_range] = np.inf
    return grid


# ----------------------------------------------------------------------------- safety layer

def safety_layer(grid: np.ndarray, stop_m: float, warn_m: float, ignore_bottom_rows: int):
    """Deterministic obstacle rules. Runs every frame; never waits on a model.

    ignore_bottom_rows: a downward-angled shoulder sensor sees the floor in its
    bottom rows; exclude them so the floor is not treated as an obstacle.
    """
    rows = grid[: grid.shape[0] - ignore_bottom_rows] if ignore_bottom_rows else grid
    finite = np.where(np.isfinite(rows), rows, 99.0)
    n = finite.shape[1]
    third = max(1, n // 3)
    left = float(finite[:, :third].min())
    ahead = float(finite[:, third:n - third].min())
    right = float(finite[:, n - third:].min())
    clearance = {"left": left, "ahead": ahead, "right": right}

    def strength(d):
        return float(np.clip((warn_m - d) / max(warn_m - stop_m, 1e-6), 0.2, 1.0))

    if ahead < stop_m:
        return Haptic("STOP", 1.0, "safety"), clearance
    if ahead < warn_m:
        side = "SWEEP_LEFT" if left > right else "SWEEP_RIGHT"
        return Haptic(side, strength(ahead), "safety"), clearance
    return Haptic("NONE", 0.0, "none"), clearance


# ----------------------------------------------------------------------------- detection

def load_detector(weights: str | None):
    if not weights:
        return None
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[warn] ultralytics not installed; continuing without detection")
        return None
    return YOLO(weights)


def detect(detector, frame_bgr, depth_m, max_objs: int = 8):
    if detector is None:
        return []
    res = detector(frame_bgr, verbose=False)[0]
    fh, fw = frame_bgr.shape[:2]
    dh, dw = depth_m.shape
    objs = []
    for b in res.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        dx, dy = int(cx / fw * (dw - 1)), int(cy / fh * (dh - 1))
        dist = float(depth_m[dy, dx])
        side = "left" if cx < fw / 3 else "right" if cx > 2 * fw / 3 else "ahead"
        objs.append({"label": res.names[int(b.cls)], "conf": round(float(b.conf), 2),
                     "side": side, "dist_m": round(dist, 2)})
    objs.sort(key=lambda o: o["dist_m"])
    return objs[:max_objs]


# ----------------------------------------------------------------------------- decision model

def build_state(goal: str, clearance: dict, objs: list) -> str:
    def fmt(d):
        return "clear beyond 4 m" if d >= 99 else f"{d:.1f} m"
    lines = [
        f"User goal: {goal}.",
        f"Free space measured by the shoulder sensor: left {fmt(clearance['left'])}, "
        f"ahead {fmt(clearance['ahead'])}, right {fmt(clearance['right'])}.",
    ]
    if objs:
        lines.append("Objects seen: " + "; ".join(
            f"{o['label']} {o['side']} at about {o['dist_m']:.1f} m" for o in objs) + ".")
    else:
        lines.append("No objects detected.")
    return "\n".join(lines)


class DecisionClient:
    """Talks to any Jev-compatible POST {base}/v1/systemone endpoint."""

    def __init__(self, base_url: str, model: str, api_key: str | None, timeout: float):
        import requests
        self.requests = requests
        self.url = base_url.rstrip("/") + "/v1/systemone"
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    def decide(self, state: str):
        body = {"model": self.model, "state": state, "questions": QUESTIONS}
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"  # VERIFY auth scheme
        t0 = time.perf_counter()
        r = self.requests.post(self.url, json=body, headers=headers, timeout=self.timeout)
        ms = (time.perf_counter() - t0) * 1000
        r.raise_for_status()
        return r.json(), ms


def extract_choice(resp: dict, key: str) -> tuple[str | None, dict]:
    """Defensively pull the winning option + probabilities. VERIFY field names."""
    node = None
    for container in ("answers", "results", "decisions", "outputs"):
        if isinstance(resp.get(container), dict) and key in resp[container]:
            node = resp[container][key]
            break
    if node is None and isinstance(resp.get(key), dict):
        node = resp[key]
    if not isinstance(node, dict):
        return None, {}
    probs = node.get("probabilities") or node.get("probs") or {}
    for k in ("choice", "selected", "selected_key", "answer", "value"):
        if isinstance(node.get(k), str):
            return node[k], probs
    if probs:
        return max(probs, key=probs.get), probs
    return None, probs


def arbitrate(safety: Haptic, decision: str | None, clearance: dict, stop_m: float) -> Haptic:
    """Safety always wins. A model decision is only used when it is not unsafe."""
    if safety.pattern == "STOP":
        return safety
    if decision is None:
        return safety
    if decision == "stop":
        return Haptic("STOP", 0.8, "decision")
    if decision in ("left", "right") and clearance[decision] < stop_m:
        return safety  # model points into a blocked side -> ignore it
    if decision == "left":
        return Haptic("SWEEP_LEFT", 0.6, "decision")
    if decision == "right":
        return Haptic("SWEEP_RIGHT", 0.6, "decision")
    if safety.pattern != "NONE":
        return safety
    return Haptic("TICK_FORWARD", 0.3, "decision")


# ----------------------------------------------------------------------------- labels / scoring

def load_labels(path: str | None):
    if not path:
        return []
    with open(path, newline="") as f:
        return [(float(r["start_s"]), float(r["end_s"]), r["expected"].strip().lower())
                for r in csv.DictReader(f)]


def label_at(labels, t: float):
    for s, e, exp in labels:
        if s <= t <= e:
            return exp
    return None


def pattern_to_direction(p: str) -> str:
    return {"STOP": "stop", "SWEEP_LEFT": "left", "SWEEP_RIGHT": "right"}.get(p, "forward")


# ----------------------------------------------------------------------------- overlay

def draw_overlay(frame, grid, haptic: Haptic, decision, dec_ms):
    import cv2
    out = frame.copy()
    h, w = out.shape[:2]
    cell = max(10, min(w, h) // 30)
    for i in range(grid.shape[0]):
        for j in range(grid.shape[1]):
            d = grid[i, j]
            v = 0 if not np.isfinite(d) else int(np.clip(255 * (1 - d / 4.0), 0, 255))
            cv2.rectangle(out, (10 + j * cell, 10 + i * cell),
                          (10 + (j + 1) * cell - 1, 10 + (i + 1) * cell - 1), (0, 0, v), -1)
    txt = f"{haptic.pattern} {haptic.intensity:.2f} [{haptic.source}]"
    cv2.putText(out, txt, (10, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    if decision:
        cv2.putText(out, f"model: {decision} ({dec_ms:.0f} ms)", (10, h - 12),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)
    return out


# ----------------------------------------------------------------------------- main

def pct(xs, p):
    return float(np.percentile(xs, p)) if xs else float("nan")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--goal", default="walk forward safely")
    ap.add_argument("--depth-model", default="depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",
                    help="use ...-Metric-Outdoor-Small-hf for outdoor clips; "
                         f"'{TEST_PATTERN}' = fake depth for plumbing tests only")
    ap.add_argument("--device", default="cpu", help="cpu, cuda, or mps")
    ap.add_argument("--fps", type=float, default=10.0, help="frames per second to process")
    ap.add_argument("--stop-m", type=float, default=0.9)
    ap.add_argument("--warn-m", type=float, default=2.0)
    ap.add_argument("--ignore-bottom-rows", type=int, default=2)
    ap.add_argument("--detector", default=None, help="e.g. yolo11n.pt (needs ultralytics)")
    ap.add_argument("--decision-url", default=None, help="base URL of a Jev-compatible server")
    ap.add_argument("--decision-model", default="jev-1.13.0")
    ap.add_argument("--decide-every-ms", type=float, default=500.0)
    ap.add_argument("--decision-ttl-ms", type=float, default=1500.0,
                    help="ignore a model answer older than this")
    ap.add_argument("--labels", default=None)
    ap.add_argument("--no-video-out", action="store_true")
    args = ap.parse_args()

    import cv2
    os.makedirs(args.out, exist_ok=True)
    rng = np.random.default_rng(0)
    depth_pipe = load_depth(args.depth_model, args.device)
    detector = load_detector(args.detector)
    client = None
    if args.decision_url:
        client = DecisionClient(args.decision_url, args.decision_model,
                                os.environ.get("TYPESAFE_API_KEY"), timeout=5.0)
    labels = load_labels(args.labels)

    cap = cv2.VideoCapture(args.video)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, int(round(src_fps / args.fps)))
    writer = None

    stage_ms = {"depth": [], "tof": [], "safety": [], "detect": [], "decision": [], "total_local": []}
    last_dec, last_dec_t, last_dec_ms = None, -1e9, 0.0
    agree = total_labeled = missed_stops = 0

    events_path = os.path.join(args.out, "events.jsonl")
    with open(events_path, "w") as ev:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step:
                idx += 1
                continue
            t_video = idx / src_fps
            idx += 1

            t0 = time.perf_counter()
            depth = depth_map_m(depth_pipe, frame)
            t1 = time.perf_counter()
            grid = emulate_tof(depth, rng=rng)
            t2 = time.perf_counter()
            safety, clearance = safety_layer(grid, args.stop_m, args.warn_m, args.ignore_bottom_rows)
            t3 = time.perf_counter()
            objs = detect(detector, frame, depth)
            t4 = time.perf_counter()

            stage_ms["depth"].append((t1 - t0) * 1000)
            stage_ms["tof"].append((t2 - t1) * 1000)
            stage_ms["safety"].append((t3 - t2) * 1000)
            stage_ms["detect"].append((t4 - t3) * 1000)
            stage_ms["total_local"].append((t3 - t0) * 1000)

            raw_resp, probs = None, {}
            now_ms = t_video * 1000
            if client and now_ms - last_dec_t >= args.decide_every_ms:
                state = build_state(args.goal, clearance, objs)
                try:
                    raw_resp, last_dec_ms = client.decide(state)
                    last_dec, probs = extract_choice(raw_resp, "direction")
                    last_dec_t = now_ms
                    stage_ms["decision"].append(last_dec_ms)
                except Exception as e:  # network / server errors must never block safety
                    print(f"[warn] decision call failed: {e}")
            fresh = last_dec if (now_ms - last_dec_t) <= args.decision_ttl_ms else None
            final = arbitrate(safety, fresh, clearance, args.stop_m)

            expected = label_at(labels, t_video)
            if expected:
                total_labeled += 1
                got = pattern_to_direction(final.pattern)
                agree += int(got == expected)
                missed_stops += int(expected == "stop" and got != "stop")

            ev.write(json.dumps({
                "schema_version": 1,
                "t": round(t_video, 3),
                "timings_ms": {
                    "depth": round((t1 - t0) * 1000, 1),
                    "tof": round((t2 - t1) * 1000, 2),
                    "safety": round((t3 - t2) * 1000, 2),
                    "detect": round((t4 - t3) * 1000, 1),
                    "decision": round(last_dec_ms, 1) if raw_resp is not None else None,
                },
                "grid_m": [[None if not np.isfinite(v) else round(float(v), 2) for v in row] for row in grid],
                "clearance_m": {k: (None if v >= 99 else round(v, 2)) for k, v in clearance.items()},
                "objects": objs,
                "safety": asdict(safety),
                "decision": {"choice": fresh, "probabilities": probs, "latency_ms": round(last_dec_ms, 1)},
                "haptic": asdict(final),
                "expected": expected,
            }) + "\n")

            if not args.no_video_out:
                vis = draw_overlay(frame, grid, final, fresh, last_dec_ms)
                if writer is None:
                    h, w = vis.shape[:2]
                    writer = cv2.VideoWriter(os.path.join(args.out, "annotated.mp4"),
                                             cv2.VideoWriter_fourcc(*"mp4v"), args.fps, (w, h))
                writer.write(vis)

    cap.release()
    if writer:
        writer.release()

    report = {k: {"p50": round(pct(v, 50), 1), "p95": round(pct(v, 95), 1), "n": len(v)}
              for k, v in stage_ms.items()}
    if total_labeled:
        report["accuracy_vs_labels"] = round(agree / total_labeled, 3)
        report["missed_stops"] = missed_stops
        report["labeled_frames"] = total_labeled
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    print(f"events -> {events_path}")


if __name__ == "__main__":
    main()
