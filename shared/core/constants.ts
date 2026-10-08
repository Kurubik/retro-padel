/**
 * RETRO//PADEL — shared simulation constants.
 * The field uses a fixed internal coordinate system (units), independent of DOM pixels.
 * The ball moves primarily along X: left paddle = side 0, right paddle = side 1.
 */

export const FIELD_W = 1000;
export const FIELD_H = 1120;

export const PADDLE_W = 34;
export const PADDLE_H = 190;
export const PADDLE_INSET = 46;
export const PADDLE_SPEED = 940; // units per second, full deflection

export const BALL_R = 24;
export const BALL_BASE_SPEED = 560;
export const BALL_MAX_SPEED = 1560;
export const BALL_SPEEDUP = 1.045;
export const MAX_BOUNCE_ANGLE = 0.66; // radians away from the horizontal axis

export const STEP_HZ = 60;
export const STEP = 1 / STEP_HZ;

export const WIN_SCORE = 7;
export const SUDDEN_DEATH_SCORE = 10;
export const POINT_PAUSE = 1.15;
export const COUNTDOWN_TIME = 3;
export const SERVE_SPEED = 520;

export const PROTOCOL_VERSION = 'RP1';
export const SNAPSHOT_EVERY = 3; // ticks -> 20 Hz
export const ROOM_CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'; // no O/0, I/1/L, B/8, S/5, Z/2 look-alikes
export const ROOM_CODE_LEN = 6;
export const RECONNECT_GRACE_MS = 60_000;

export const LEFT_PADDLE_X = PADDLE_INSET;
export const RIGHT_PADDLE_X = FIELD_W - PADDLE_INSET - PADDLE_W;

/** Centre X of the paddle on the given side. */
export function paddleCenterX(side: 0 | 1): number {
  return side === 0 ? LEFT_PADDLE_X + PADDLE_W / 2 : RIGHT_PADDLE_X + PADDLE_W / 2;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
