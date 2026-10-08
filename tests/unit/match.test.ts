import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_TIME,
  FIELD_H,
  FIELD_W,
  SUDDEN_DEATH_SCORE,
  WIN_SCORE,
  createMatch,
  isMatchOverProbe,
  stepMatch,
  type MatchState,
  type Side
} from '../../shared/core/index.js';

function run(state: MatchState, seconds: number, target: number | null = null): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    stepMatch(state, {
      inputs: [
        { dir: 0, target },
        { dir: 0, target }
      ]
    });
  }
}

function runGated(state: MatchState, seconds: number): void {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    stepMatch(state, {
      inputs: [
        { dir: 0, target: null },
        { dir: 0, target: null }
      ],
      serveGate: true
    });
  }
}

function forcePoint(state: MatchState, winner: Side): void {
  state.phase = 'rally';
  state.ball.x = winner === 0 ? FIELD_W + 400 : -400;
  state.ball.y = FIELD_H / 2;
  state.ball.vx = 0;
  state.ball.vy = 0;
  stepMatch(state, { inputs: [{ dir: 0, target: null }, { dir: 0, target: null }] });
}

describe('match flow', () => {
  it('starts in countdown and serves after the timer elapses', () => {
    const state = createMatch(1, 0);
    expect(state.phase).toBe('countdown');
    run(state, COUNTDOWN_TIME + 0.05);
    expect(state.phase).toBe('rally');
    expect(Math.hypot(state.ball.vx, state.ball.vy)).toBeGreaterThan(100);
  });

  it('alternates the serve after every point', () => {
    const state = createMatch(2, 0);
    run(state, COUNTDOWN_TIME + 0.05);
    const first = state.server;
    forcePoint(state, 0);
    run(state, 1.3);
    expect(state.server).toBe(first === 0 ? 1 : 0);
    forcePoint(state, 1);
    run(state, 1.3);
    expect(state.server).toBe(first);
  });

  it('respects the explicit serve gate when enabled', () => {
    const state = createMatch(3, 0);
    runGated(state, COUNTDOWN_TIME + 0.1);
    expect(state.phase).toBe('countdown');
    stepMatch(state, { inputs: [{ dir: 0, target: null }, { dir: 0, target: null }], serveGate: true });
    expect(state.phase).toBe('countdown');
    stepMatch(state, {
      inputs: [
        { dir: 0, target: null, serve: true },
        { dir: 0, target: null }
      ],
      serveGate: true
    });
    expect(state.phase).toBe('rally');
  });

  it('ignores the serve gate from the receiving side', () => {
    const state = createMatch(3, 0);
    runGated(state, COUNTDOWN_TIME + 0.1);
    stepMatch(state, {
      inputs: [
        { dir: 0, target: null },
        { dir: 0, target: null, serve: true }
      ],
      serveGate: true
    });
    expect(state.phase).toBe('countdown');
  });

  it('requires a two-point margin and reaches game over', () => {
    const state = createMatch(4, 0);
    for (let i = 0; i < WIN_SCORE - 1; i++) {
      forcePoint(state, 0);
      run(state, 1.3);
    }
    expect(isMatchOverProbe(state.score).over).toBe(false);
    forcePoint(state, 0);
    expect(isMatchOverProbe(state.score).over).toBe(true);
    expect(isMatchOverProbe(state.score).winner).toBe(0);
  });

  it('does not win on a one-point margin at 7-6', () => {
    const state = createMatch(5, 0);
    state.score = [6, 6];
    forcePoint(state, 0);
    expect(state.score).toEqual([7, 6]);
    expect(isMatchOverProbe(state.score).over).toBe(false);
  });

  it('enters sudden death at 10-10 and decides on the next point', () => {
    const state = createMatch(6, 0);
    state.score = [SUDDEN_DEATH_SCORE, SUDDEN_DEATH_SCORE];
    expect(isMatchOverProbe(state.score).over).toBe(false);
    forcePoint(state, 1);
    expect(state.score).toEqual([10, 11]);
    expect(isMatchOverProbe(state.score).over).toBe(true);
    expect(isMatchOverProbe(state.score).winner).toBe(1);
  });

  it('freezes the world while paused', () => {
    const state = createMatch(7, 0);
    run(state, COUNTDOWN_TIME + 0.2);
    const before = JSON.stringify(state.ball);
    state.phase = 'paused';
    run(state, 2);
    expect(JSON.stringify(state.ball)).toBe(before);
  });
});
