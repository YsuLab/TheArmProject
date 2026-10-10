// Optional outputs so people can "hear" / feel the glove (PLAN.md 12.5):
// five pitches panned by PHYSICAL position (user's left → right), and the Web Vibration API.

const PITCHES = [262, 330, 392, 494, 587]; // physical left → right (C4 E4 G4 B4 D5)

export class Sonifier {
  private ctx: AudioContext | null = null;
  private gains: GainNode[] = [];

  get enabled() {
    return this.ctx !== null;
  }

  enable() {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    for (let k = 0; k < 5; k++) {
      const osc = this.ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = PITCHES[k];
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = (k - 2) / 2;
      osc.connect(gain).connect(pan).connect(this.ctx.destination);
      osc.start();
      this.gains.push(gain);
    }
  }

  disable() {
    this.ctx?.close();
    this.ctx = null;
    this.gains = [];
  }

  /** duties by motor index; physicalOrder[k] = motor at physical position k. */
  update(duties: number[], physicalOrder: number[]) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (let k = 0; k < 5; k++) this.gains[k].gain.setTargetAtTime((duties[physicalOrder[k]] / 255) * 0.12, now, 0.01);
  }
}

export class Vibrator {
  enabled = false;
  private on = false;
  get supported() {
    return typeof navigator !== "undefined" && "vibrate" in navigator;
  }
  /** Single-motor approximation: vibrate while any motor is on. */
  update(duties: number[]) {
    if (!this.enabled || !this.supported) return;
    const want = Math.max(...duties) > 0;
    if (want !== this.on) {
      navigator.vibrate(want ? 2000 : 0);
      this.on = want;
    }
  }
  stop() {
    if (this.on && this.supported) navigator.vibrate(0);
    this.on = false;
  }
}
