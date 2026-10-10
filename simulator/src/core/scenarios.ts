import type { Scenario } from "./world";
import S1 from "../../scenarios/S1_hallway.json";
import S2 from "../../scenarios/S2_office.json";
import S3 from "../../scenarios/S3_glass_door.json";
import S4 from "../../scenarios/S4_overhang.json";
import S5 from "../../scenarios/S5_kitchen.json";
import S6 from "../../scenarios/S6_crossing.json";

export const SCENARIOS = [S1, S2, S3, S4, S5, S6] as unknown as Scenario[];

export function scenarioByName(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name || x.name.startsWith(name + "_"));
  if (!s) throw new Error(`unknown scenario ${name}`);
  return structuredClone(s);
}
