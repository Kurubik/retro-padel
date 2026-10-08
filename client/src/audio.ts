/**
 * All sound is synthesised locally with the Web Audio API — no asset downloads,
 * no autoplay. The context is created only after a real user gesture.
 */
type Ctor = typeof AudioContext;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = false;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (value) this.unlock();
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(value ? 0.5 : 0, this.ctx.currentTime, 0.02);
    }
  }

  /** Must be called from within a user gesture handler. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx: Ctor | undefined =
      typeof window !== 'undefined'
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext)
        : undefined;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.5 : 0;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  private tone(
    freq: number,
    duration: number,
    type: OscillatorType,
    peak: number,
    sweepTo?: number
  ): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + duration);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  paddle(): void {
    this.tone(320, 0.09, 'square', 0.22, 220);
  }
  wall(): void {
    this.tone(180, 0.07, 'triangle', 0.16, 140);
  }
  point(won: boolean): void {
    this.tone(won ? 620 : 240, 0.16, 'square', 0.2, won ? 880 : 150);
  }
  serve(): void {
    this.tone(500, 0.11, 'sawtooth', 0.16, 760);
  }
  countdown(last: boolean): void {
    this.tone(last ? 880 : 480, last ? 0.2 : 0.09, 'square', 0.17);
  }
  win(): void {
    this.tone(523, 0.14, 'square', 0.2);
    window.setTimeout(() => this.tone(659, 0.14, 'square', 0.2), 130);
    window.setTimeout(() => this.tone(784, 0.26, 'square', 0.22), 260);
  }
  lose(): void {
    this.tone(300, 0.2, 'sawtooth', 0.18, 160);
    window.setTimeout(() => this.tone(180, 0.34, 'sawtooth', 0.16, 90), 160);
  }
  ui(): void {
    this.tone(720, 0.05, 'square', 0.12);
  }
  back(): void {
    this.tone(300, 0.07, 'square', 0.12, 200);
  }
  connect(): void {
    this.tone(440, 0.1, 'sine', 0.14, 660);
  }
  error(): void {
    this.tone(160, 0.22, 'sawtooth', 0.2, 110);
  }
}
