import { BALL_R, FIELD_H, FIELD_W, PADDLE_H, PADDLE_W, paddleCenterX } from '@shared/core/constants.js';
import type { BallState, PaddleState, Side } from '@shared/core/types.js';
import type { ThemeSetting } from './settings.js';

export interface RenderView {
  ball: BallState;
  paddles: [PaddleState, PaddleState];
  score: [number, number];
  server: Side;
  /** Dimmed, non-interactive background field (menus / attract). */
  ambient: boolean;
  /** Hide paddles/ball (pure attract drift only draws the ball). */
  showPaddles: boolean;
  /** 1 = serving side highlight strength. */
  servePulse: number;
  suddenDeath: boolean;
  reducedMotion: boolean;
  /** Draw the score/ownership readout. Hidden when a menu owns the screen. */
  showScore: boolean;
  /** Which sides are live and controllable, for touch-zone hints. */
  localSplit: boolean;
  /** Score readout labels in field order (side 0 first), so who is who is correct. */
  scoreLabels: [string, string];
}

interface Ping {
  x: number;
  y: number;
  age: number;
  life: number;
  radius: number;
  color: string;
}

const PALETTES = {
  signal: { ink: '22, 36, 27', accent: '157, 98, 255', flare: '184, 239, 74' },
  blackwall: { ink: '255, 229, 224', accent: '255, 62, 70', flare: '17, 9, 12' }
} as const;

