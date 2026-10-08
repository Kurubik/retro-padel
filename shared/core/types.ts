export type Side = 0 | 1;
export type CpuLevel = 'rookie' | 'pro' | 'legend';

export type MatchPhase =
  | 'attract'
  | 'mode-select'
  | 'lobby'
  | 'countdown'
  | 'rally'
  | 'point'
  | 'paused'
  | 'game-over'
  | 'reconnecting';

export interface Vec2 {
  x: number;
  y: number;
}

export interface PaddleState {
  /** Centre Y of the paddle. */
  y: number;
  /** Last applied velocity (units/s) — used for spin and rendering lean. */
  vy: number;
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** A player's intent. Online clients may only ever send `dir` and `serve`. */
export interface PaddleInput {
  /** -1 (up) .. 1 (down). Local pointer/touch may instead supply an absolute target. */
  dir: number;
  /** Absolute centre-Y target (local devices only). Null when unused. */
  target: number | null;
  /** One-shot serve request. Only honoured for the current server while in countdown. */
  serve?: boolean;
}

export interface MatchState {
  phase: MatchPhase;
  /** [left, right] */
  score: [number, number];
  server: Side;
  ball: BallState;
  paddles: [PaddleState, PaddleState];
  /** Seconds remaining in countdown/point pause. */
  timer: number;
  /** Winner of the most recent point (null while a rally is live). */
  pointWinner: Side | null;
  matchWinner: Side | null;
  rallyHits: number;
  suddenDeath: boolean;
  /** Seconds of match time actually simulated. */
  elapsed: number;
  seed: number;
  rngState: number;
}

export interface StepResult {
  /** Events emitted during this fixed step, in order. */
  events: SimEvent[];
}

export type SimEvent =
  | { kind: 'wall'; side: Side }
  | { kind: 'paddle'; side: Side; offset: number; speed: number }
  | { kind: 'point'; side: Side; score: [number, number] }
  | { kind: 'countdown'; value: number }
  | { kind: 'game-over'; side: Side };
