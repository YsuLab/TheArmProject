# Glove firmware (Wokwi)

`glove_sim.ino` is Appendix B of `PLAN.md` unchanged. `diagram.json` wires it as the sketch
header describes (LEDs on GPIO 4/5/18/19/21, pots on 34/35, button on 23).

1. Open <https://wokwi.com>, start a new **ESP32** Arduino project.
2. Replace `sketch.ino` with `glove_sim.ino` and `diagram.json` with this folder's `diagram.json`.
3. Run. Type `l`, `r`, `s`, `f`, `x` in the Serial Monitor; turn the pots for temperature and
   palm distance; press the button to flip palm orientation.

The simulator's glove (`simulator/src/core/glove.ts`) is a line-for-line port of this sketch and
must stay in sync with the timing table in `PLAN.md` §0.7.

> Not yet verified: the sketch and `diagram.json` have not been compiled or run in Wokwi from
> this repository's tooling (no Arduino toolchain in the build environment). Check pin names
> in `diagram.json` against the Wokwi part reference if a wire does not connect.