export class FieldRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly trail: { x: number; y: number }[] = [];
  private readonly pings: Ping[] = [];
  private palette: { ink: string; accent: string; flare: string } = PALETTES.signal;
  private scale = 1;
  private cssW = 0;
  private cssH = 0;
  dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;
  }

  setTheme(theme: ThemeSetting): void {
    this.palette = PALETTES[theme];
    this.clearPings();
    this.trail.length = 0;
  }

  resize(cssWidth: number, cssHeight: number, maxDpr = 2): void {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.cssW = cssWidth;
    this.cssH = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  }

  ping(x: number, y: number, kind: 'paddle' | 'wall' | 'score' | 'serve'): void {
    const color = kind === 'score' ? this.palette.flare : kind === 'serve' ? this.palette.accent : this.palette.ink;
    this.pings.push({
      x,
      y,
      age: 0,
      life: kind === 'score' ? 0.55 : 0.3,
      radius: kind === 'score' ? 90 : 46,
      color
    });
    if (this.pings.length > 14) this.pings.shift();
  }

  clearPings(): void {
    this.pings.length = 0;
  }

  private begin(): void {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(w / FIELD_W, 0, 0, h / FIELD_H, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  private drawField(view: RenderView, t: number): void {
    const { ctx } = this;
    const alpha = view.ambient ? 0.22 : 0.5;

    // Faint pixel-grid with a slight parallax against the ball.
    const px = view.ball.x * 0.012;
    const py = view.ball.y * 0.012;
    ctx.save();
    ctx.globalAlpha *= view.ambient ? 0.5 : 1;
    ctx.fillStyle = `rgba(${this.palette.ink}, 0.55)`;
    const step = 56;
    for (let gx = (px % step) - step; gx < FIELD_W + step; gx += step) {
      for (let gy = (py % step) - step; gy < FIELD_H + step; gy += step) {
        ctx.fillRect(gx, gy, 3, 3);
      }
    }
    ctx.restore();

    // Technical rules: outer frame + centre line.
    ctx.save();
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = `rgba(${this.palette.ink}, 1)`;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.strokeRect(14, 14, FIELD_W - 28, FIELD_H - 28);

    ctx.globalAlpha = alpha * 0.75;
    ctx.lineWidth = 4;
    ctx.setLineDash([26, 30]);
    ctx.beginPath();
    ctx.moveTo(FIELD_W / 2, 26);
    ctx.lineTo(FIELD_W / 2, FIELD_H - 26);
    ctx.stroke();
    ctx.setLineDash([]);

    // Centre marker ring.
    ctx.globalAlpha = alpha * 0.6;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(FIELD_W / 2, FIELD_H / 2, 74, 0, Math.PI * 2);
    ctx.stroke();

    // Goal zones.
    ctx.globalAlpha = view.suddenDeath ? alpha * 0.8 : alpha * 0.4;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(14, FIELD_H * 0.32);
    ctx.lineTo(14, FIELD_H * 0.68);
    ctx.moveTo(FIELD_W - 14, FIELD_H * 0.32);
    ctx.lineTo(FIELD_W - 14, FIELD_H * 0.68);
    ctx.stroke();
    ctx.restore();
    void t;
  }

  private drawTrail(view: RenderView): void {
    const { ctx } = this;
    if (view.reducedMotion) return;
    const n = this.trail.length;
    for (let i = 0; i < n; i++) {
      const p = this.trail[i];
      const k = (i + 1) / n;
      ctx.save();
      ctx.globalAlpha *= 0.12 * k * k;
      ctx.fillStyle = `rgba(${this.palette.ink}, 1)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BALL_R * (0.3 + 0.5 * k), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawPaddle(side: Side, paddle: PaddleState, view: RenderView, t: number): void {
    const { ctx } = this;
    const cx = paddleCenterX(side);
    const x = cx - PADDLE_W / 2;
    const y = paddle.y - PADDLE_H / 2;
    const lean = Math.max(-1, Math.min(1, paddle.vy / 900)) * 7;

    ctx.save();
    ctx.translate(cx, paddle.y);
    ctx.transform(1, 0, lean / PADDLE_H, 1, 0, 0);

    const serving = view.server === side && view.servePulse > 0;
    ctx.shadowColor = serving ? `rgba(${this.palette.accent}, 0.9)` : `rgba(${this.palette.ink}, 0.35)`;
    ctx.shadowBlur = serving ? 26 * view.servePulse : 10;
    ctx.fillStyle = `rgba(${this.palette.ink}, 0.94)`;
    const r = 12;
    const w = PADDLE_W;
    const h = PADDLE_H;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + r, -h / 2);
    ctx.lineTo(w / 2 - r, -h / 2);
    ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    ctx.lineTo(w / 2, h / 2 - r);
    ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    ctx.lineTo(-w / 2 + r, h / 2);
    ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    ctx.lineTo(-w / 2, -h / 2 + r);
    ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    ctx.closePath();
    ctx.fill();

    // UV core stripe: reads as machined anodised inlay.
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgba(${this.palette.accent}, ${serving ? 0.95 : 0.6})`;
    const stripeH = h * 0.42;
    ctx.fillRect(-w * 0.14, -stripeH / 2, w * 0.28, stripeH);
    ctx.restore();

    if (view.localSplit) {
      ctx.save();
      ctx.globalAlpha *= 0.5;
      ctx.fillStyle = `rgba(${this.palette.ink}, 1)`;
      ctx.font = '600 40px "IBM Plex Mono", monospace';
      ctx.textAlign = side === 0 ? 'left' : 'right';
      ctx.fillText(side === 0 ? 'P1' : 'P2', side === 0 ? 26 : FIELD_W - 26, FIELD_H - 44);
      ctx.restore();
    }
    void x;
    void y;
    void t;
  }

  private drawBall(view: RenderView): void {
    const { ctx } = this;
    const b = view.ball;
    ctx.save();
    ctx.shadowColor = `rgba(${this.palette.ink}, 0.55)`;
    ctx.shadowBlur = 18;
    ctx.fillStyle = `rgba(${this.palette.ink}, 1)`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha *= 0.5;
    ctx.fillStyle = `rgba(${this.palette.flare}, 1)`;
    ctx.beginPath();
    ctx.arc(b.x - BALL_R * 0.3, b.y - BALL_R * 0.32, BALL_R * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawPings(dt: number): void {
    const { ctx } = this;
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        this.pings.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha *= (1 - k) * 0.55;
      ctx.strokeStyle = `rgba(${p.color}, 1)`;
      ctx.lineWidth = 6 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * (0.25 + k * 0.9), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawScore(view: RenderView): void {
    const { ctx } = this;
    const size = view.ambient ? 92 : 108;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${size}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = `rgba(${this.palette.ink}, ${view.ambient ? 0.55 : 0.92})`;
    const y = 132;
    ctx.fillText(String(view.score[0]), FIELD_W / 2 - 118, y);
    ctx.fillText(String(view.score[1]), FIELD_W / 2 + 118, y);
    ctx.globalAlpha *= 0.6;
    ctx.font = '600 34px "IBM Plex Mono", monospace';
    ctx.fillText(':', FIELD_W / 2, y - 4);
    ctx.font = '600 28px "Chakra Petch", sans-serif';
    ctx.globalAlpha *= view.ambient ? 0.4 : 1.2;
    ctx.fillText(view.scoreLabels[0], FIELD_W / 2 - 118, y + 74);
    ctx.fillText(view.scoreLabels[1], FIELD_W / 2 + 118, y + 74);
    // Serve marker.
    if (view.servePulse > 0.02) {
      ctx.globalAlpha *= view.servePulse * 0.9;
      ctx.fillStyle = `rgba(${this.palette.accent}, 1)`;
      const sx = view.server === 0 ? FIELD_W / 2 - 118 : FIELD_W / 2 + 118;
      ctx.beginPath();
      ctx.arc(sx, y - 88, 13, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  render(view: RenderView, dtSeconds: number): void {
    this.begin();
    // Menus sit over a live demo rally; keep it present but clearly secondary.
    this.ctx.globalAlpha = view.ambient ? 0.34 : 1;
    this.drawField(view, 0);
    if (view.showPaddles) {
      this.drawTrail(view);
      this.drawPaddle(0, view.paddles[0], view, 0);
      this.drawPaddle(1, view.paddles[1], view, 0);
    }
    this.drawBall(view);
    if (view.showScore) this.drawScore(view);
    this.drawPings(dtSeconds);

    if (view.showPaddles && !view.reducedMotion) {
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last.x - view.ball.x, last.y - view.ball.y) > 34) {
        this.trail.push({ x: view.ball.x, y: view.ball.y });
        if (this.trail.length > 5) this.trail.shift();
      }
    } else {
      this.trail.length = 0;
    }
    void this.scale;
    void this.cssW;
    void this.cssH;
  }
}
