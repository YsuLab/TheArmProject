# Haptic Guide — test report

> Template for PLAN.md §13 (go / no-go). Fill every `[RESULT: …]` from an actual run. Do not
> estimate. Leave a placeholder in place until the test has been done.

**Date:** [YYYY-MM-DD] · **Tester(s):** [names] · **Build / commit:** [git hash] · **Hardware:** [laptop / phone model]

## 1. Software runs

| Run | Tool and settings | Output folder |
|---|---|---|
| [walk1] | `pipeline.py --depth-model … --decision-url …` | `runs/…` |
| [S1–S6] | Simulator Mode B, seed [n], model [stub / endpoint], error rate [x] | recorder export |

## 2. Go / no-go metrics

| Area | Metric | Target | Result | Pass? | Evidence |
|---|---|---|---|---|---|
| Safety | Missed STOP events on labelled obstacle clips | 0 | [RESULT: pending Phase 0 recordings] | | `report.json` → `missed_stops` |
| Safety | Safety-layer compute per frame (laptop, excl. camera), p95 | < 50 ms | [RESULT: pending] | | `report.json` → `safety.p95` |
| Decisions | Direction agreement with human labels | ≥ 90 % | [RESULT: pending] | | `accuracy_vs_labels` |
| Decisions | Local decision latency on phone-class hardware, p95 | ≤ 500 ms | [RESULT: pending] | | `decision.p95` |
| Decisions | Local model vs hosted Jev accuracy gap | ≤ 5 pp | [RESULT: pending] | | two runs, same clips |
| Haptics | Blindfolded pattern recognition (≥ 5 people, ≥ 40 trials each) | ≥ 95 % | [RESULT: pending Phase 2 test] | | §4 below |
| Heat | Hot (> 50 °C) matte objects detected at ≥ 10 cm | ≥ 95 % of trials | [RESULT: pending Phase 2 test] | | §5 below |
| Heat | Shiny steel results | Documented + mitigation | [RESULT: pending Phase 2 test] | | §5 below |
| Simulation | Collisions per 100 m (Mode B / Habitat) | Team to set | [RESULT: pending] | | Mode B `report.json` |

## 3. Simulator acceptance tests (PLAN.md §0.8)

`cd simulator && npm test` → [RESULT: paste summary line]. Known failure carried over: A6 "zero
model-caused collisions" (README → Findings 2). Record whether it still fails: [RESULT: pending].

## 4. Vibration discrimination (human test)

| Participant | Trials | Correct | Confusions (pattern → answered) |
|---|---|---|---|
| P1 | [40] | [RESULT] | |
| … | | | |
| **Total** | | **[RESULT] %** | |

Glove build: [motor type, spacing]. Hand / palm orientation used: [ ].

## 5. Heat on real cookware (human-free bench test)

| Object | Material | True °C (probe) | IR reported °C | Distance cm | Pattern | Trials detected |
|---|---|---|---|---|---|---|
| Mug | ceramic | [RESULT] | [RESULT] | 10 | | [x / n] |
| Kettle | polished steel | [RESULT] | [RESULT] | 10 | | [x / n] |
| Bottle | glass, cold | [RESULT] | [RESULT] | 10 | | [x / n] |

Mitigation tried for shiny steel: [ ]. Cold threshold used: [ ] °C (the simulator suggests 5 °C
misses 4 °C objects in a 25 °C room — README Findings 4).

## 6. Decision

Go / no-go: [ ] · Open issues: [ ] · Next step: [ ]
