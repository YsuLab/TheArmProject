import { FINGERS as MOTOR_NAMES, PRIORITY, type GloveOutput } from "../core/glove";
import { along, FINGERS, GLOVE_FRACTION, MOTOR_FRACTION, mirrorX, PALM_PATH, PALM_SENSOR, POD, VIEW_H, VIEW_W } from "../hand/geometry";

const PATTERN_TEXT: Record<string, string> = {
  NONE: "Idle",
  POWER_ON: "Power on",
  HOT: "HOT — fast pulse, all fingers",
  COLD: "COLD — slow rolling wave",
  STOP: "STOP — two long pulses",
  SWEEP_LEFT: "Go LEFT — sweep to the user's left",
  SWEEP_RIGHT: "Go RIGHT — sweep to the user's right",
  TICK_FORWARD: "Forward — middle-finger tick",
};

export function HandPanel({ glove, rightHand, palmDown, tMs }: { glove: GloveOutput; rightHand: boolean; palmDown: boolean; tMs: number }) {
  // Seen from above by the user: right hand palm down has the thumb on the left.
  const mirrored = !(rightHand === palmDown);
  const prio = PRIORITY[glove.pattern];
  const describe = glove.duties.map((d, i) => `${MOTOR_NAMES[i]} ${d > 0 ? Math.round((d / 255) * 100) + "%" : "off"}`).join(", ");
  return (
    <section className="panel hand-panel" aria-labelledby="hand-h">
      <h2 id="hand-h">Glove</h2>
      <div className="pattern-badge" data-pattern={glove.pattern} role="status" aria-live="polite">
        <strong>{PATTERN_TEXT[glove.pattern] ?? glove.pattern}</strong>
        {prio ? <span className="prio">priority {prio}</span> : null}
      </div>
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="hand-svg" role="img" aria-label={`Hand: ${describe}`}>
        <g transform={mirrored ? `translate(${VIEW_W} 0) scale(-1 1)` : undefined}>
          <path d={PALM_PATH} className={palmDown ? "h-glove" : "h-palmside"} />
          {FINGERS.map((f) => (
            <g key={f.name} transform={`translate(${f.bx} ${f.by}) rotate(${f.angle})`}>
              <rect x={-f.w / 2} y={-f.len} width={f.w} height={f.len} rx={f.w / 2} className="h-skin" />
              <rect x={-f.w / 2} y={-f.len * GLOVE_FRACTION} width={f.w} height={f.len * GLOVE_FRACTION} rx={8} className={palmDown ? "h-glove" : "h-palmside"} />
            </g>
          ))}
          <circle cx={PALM_SENSOR.x} cy={PALM_SENSOR.y} r={PALM_SENSOR.r} className={palmDown ? "h-sensor hidden-side" : "h-sensor"} />
          <rect x={POD.x} y={POD.y} width={POD.w} height={POD.h} rx={POD.rx} className="h-pod" />
        </g>
        <text x={mirrorX(POD.x + POD.w / 2, mirrored)} y={POD.y + 24} className="h-pod-text">WRIST POD</text>
        <text x={mirrorX(POD.x + POD.w / 2, mirrored)} y={POD.y + 42} className="h-pod-text small">
          {rightHand ? "R" : "L"} hand · palm {palmDown ? "down" : "up"}
        </text>
        {FINGERS.map((f, i) => {
          const m = along(f, MOTOR_FRACTION);
          const tip = along(f, 1);
          const x = mirrorX(m.x, mirrored);
          const duty = glove.duties[i];
          const a = duty / 255;
          const shake = duty > 0 ? Math.sin(tMs * 0.9 + i) * 1.6 * a : 0;
          return (
            <g key={f.motor}>
              {duty > 0 && <circle cx={x} cy={m.y} r={14 + 16 * a} className="h-ring" style={{ opacity: 0.25 + 0.6 * a }} />}
              <circle cx={x + shake} cy={m.y} r={13} className="h-motor" style={{ fill: duty > 0 ? `rgba(255, ${170 - 120 * a}, 32, ${0.35 + 0.65 * a})` : undefined }} />
              <text x={x + shake} y={m.y + 4} className="h-motor-label">{f.motor}</text>
              <text x={mirrorX(tip.x, mirrored)} y={tip.y - 10} className="h-finger">{f.name}</text>
            </g>
          );
        })}
        {!palmDown && (
          <text x={mirrorX(PALM_SENSOR.x, mirrored)} y={PALM_SENSOR.y + 30} className="h-finger small">IR + ToF</text>
        )}
      </svg>
      <div className="physical-strip" aria-hidden="true">
        <span className="strip-label">user's left</span>
        {glove.physicalOrder.map((motor, k) => (
          <div key={k} className="strip-cell" style={{ background: `rgba(255,140,32,${glove.duties[motor] / 255})` }}>
            M{motor + 1}
          </div>
        ))}
        <span className="strip-label">right</span>
      </div>
    </section>
  );
}
