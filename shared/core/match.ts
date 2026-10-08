import {
  BALL_R,
  COUNTDOWN_TIME,
  FIELD_H,
  FIELD_W,
  MAX_BOUNCE_ANGLE,
  PADDLE_H,
  PADDLE_SPEED,
  POINT_PAUSE,
  SERVE_SPEED,
  STEP,
  SUDDEN_DEATH_SCORE,
  WIN_SCORE,
  clamp,
  paddleCenterX
} from './constants.js';
import { nextRandom } from './rng.js';
import { advanceBall } from './physics.js';
import type { MatchState, PaddleInput, Side, SimEvent } from './types.js';

export function createMatch(seed: number, server: Side = 0): MatchState {
  return {
    phase: 'countdown',
    score: [0, 0],
    server,
    ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0 },
    paddles: [
      { y: FIELD_H / 2, vy: 0 },
      { y: FIELD_H / 2, vy: 0 }
    ],
    timer: COUNTDOWN_TIME,
    pointWinner: null,
    matchWinner: null,
    rallyHits: 0,
    suddenDeath: false,
    elapsed: 0,
    seed,
    rngState: seed >>> 0
  };
}

export function resetMatch(state: MatchState, seed: number, server: Side = 0): void {
  const fresh = createMatch(seed, server);
  Object.assign(state, fresh);
}

function serve(state: MatchState, toward: Side): void {
  const from: Side = toward === 0 ? 1 : 0;
  const r = nextRandom(state.rngState);
  state.rngState = r.state;
  const angle = (r.value * 2 - 1) * MAX_BOUNCE_ANGLE * 0.55;
  const dir = toward === 0 ? -1 : 1;
  state.ball.x = paddleCenterX(from) + dir * -1 * 26;
  state.ball.x = clamp(state.ball.x, FIELD_W * 0.3, FIELD_W * 0.7);
  state.ball.y = FIELD_H / 2 + (r.value * 2 - 1) * 120;
  state.ball.vx = Math.cos(angle) * SERVE_SPEED * dir;
  state.ball.vy = Math.sin(angle) * SERVE_SPEED;
  state.rallyHits = 0;
}

/** Move one paddle deterministically toward its intent, clamped to the field. */
export function applyPaddle(paddle: { y: number; vy: number }, input: PaddleInput, dt: number): void {
  const dir = clamp(input.dir, -1, 1);
  let vy = 0;
  if (input.target !== null && Number.isFinite(input.target)) {
    const delta = input.target - paddle.y;
    const maxStep = PADDLE_SPEED * dt;
    if (Math.abs(delta) <= maxStep) {
      vy = delta / dt;
      paddle.y = input.target;
    } else {
      vy = Math.sign(delta) * PADDLE_SPEED;
      paddle.y += vy * dt;
    }
  } else if (dir !== 0) {
    vy = dir * PADDLE_SPEED;
    paddle.y += vy * dt;
  }
  const half = PADDLE_H / 2;
  const clamped = clamp(paddle.y, half, FIELD_H - half);
  if (clamped !== paddle.y) vy = 0;
  paddle.y = clamped;
  paddle.vy = vy;
}

function isMatchOver(score: [number, number]): { over: boolean; winner: Side | null } {
  const [a, b] = score;
  if (a >= SUDDEN_DEATH_SCORE && b >= SUDDEN_DEATH_SCORE) {
    // Sudden death: the next point decides.
    if (a !== b) return { over: true, winner: a > b ? 0 : 1 };
    return { over: false, winner: null };
  }
  if (a >= WIN_SCORE && a - b >= 2) return { over: true, winner: 0 };
  if (b >= WIN_SCORE && b - a >= 2) return { over: true, winner: 1 };
  return { over: false, winner: null };
}

/** Test-facing alias for the win-condition predicate. */
export const isMatchOverProbe = (score: [number, number]): { over: boolean; winner: Side | null } =>
  isMatchOver(score);

export function isSuddenDeath(score: [number, number]): boolean {
  return score[0] >= SUDDEN_DEATH_SCORE && score[1] >= SUDDEN_DEATH_SCORE;
}

