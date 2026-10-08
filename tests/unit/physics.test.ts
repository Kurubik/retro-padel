import { describe, expect, it } from 'vitest';
import {
  BALL_MAX_SPEED,
  BALL_R,
  FIELD_H,
  FIELD_W,
  PADDLE_H,
  STEP,
  advanceBall,
  createMatch,
  paddleCenterX,
  stepMatch,
  type BallState,
  type MatchState,
  type PaddleState
} from '../../shared/core/index.js';

function paddles(y0 = FIELD_H / 2, y1 = FIELD_H / 2): [PaddleState, PaddleState] {
  return [
    { y: y0, vy: 0 },
    { y: y1, vy: 0 }
  ];
}

describe('swept collision', () => {
  it('never tunnels through a paddle at maximum velocity', () => {
    const ball: BallState = { x: paddleCenterX(0) + 300, y: FIELD_H / 2, vx: -BALL_MAX_SPEED, vy: 0 };
    const p = paddles();
    let hits = 0;
    const dt = STEP;
    for (let i = 0; i < 240; i++) {
      const res = advanceBall(ball, p, dt);
      hits += res.events.filter((e) => e.kind === 'paddle').length;
      if (res.scored !== null) break;
      expect(ball.x).toBeGreaterThanOrEqual(-BALL_R - 1);
      expect(ball.x).toBeLessThanOrEqual(FIELD_W + BALL_R + 1);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('bounces off the top and bottom walls without leaving the field', () => {
    const ball: BallState = { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: BALL_MAX_SPEED };
    const p = paddles(-10_000, -10_000);
    let walls = 0;
    for (let i = 0; i < 400; i++) {
      const res = advanceBall(ball, p, STEP);
      walls += res.events.filter((e) => e.kind === 'wall').length;
      expect(ball.y).toBeGreaterThanOrEqual(BALL_R - 0.5);
      expect(ball.y).toBeLessThanOrEqual(FIELD_H - BALL_R + 0.5);
    }
    expect(walls).toBeGreaterThan(3);
  });

  it('reflects off a paddle corner with a bounded bounce angle', () => {
    const ball: BallState = { x: paddleCenterX(0) + 20, y: FIELD_H / 2 + PADDLE_H / 2 + BALL_R, vx: -BALL_MAX_SPEED, vy: 0 };
    const p = paddles();
    const res = advanceBall(ball, p, STEP * 2);
    const hit = res.events.find((e) => e.kind === 'paddle');
    expect(hit).toBeDefined();
    expect(Math.abs(ball.vx)).toBeGreaterThan(0);
    expect(Math.hypot(ball.vx, ball.vy)).toBeLessThanOrEqual(BALL_MAX_SPEED + 1);
  });

  it('caps speed growth over a long volley', () => {
    const state: MatchState = createMatch(7, 0);
    state.phase = 'rally';
    state.ball = { x: FIELD_W / 2, y: FIELD_H / 2, vx: 500, vy: 90 };
    for (let i = 0; i < 20_000; i++) {
      stepMatch(state, {
        inputs: [
          { dir: 0, target: state.ball.y },
          { dir: 0, target: state.ball.y }
        ]
      });
      expect(Math.hypot(state.ball.vx, state.ball.vy)).toBeLessThanOrEqual(BALL_MAX_SPEED + 2);
    }
    expect(Number.isFinite(state.ball.x)).toBe(true);
  });

  it('detects a goal only past the goal line', () => {
    const ball: BallState = { x: 100, y: FIELD_H / 2, vx: -BALL_MAX_SPEED, vy: 0 };
    const p = paddles(-10_000, -10_000);
    let scored: number | null = null;
    for (let i = 0; i < 60 && scored === null; i++) {
      scored = advanceBall(ball, p, STEP).scored;
    }
    expect(scored).toBe(1);
  });
});
