#!/usr/bin/env python3
"""Generate shared/test_vectors.json from pipeline/pipeline.py.

The simulator's TypeScript port of the shared logic (simulator/src/core/pipeline.ts)
must reproduce every vector exactly (acceptance test A13). Re-run this whenever
emulate_tof, safety_layer, arbitrate, build_state or extract_choice change:

    python3 shared/gen_test_vectors.py

Needs numpy only. Values are deterministic (fixed seed).
"""
from __future__ import annotations

import itertools
import json
import os
import sys
from dataclasses import asdict

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "pipeline"))
import pipeline as P  # noqa: E402

rng = np.random.default_rng(20261010)


def grid_to_json(g: np.ndarray):
    return [[None if not np.isfinite(v) else float(v) for v in row] for row in g]


def grid_from_json(rows) -> np.ndarray:
    return np.array([[np.inf if v is None else v for v in row] for row in rows], np.float32)


def clearance_to_json(c: dict):
    return {k: float(v) for k, v in c.items()}


# ----------------------------------------------------------------------------- emulate_tof

def make_depth(h: int, w: int, kind: int) -> np.ndarray:
    """Plausible-looking depth maps: floor gradient, walls, boxes, far background."""
    yy, xx = np.mgrid[0:h, 0:w]
    if kind == 0:  # corridor: floor near at the bottom, far in the middle
        d = 0.5 + 6.0 * (1 - yy / max(h - 1, 1)) ** 2 + 0.5 * np.abs(xx - w / 2) / w
    elif kind == 1:  # wall close on the left
        d = np.where(xx < w * 0.35, 0.6 + xx / w, 3.5 + rng.random((h, w)))
    elif kind == 2:  # box in the middle
        d = np.full((h, w), 5.0)
        d[h // 3: 2 * h // 3, w // 3: 2 * w // 3] = 0.8
    else:  # random clutter
        d = rng.uniform(0.2, 7.0, (h, w))
    return np.round(d.astype(np.float64), 3)


tof_vectors = []
for (h, w), kind, zones, fov_frac, max_range in itertools.product(
        [(30, 40), (37, 53), (24, 24)], range(4), [8, 4], [0.6, 1.0], [4.0, 1.5]):
    if (zones == 4) and kind in (1, 2):
        continue
    depth = make_depth(h, w, kind)
    grid = P.emulate_tof(depth.copy(), zones=zones, fov_frac=fov_frac, max_range=max_range, noise=0.0)
    tof_vectors.append({
        "input": {"depth_m": depth.tolist(), "zones": zones, "fov_frac": fov_frac, "max_range": max_range},
        "expected": grid_to_json(grid),
    })

# ----------------------------------------------------------------------------- safety_layer

def random_grid(kind: int) -> np.ndarray:
    g = rng.uniform(0.3, 4.0, (8, 8))
    if kind == 1:  # mostly clear
        g = np.where(rng.random((8, 8)) < 0.7, np.inf, g)
    elif kind == 2:  # all clear
        g = np.full((8, 8), np.inf)
    elif kind == 3:  # obstacle in the centre columns
        g[:, 2:6] = rng.uniform(0.3, 2.5, (8, 4))
    elif kind == 4:  # floor in the bottom rows only
        g[:] = np.inf
        g[6:, :] = rng.uniform(1.5, 3.0, (2, 8))
    return np.round(g, 2).astype(np.float32)


safety_grids = [random_grid(k % 5) for k in range(40)]
# hand-made edge cases: exact thresholds and left/right ties
tie = np.full((8, 8), np.inf, np.float32)
tie[:, 3] = 1.5
tie[:, 0] = 2.5
tie[:, 7] = 2.5
safety_grids.append(tie)
edge = np.full((8, 8), np.inf, np.float32)
edge[2, 4] = 0.9
safety_grids.append(edge)
edge2 = np.full((8, 8), np.inf, np.float32)
edge2[0, 2] = 2.0
safety_grids.append(edge2)

safety_vectors = []
for i, g in enumerate(safety_grids):
    for stop_m, warn_m, ignore in [(0.9, 2.0, 2), (0.9, 2.0, 0), (0.6, 1.5, 1), (1.2, 3.0, 3)]:
        gj = grid_to_json(g)
        hap, clr = P.safety_layer(grid_from_json(gj), stop_m, warn_m, ignore)
        safety_vectors.append({
            "input": {"grid_m": gj, "stop_m": stop_m, "warn_m": warn_m, "ignore_bottom_rows": ignore},
            "expected": {"haptic": asdict(hap), "clearance": clearance_to_json(clr)},
        })

# ----------------------------------------------------------------------------- arbitrate

safeties = [P.Haptic("NONE", 0.0, "none"), P.Haptic("SWEEP_LEFT", 0.45, "safety"),
            P.Haptic("SWEEP_RIGHT", 1.0, "safety"), P.Haptic("STOP", 1.0, "safety")]
decisions = [None, "forward", "left", "right", "stop", "unknown"]
clearances = [{"left": 99.0, "ahead": 99.0, "right": 99.0},
              {"left": 0.5, "ahead": 1.5, "right": 3.0},
              {"left": 2.5, "ahead": 0.7, "right": 0.4},
              {"left": 0.9, "ahead": 1.2, "right": 0.89}]
arbitrate_vectors = []
for s, d, c, stop_m in itertools.product(safeties, decisions, clearances, [0.9, 0.5]):
    out = P.arbitrate(s, d, c, stop_m)
    arbitrate_vectors.append({
        "input": {"safety": asdict(s), "decision": d, "clearance": c, "stop_m": stop_m},
        "expected": asdict(out),
    })

# ----------------------------------------------------------------------------- build_state / extract_choice

state_vectors = []
for goal, clr, objs in [
    ("walk forward safely", {"left": 99.0, "ahead": 99.0, "right": 99.0}, []),
    ("reach the door at the end of the hallway", {"left": 2.13, "ahead": 0.85, "right": 99.0},
     [{"label": "door", "conf": 0.81, "side": "ahead", "dist_m": 3.1},
      {"label": "chair", "conf": 0.6, "side": "left", "dist_m": 1.04}]),
    ("exit", {"left": 0.449, "ahead": 1.95, "right": 3.999}, []),
]:
    state_vectors.append({"input": {"goal": goal, "clearance": clr, "objects": objs},
                          "expected": P.build_state(goal, clr, objs)})

responses = [
    {"answers": {"direction": {"choice": "right", "probabilities": {"forward": 0.1, "left": 0.05, "right": 0.8, "stop": 0.05}}}},
    {"results": {"direction": {"selected": "left", "probs": {"left": 0.7, "right": 0.3}}}},
    {"decisions": {"direction": {"probabilities": {"forward": 0.2, "stop": 0.6, "left": 0.1, "right": 0.1}}}},
    {"direction": {"answer": "forward"}},
    {"outputs": {"other": {}}},
    {"answers": {"direction": "left"}},
    {},
]
extract_vectors = []
for r in responses:
    choice, probs = P.extract_choice(r, "direction")
    extract_vectors.append({"input": {"response": r, "key": "direction"},
                            "expected": {"choice": choice, "probabilities": probs}})

pattern_vectors = [{"input": p, "expected": P.pattern_to_direction(p)}
                   for p in ["NONE", "STOP", "SWEEP_LEFT", "SWEEP_RIGHT", "TICK_FORWARD", "HOT", "COLD"]]

out = {
    "schema_version": 1,
    "generator": "shared/gen_test_vectors.py (from pipeline/pipeline.py)",
    "notes": "null in grids = no target within range (inf). Clearance 99.0 = clear beyond max range.",
    "emulate_tof": tof_vectors,
    "safety_layer": safety_vectors,
    "arbitrate": arbitrate_vectors,
    "build_state": state_vectors,
    "extract_choice": extract_vectors,
    "pattern_to_direction": pattern_vectors,
}
path = os.path.join(HERE, "test_vectors.json")
with open(path, "w") as f:
    json.dump(out, f, allow_nan=False, separators=(",", ":"))
    f.write("\n")
print(f"wrote {path}: " + ", ".join(f"{k}={len(v)}" for k, v in out.items() if isinstance(v, list)))