export interface StepOptions {
  inputs: [PaddleInput, PaddleInput];
  /** When true, pause/countdown timers advance; rally physics always run when live. */
  allowInput?: boolean;
  /**
   * Online mode: hold at a zero countdown until the serving side explicitly
   * requests the serve. Offline leaves this off so rallies start automatically.
   */
  serveGate?: boolean;
}

/**
 * One deterministic fixed step (@60 Hz) of the offline/local match.
 * Pure with respect to DOM/network. Mutates `state`.
 */
export function stepMatch(state: MatchState, opts: StepOptions): SimEvent[] {
  const events: SimEvent[] = [];
  const dt = STEP;
  const allowInput = opts.allowInput !== false;

  if (state.phase === 'paused' || state.phase === 'game-over' || state.phase === 'attract') {
    return events;
  }

  state.elapsed += dt;

  if (state.phase === 'countdown') {
    applyPaddle(state.paddles[0], allowInput ? opts.inputs[0] : { dir: 0, target: null }, dt);
    applyPaddle(state.paddles[1], allowInput ? opts.inputs[1] : { dir: 0, target: null }, dt);
    const before = Math.ceil(state.timer);
    state.timer -= dt;
    const after = Math.ceil(state.timer);
    if (after !== before && after > 0) events.push({ kind: 'countdown', value: after });
    if (state.timer <= 0) {
      state.timer = 0;
      const waitingForServe = opts.serveGate === true && opts.inputs[state.server].serve !== true;
      if (waitingForServe) {
        state.phase = 'countdown';
        return events;
      }
      state.phase = 'rally';
      serve(state, state.server);
      events.push({ kind: 'countdown', value: 0 });
    }
    return events;
  }

  if (state.phase === 'point') {
    applyPaddle(state.paddles[0], allowInput ? opts.inputs[0] : { dir: 0, target: null }, dt);
    applyPaddle(state.paddles[1], allowInput ? opts.inputs[1] : { dir: 0, target: null }, dt);
    state.timer -= dt;
    if (state.timer <= 0) {
      const over = isMatchOver(state.score);
      if (over.over && over.winner !== null) {
        state.phase = 'game-over';
        state.matchWinner = over.winner;
        events.push({ kind: 'game-over', side: over.winner });
      } else {
        state.phase = 'countdown';
        state.timer = COUNTDOWN_TIME;
        state.server = state.server === 0 ? 1 : 0;
        state.suddenDeath = isSuddenDeath(state.score);
        events.push({ kind: 'countdown', value: COUNTDOWN_TIME });
      }
    }
    return events;
  }

  // rally
  applyPaddle(state.paddles[0], allowInput ? opts.inputs[0] : { dir: 0, target: null }, dt);
  applyPaddle(state.paddles[1], allowInput ? opts.inputs[1] : { dir: 0, target: null }, dt);

  const res = advanceBall(state.ball, state.paddles, dt);
  for (const e of res.events) {
    if (e.kind === 'paddle') state.rallyHits++;
    events.push(e);
  }

  if (res.scored !== null) {
    const winner = res.scored;
    state.score[winner]++;
    state.pointWinner = winner;
    state.phase = 'point';
    state.timer = POINT_PAUSE;
    state.ball.vx = 0;
    state.ball.vy = 0;
    events.push({ kind: 'point', side: winner, score: [...state.score] as [number, number] });
  }

  return events;
}

/** Force an immediate serve toward `toward` and go live (used by attract mode and practice). */
export function serveBall(state: MatchState, toward: Side): void {
  serve(state, toward);
  state.phase = 'rally';
  state.timer = 0;
}

/** True when a serve is currently required from `side`. */
export function mustServe(state: MatchState, side: Side): boolean {
  return state.phase === 'countdown' && state.server === side;
}

export function ballSpeed(state: MatchState): number {
  return Math.hypot(state.ball.vx, state.ball.vy);
}

export function fieldMetrics(): { w: number; h: number; ballR: number; paddleW: number; paddleH: number; paddleInset: number } {
  return {
    w: FIELD_W,
    h: FIELD_H,
    ballR: BALL_R,
    paddleW: 30,
    paddleH: PADDLE_H,
    paddleInset: 46
  };
}
