// Writes ../assets/hand-haptic-map.svg from the shared hand geometry.  npm run export:hand
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handSvgString } from "../src/hand/geometry";

const out = fileURLToPath(new URL("../../assets/hand-haptic-map.svg", import.meta.url));
writeFileSync(out, handSvgString());
console.log(`wrote ${out}`);
