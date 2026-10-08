import { BALL_R, FIELD_H, PADDLE_H, PADDLE_SPEED, STEP, clamp, paddleCenterX } from './constants.js';
import { nextRandom } from './rng.js';
import type { CpuLevel, MatchState, PaddleInput, Side } from './types.js';

export interface CpuProfile {
  /** Fraction of full paddle speed the CPU is willing to use. */
  speed: number;
  /** Aiming error in field units (std-dev-ish). */
  error: number;
  /** Seconds of reaction lag before new information is used. */
  reaction: number;
  /** Chance per second of a deliberate mistime / idle beat. */
  slip: number;
  /** How far ahead (seconds) the CPU tries to predict the ball. */
  lookahead: number;
}

export const CPU_PROFILES: Record<CpuLevel, CpuProfile> = {
  rookie: { speed: 0.55, error: 130, reaction: 0.26, slip: 0.9, lookahead: 0.05 },
  pro: { speed: 0.8, error: 52, reaction: 0.13, slip: 0.32, lookahead: 0.18 },
  legend: { speed: 1.0, error: 14, reaction: 0.05, slip: 0.05, lookahead: 0.42 }
};

export function createCpuMemory(): CpuMemory {
  return { rngState: 0x9e3779b9, sampledBallY: FIELD_H / 2, sampleTimer: 0, slipTimer: 0, slipUntil: 0, aimOffset: 0 };
}

export interface CpuMemory {
  rngState: number;
  sampledBallY: number;
  sampleTimer: number;
  slipTimer: number;
  slipUntil: number;
  aimOffset: number;
}

/** Predict the ball's Y at the CPU paddle plane, accounting for wall bounces. */
export function predictBallY(state: MatchState, side: Side, profile: CpuProfile): number {
  const ball = state.ball;
  if (Math.abs(ball.vx) < 1) return ball.y;
  const plane = paddleCenterX(side);
  const t = (plane - ball.x) / ball.vx;
  if (t < 0 || t > 4) return ball.y;
  const travel = Math.min(t, profile.lookahead + t * 0.6);
  let y = ball.y + ball.vy * travel;
  const span = FIELD_H - 2 * BALL_R;
  // Reflect into range to emulate wall bounces.
  y = Math.abs(y % (2 * span));
  if (y > span) y = 2 * span - y;
  return y + BALL_R;
}

/**
 * Deterministic CPU intent for one fixed step.
 * Uses `memory` for reaction lag, aiming error and deliberate slips so that
 * identical seeds give identical behaviour (replayable tests).
 */
export function cpuInput(
  state: MatchState,
  side: Side,
  level: CpuLevel,
  memory: CpuMemory
): PaddleInput {
  const profile = CPU_PROFILES[level];
  const dt = STEP;

  memory.sampleTimer -= dt;
  if (memory.sampleTimer <= 0) {
    memory.sampleTimer = profile.reaction;
    memory.sampledBallY = predictBallY(state, side, profile);
    const r1 = nextRandom(memory.rngState);
    memory.rngState = r1.state;
    memory.aimOffset = (r1.value * 2 - 1) * profile.error;
  }

  memory.slipTimer -= dt;
  if (memory.slipTimer <= 0) {
    memory.slipTimer = 0.5 + (memory.rngState % 1000) / 1000;
    const r2 = nextRandom(memory.rngState);
    memory.rngState = r2.state;
    if (r2.value < profile.slip * 0.5) {
      memory.slipUntil = state.elapsed + 0.12 + r2.value * 0.2;
    }
  }

  const paddle = state.paddles[side];
  let targetY = memory.sampledBallY + memory.aimOffset;

  if (state.phase === 'point' || state.phase === 'game-over') {
    targetY = FIELD_H / 2;
  }
  if (state.elapsed < memory.slipUntil) {
    targetY = paddle.y; // deliberate hesitation
  }

  const maxSpeed = PADDLE_SPEED * profile.speed;
  const delta = targetY - paddle.y;
  const dir = clamp(delta / (maxSpeed * dt * 4), -1, 1);
  return { dir, target: null };
}

/** Required paddle travel to fully block the ball — used by tests. */
export function blockReach(): { paddleH: number; half: number } {
  return { paddleH: PADDLE_H, half: PADDLE_H / 2 };
}
