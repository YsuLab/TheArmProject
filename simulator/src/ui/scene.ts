// Canvas 2D drawing of the Mode B world (top-down).

import { IR_FOV_DEG } from "../core/heat";
import type { Sim } from "../core/sim";
import { AVATAR_RADIUS, zoneAngles, type Obstacle } from "../core/world";

export function sceneScale(sizeM: [number, number], maxW = 760, maxH = 420) {
  const ppm = Math.min(maxW / sizeM[0], maxH / sizeM[1]);
  return { ppm, w: Math.round(sizeM[0] * ppm), h: Math.round(sizeM[1] * ppm) };
}

function css(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fillFor(o: Obstacle) {
  if (o.material === "glass") return "rgba(120, 200, 255, 0.35)";
  if (o.material === "wall") return css("--wall", "#555c66");
  if (o.material === "person") return "#c06cf0";
  if (o.temp_c !== undefined) return o.temp_c >= 50 ? "#e5533d" : o.temp_c <= 5 ? "#3d8be5" : "#9aa3ad";
  if (o.z_min >= 1.2) return "rgba(176, 132, 82, 0.35)"; // overhead
  return "#b08452";
}

export function drawScene(ctx: CanvasRenderingContext2D, sim: Sim, ppm: number, trail: { x: number; y: number }[]) {
  const sc = sim.scenario;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const X = (x: number) => x * ppm;
  ctx.fillStyle = css("--floor", "#e9e4da");
  ctx.fillRect(0, 0, W, H);

  // grid
  ctx.strokeStyle = css("--floor-grid", "rgba(0,0,0,0.06)");
  ctx.lineWidth = 1;
  for (let x = 1; x < sc.size_m[0]; x++) {
    ctx.beginPath();
    ctx.moveTo(X(x), 0);
    ctx.lineTo(X(x), H);
    ctx.stroke();
  }
  for (let y = 1; y < sc.size_m[1]; y++) {
    ctx.beginPath();
    ctx.moveTo(0, X(y));
    ctx.lineTo(W, X(y));
    ctx.stroke();
  }

  // goal
  ctx.fillStyle = "#1fa463";
  ctx.font = "11px system-ui, sans-serif";
  ctx.beginPath();
  ctx.arc(X(sc.goal.x), X(sc.goal.y), Math.max(5, Math.min(12, 0.18 * ppm)), 0, Math.PI * 2);
  ctx.fill();
  ctx.font = "11px system-ui, sans-serif";
  const label = (text: string, x: number, y: number) => {
    const w = ctx.measureText(text).width;
    ctx.fillText(text, Math.max(3, Math.min(W - w - 3, x - w / 2)), Math.max(11, Math.min(H - 3, y)));
  };
  label(`goal: ${sc.goal.label}`, X(sc.goal.x), X(sc.goal.y) - 0.25 * ppm - 4);

  // obstacles
  const obstacles = sim.obstacles();
  for (const o of obstacles) {
    if (o.material === "wall" && o.label === "wall") continue;
    ctx.fillStyle = fillFor(o);
    ctx.strokeStyle = o.material === "glass" ? "#3aa0e0" : "rgba(0,0,0,0.45)";
    ctx.setLineDash(o.z_min >= 1.2 ? [4, 3] : []);
    ctx.lineWidth = o.material === "glass" ? 2 : 1;
    ctx.beginPath();
    if (o.type === "circle") ctx.arc(X(o.x), X(o.y), o.r * ppm, 0, Math.PI * 2);
    else ctx.rect(X(o.x), X(o.y), Math.max(2, o.w * ppm), Math.max(2, o.h * ppm));
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    if (o.label) {
      const cx = o.type === "circle" ? X(o.x) : X(o.x + o.w / 2);
      const cy = o.type === "circle" ? X(o.y) + o.r * ppm + 11 : X(o.y + o.h) + 11;
      const zs = o.z_min > 0 ? `${o.z_min}–${o.z_max} m` : `≤${o.z_max} m`;
      ctx.fillStyle = css("--scene-text", "#333");
      label(o.temp_c !== undefined ? `${o.label} ${o.temp_c}°C` : `${o.label} (${zs})`, cx, cy);
    }
  }

  // trail
  ctx.strokeStyle = "rgba(60, 90, 160, 0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  trail.forEach((p, i) => (i ? ctx.lineTo(X(p.x), X(p.y)) : ctx.moveTo(X(p.x), X(p.y))));
  ctx.stroke();

  const p = sim.pose;
  const f = sim.frame;
  const range = sim.maxRange;
  // ToF field of view
  const half = ((sim.cfg.sensor.fovDeg / 2) * Math.PI) / 180;
  ctx.fillStyle = sim.cfg.sunlight ? "rgba(255, 200, 0, 0.16)" : "rgba(255, 140, 0, 0.10)";
  ctx.beginPath();
  ctx.moveTo(X(p.x), X(p.y));
  ctx.arc(X(p.x), X(p.y), range * ppm, p.heading - half, p.heading + half);
  ctx.closePath();
  ctx.fill();
  // ultrasonic cone
  if (f) {
    const uh = (15 * Math.PI) / 180;
    const ur = f.ultrasonic ?? 4.0;
    ctx.strokeStyle = f.ultrasonic !== null && f.ultrasonic < sim.cfg.stopM ? "rgba(220,40,40,0.8)" : "rgba(60,60,200,0.35)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(p.x), X(p.y));
    ctx.arc(X(p.x), X(p.y), ur * ppm, p.heading - uh, p.heading + uh);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    // per-column nearest ToF hit (rows used by the safety layer)
    const { az } = zoneAngles(sim.cfg.sensor);
    const used = sim.cfg.sensor.zones - sim.cfg.ignoreBottomRows;
    for (let j = 0; j < az.length; j++) {
      let d = Infinity;
      for (let i = 0; i < used; i++) d = Math.min(d, f.grid[i][j]);
      if (!Number.isFinite(d)) continue;
      const a = f.pose.heading + az[j];
      ctx.fillStyle = d < sim.cfg.stopM ? "#d92b2b" : d < sim.cfg.warnM ? "#f08a00" : "#3a7d44";
      ctx.beginPath();
      ctx.arc(X(f.pose.x + Math.cos(a) * d), X(f.pose.y + Math.sin(a) * d), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // hand + IR cone (S5)
  if (sim.hand && (sc.hand_mode || sim.manual.enabled)) {
    const h = sim.hand;
    const aim = Math.atan2(h.y - p.y, h.x - p.x);
    const ir = ((IR_FOV_DEG / 2) * Math.PI) / 180;
    const reach = Math.min(0.6, sim.heat.palm_dist_cm / 100);
    ctx.fillStyle = sim.heat.pattern === "HOT" ? "rgba(229,83,61,0.35)" : sim.heat.pattern === "COLD" ? "rgba(61,139,229,0.35)" : "rgba(42,163,255,0.2)";
    ctx.beginPath();
    ctx.moveTo(X(h.x), X(h.y));
    ctx.arc(X(h.x), X(h.y), reach * ppm, aim - ir, aim + ir);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.moveTo(X(p.x), X(p.y));
    ctx.lineTo(X(h.x), X(h.y));
    ctx.stroke();
    ctx.fillStyle = "#f1d3b8";
    ctx.strokeStyle = "#a07858";
    ctx.beginPath();
    ctx.arc(X(h.x), X(h.y), Math.max(4, 0.05 * ppm), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // avatar
  const flash = sim.t - sim.lastCollisionT < 0.4 && sim.lastCollisionT >= 0;
  ctx.fillStyle = flash ? "#e02424" : "#2b4c9a";
  ctx.beginPath();
  ctx.arc(X(p.x), X(p.y), AVATAR_RADIUS * ppm, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(p.x), X(p.y));
  ctx.lineTo(X(p.x + Math.cos(p.heading) * AVATAR_RADIUS * 1.4), X(p.y + Math.sin(p.heading) * AVATAR_RADIUS * 1.4));
  ctx.stroke();
  if (flash) {
    ctx.fillStyle = "rgba(224,36,36,0.12)";
    ctx.fillRect(0, 0, W, H);
  }
  // HUD
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillText(`t ${sim.t.toFixed(1)} s · ${sc.name}${sim.cfg.sunlight ? " · SUN" : ""}${sim.recording ? " · ● REC" : ""}`, 6, 14);
}
