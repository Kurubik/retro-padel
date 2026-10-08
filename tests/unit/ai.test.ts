import { describe, expect, it } from 'vitest';
import {
  CPU_PROFILES,
  FIELD_H,
  cpuInput,
  createCpuMemory,
  createMatch,
  stepMatch,
  type CpuLevel,
  type MatchState,
  type PaddleInput
} from '../../shared/core/index.js';

function playLevel(level: CpuLevel, seconds: number): MatchState {
  const state = createMatch(99, 0);
  const memory = createCpuMemory();
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    const cpu = cpuInput(state, 1, level, memory);
    const human: PaddleInput = { dir: 0, target: state.ball.y };
    stepMatch(state, { inputs: [human, cpu] });
  }
  return state;
}

describe('cpu personalities', () => {
  it('orders the profiles from softest to sharpest', () => {
    expect(CPU_PROFILES.rookie.speed).toBeLessThan(CPU_PROFILES.pro.speed);
    expect(CPU_PROFILES.pro.speed).toBeLessThan(CPU_PROFILES.legend.speed);
    expect(CPU_PROFILES.rookie.error).toBeGreaterThan(CPU_PROFILES.pro.error);
    expect(CPU_PROFILES.pro.error).toBeGreaterThan(CPU_PROFILES.legend.error);
    expect(CPU_PROFILES.rookie.reaction).toBeGreaterThan(CPU_PROFILES.legend.reaction);
  });

  it('keeps every level inside the field', () => {
    for (const level of ['rookie', 'pro', 'legend'] as CpuLevel[]) {
      const state = playLevel(level, 20);
      for (const paddle of state.paddles) {
        expect(paddle.y).toBeGreaterThanOrEqual(95 - 1);
        expect(paddle.y).toBeLessThanOrEqual(FIELD_H - 95 + 1);
      }
    }
  });

  it('lets the sharper level win more points over the same horizon', () => {
    const legend = playLevel('legend', 60);
    const rookie = playLevel('rookie', 60);
    expect(legend.score[1]).toBeGreaterThanOrEqual(rookie.score[1]);
  });

  it('is deterministic for a given seed', () => {
    const a = playLevel('pro', 12);
    const b = playLevel('pro', 12);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('hesitates at least once at the softest level', () => {
    const state = createMatch(3, 0);
    const memory = createCpuMemory();
    let zeroDir = 0;
    for (let i = 0; i < 3600; i++) {
      const input = cpuInput(state, 1, 'rookie', memory);
      if (input.dir === 0) zeroDir++;
      stepMatch(state, { inputs: [{ dir: 0, target: null }, input] });
    }
    expect(zeroDir).toBeGreaterThan(30);
  });
});
