// The in-browser stub must give the same answers as mock-server/MockDecisionServer.java.
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stubDecide } from "../decision";
import { buildState } from "../pipeline";

const hasJava = spawnSync("java", ["-version"]).status === 0;
const SERVER = fileURLToPath(new URL("../../../../mock-server/MockDecisionServer.java", import.meta.url));

const states = [
  [99, 99, 99], [2.5, 1.5, 3.0], [0.5, 0.6, 0.7], [1.2, 2.1, 0.4], [3.1, 0.95, 3.1], [0.8, 0.85, 1.9], [99, 1.0, 0.3], [0.2, 99, 0.2],
].map(([left, ahead, right]) => buildState("reach the exit", { left, ahead, right }, [{ label: "chair", conf: 1, side: "left", dist_m: 1.2 }]));

async function withServer(args: string[], fn: (url: string) => Promise<void>) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn("java", [SERVER, "--port", String(port), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("mock server did not start")), 30000);
      proc.stdout.on("data", (d) => String(d).includes("Mock decision server") && (clearTimeout(timer), res()));
      proc.on("exit", (c) => rej(new Error(`exited ${c}`)));
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    proc.kill();
  }
}

async function ask(url: string, state: string) {
  const r = await fetch(url + "/v1/systemone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "mock", state, questions: {} }) });
  return (await r.json()).answers.direction;
}

describe.skipIf(!hasJava)("Java mock server ↔ TypeScript stub", () => {
  it("same choice and probabilities (correct answers)", async () => {
    await withServer([], async (url) => {
      for (const s of states) {
        const java = await ask(url, s);
        const ts = stubDecide(s, false);
        expect(java.choice).toBe(ts.choice);
        for (const [k, v] of Object.entries(ts.probabilities)) expect(java.probabilities[k]).toBeCloseTo(v, 4);
      }
    });
  });
  it("same deliberately wrong answers with --error-rate 1.0", async () => {
    await withServer(["--error-rate", "1.0"], async (url) => {
      for (const s of states) {
        const java = await ask(url, s);
        const ts = stubDecide(s, true);
        expect(java.choice).toBe(ts.choice);
        for (const [k, v] of Object.entries(ts.probabilities)) expect(java.probabilities[k]).toBeCloseTo(v, 4);
      }
    });
  });
});
