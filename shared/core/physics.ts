import {
  BALL_BASE_SPEED,
  BALL_MAX_SPEED,
  BALL_R,
  BALL_SPEEDUP,
  FIELD_H,
  FIELD_W,
  MAX_BOUNCE_ANGLE,
  PADDLE_H,
  PADDLE_W,
  paddleCenterX,
  clamp
} from './constants.js';
import type { BallState, PaddleState, Side, SimEvent } from './types.js';

export interface Collision {
  /** Normalised time-of-impact within the swept segment, 0..1. */
  t: number;
  axis: 'x' | 'y';
  kind: 'wall' | 'paddle';
  side: Side;
}

interface Aabb {
  x: number;
  y: number;
  w: number;
  h: number;
}

function paddleAabb(side: Side, paddle: PaddleState): Aabb {
  const cx = paddleCenterX(side);
  return { x: cx - PADDLE_W / 2, y: paddle.y - PADDLE_H / 2, w: PADDLE_W, h: PADDLE_H };
}

/**
 * Swept circle-vs-AABB using the Minkowski expansion, via slab clipping.
 * Returns the earliest entry time along the segment, or null when it never enters.
 */
function sweepCircleAabb(
  px: number,
  py: number,
  dx: number,
  dy: number,
  r: number,
  box: Aabb
): { t: number; axis: 'x' | 'y' } | null {
  const minX = box.x - r;
  const maxX = box.x + box.w + r;
  const minY = box.y - r;
  const maxY = box.y + box.h + r;

  let tEnter = 0;
  let tExit = 1;

  if (dx === 0) {
    if (px < minX || px > maxX) return null;
  } else {
    let t1 = (minX - px) / dx;
    let t2 = (maxX - px) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tEnter = Math.max(tEnter, t1);
    tExit = Math.min(tExit, t2);
    if (tEnter > tExit) return null;
  }

  if (dy === 0) {
    if (py < minY || py > maxY) return null;
  } else {
    let t1 = (minY - py) / dy;
    let t2 = (maxY - py) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tEnter = Math.max(tEnter, t1);
    tExit = Math.min(tExit, t2);
    if (tEnter > tExit) return null;
  }

  if (tEnter < 0 || tEnter > 1) return null;
  // Entry axis is the one whose slab set the bound last.
  const axis: 'x' | 'y' =
    dx !== 0 && Math.abs(tEnter - (box.x - r - px) / dx) < 1e-9
      ? 'x'
      : dy !== 0
        ? 'y'
        : 'x';
  return { t: tEnter, axis };
}

/** Find the earliest collision of the ball's swept path against walls and paddles. */
export function sweepBall(
  ball: BallState,
  dx: number,
  dy: number,
  paddles: [PaddleState, PaddleState]
): Collision | null {
  let best: Collision | null = null;
  const consider = (c: Collision | null) => {
    if (!c) return;
    if (!best || c.t < best.t - 1e-9) best = c;
  };

  // Top/bottom walls.
  if (dy < 0) {
    const t = (BALL_R - ball.y) / dy;
    if (t >= 0 && t <= 1) consider({ t, axis: 'y', kind: 'wall', side: 0 });
  } else if (dy > 0) {
    const t = (FIELD_H - BALL_R - ball.y) / dy;
    if (t >= 0 && t <= 1) consider({ t, axis: 'y', kind: 'wall', side: 0 });
  }

  for (const side of [0, 1] as const) {
    if ((side === 0 && dx >= 0) || (side === 1 && dx <= 0)) continue;
    const hit = sweepCircleAabb(ball.x, ball.y, dx, dy, BALL_R, paddleAabb(side, paddles[side]));
    if (hit) consider({ t: hit.t, axis: hit.axis, kind: 'paddle', side });
  }

  return best;
}

/**
 * Advance the ball by (vx,vy)*dt with swept collision resolution.
 * Reflects velocity on impact, applies a capped speed-up on paddle hits,
 * and reports events. Mutates `ball` and `paddles` (paddle vy for spin).
 */
export function advanceBall(
  ball: BallState,
  paddles: [PaddleState, PaddleState],
  dt: number
): { events: SimEvent[]; scored: Side | null } {
  const events: SimEvent[] = [];
  let remaining = 1;
  let guard = 0;

  while (remaining > 1e-6 && guard++ < 8) {
    const dx = ball.vx * dt * remaining;
    const dy = ball.vy * dt * remaining;

    // Goal check happens before wall/paddle resolution so a ball cannot
    // bounce off the far wall behind a paddle.
    const hit = sweepBall(ball, dx, dy, paddles);

    if (!hit) {
      ball.x += dx;
      ball.y += dy;
      remaining = 0;
      break;
    }

    ball.x += dx * hit.t;
    ball.y += dy * hit.t;
    remaining *= 1 - hit.t;

    if (hit.kind === 'wall') {
      ball.vy = -ball.vy;
      ball.y = clamp(ball.y, BALL_R, FIELD_H - BALL_R);
      events.push({ kind: 'wall', side: hit.side });
    } else {
      const paddle = paddles[hit.side];
      const offset = clamp((ball.y - paddle.y) / (PADDLE_H / 2 + BALL_R), -1, 1);
      const angle = offset * MAX_BOUNCE_ANGLE;
      const incoming = Math.hypot(ball.vx, ball.vy);
      const boosted = Math.min(Math.max(incoming, BALL_BASE_SPEED) * BALL_SPEEDUP, BALL_MAX_SPEED);
      const dir = hit.side === 0 ? 1 : -1;
      // Paddle motion adds a bounded amount of spin, then the vector is renormalised.
      const spin = clamp(paddle.vy * 0.09, -260, 260);
      const vy = Math.sin(angle) * boosted + spin;
      const norm = Math.hypot(Math.cos(angle) * boosted, vy) || 1;
      const scale = Math.min(boosted, BALL_MAX_SPEED) / norm;
      ball.vx = Math.cos(angle) * boosted * dir * scale;
      ball.vy = vy * scale;
      ball.x = clamp(ball.x, BALL_R, FIELD_W - BALL_R);
      events.push({ kind: 'paddle', side: hit.side, offset, speed: boosted });
    }

    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > BALL_MAX_SPEED) {
      ball.vx *= BALL_MAX_SPEED / sp;
      ball.vy *= BALL_MAX_SPEED / sp;
    }
  }

  // Goal detection.
  let scored: Side | null = null;
  if (ball.x + BALL_R < 0) scored = 1;
  else if (ball.x - BALL_R > FIELD_W) scored = 0;

  return { events, scored };
}
