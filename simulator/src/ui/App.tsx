import { useState } from "react";
import { ModeA } from "./ModeA";
import { ModeB, type RecordedRun } from "./ModeB";

export default function App() {
  const [mode, setMode] = useState<"A" | "B">("B");
  const [incoming, setIncoming] = useState<RecordedRun | null>(null);
  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>Haptic Guide Simulator</h1>
          <p className="muted small">Shoulder sensors → safety layer → decision model → arbitration → glove. Software prototype; not a medical device.</p>
        </div>
        <nav className="seg tabs" aria-label="Mode">
          <button aria-pressed={mode === "B"} onClick={() => setMode("B")}>
            Mode B · Interactive
          </button>
          <button aria-pressed={mode === "A"} onClick={() => setMode("A")}>
            Mode A · Replay
          </button>
        </nav>
      </header>
      <main>
        {mode === "B" ? (
          <ModeB
            onOpenReplay={(r) => {
              setIncoming(r);
              setMode("A");
            }}
          />
        ) : (
          <ModeA incoming={incoming} />
        )}
      </main>
    </div>
  );
}
