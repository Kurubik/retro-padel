import { PROTOCOL_VERSION } from './core/constants.js';
import type { BallState, MatchPhase, PaddleState, Side, CpuLevel } from './core/types.js';

export { PROTOCOL_VERSION };

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'BAD_VERSION'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'FULL'
  | 'BAD_TOKEN'
  | 'EXPIRED'
  | 'NOT_IN_ROOM'
  | 'SERVER_BUSY';

export type ClientMessage =
  | { t: 'hello'; v: string }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'reclaim'; code: string; token: string }
  | { t: 'input'; seq: number; dir: number; serve: boolean }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'rematch' }
  | { t: 'leave' }
  | { t: 'ping'; ts: number };

export interface WireSnapshot {
  tick: number;
  /** Server epoch ms this snapshot describes. */
  at: number;
  phase: MatchPhase | 'lobby';
  score: [number, number];
  server: Side;
  ball: BallState;
  paddles: [PaddleState, PaddleState];
  timer: number;
  rallyHits: number;
  suddenDeath: boolean;
  matchWinner: Side | null;
  pointWinner: Side | null;
  /** Which sides are currently connected. */
  connected: [boolean, boolean];
}

export type ServerMessage =
  | { t: 'welcome'; v: string; at: number }
  | {
      t: 'room';
      code: string;
      side: Side;
      token: string;
      phase: MatchPhase | 'lobby';
      connected: [boolean, boolean];
      /** True while the opponent has dropped but may still reclaim. */
      reclaimExpiresAt: number | null;
    }
  | ({ t: 'state' } & WireSnapshot)
  | {
      t: 'event';
      kind: 'point' | 'game-over' | 'connect' | 'disconnect' | 'expired' | 'rematch' | 'paused' | 'resumed';
      side?: Side;
      score?: [number, number];
    }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong'; ts: number; at: number };

const MAX_MESSAGE_BYTES = 512;

/** Parse + validate an inbound frame. Returns null when unusable. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case 'hello':
      return typeof m.v === 'string' ? { t: 'hello', v: m.v } : null;
    case 'create':
      return { t: 'create' };
    case 'join':
      return typeof m.code === 'string' ? { t: 'join', code: m.code.toUpperCase().slice(0, 12) } : null;
    case 'reclaim':
      return typeof m.code === 'string' && typeof m.token === 'string'
        ? { t: 'reclaim', code: m.code.toUpperCase().slice(0, 12), token: m.token.slice(0, 128) }
        : null;
    case 'input': {
      if (typeof m.dir !== 'number' || !Number.isFinite(m.dir)) return null;
      const seq = typeof m.seq === 'number' && Number.isFinite(m.seq) ? Math.floor(m.seq) : 0;
      return { t: 'input', seq, dir: Math.max(-1, Math.min(1, m.dir)), serve: m.serve === true };
    }
    case 'pause':
      return { t: 'pause' };
    case 'resume':
      return { t: 'resume' };
    case 'rematch':
      return { t: 'rematch' };
    case 'leave':
      return { t: 'leave' };
    case 'ping':
      return { t: 'ping', ts: typeof m.ts === 'number' && Number.isFinite(m.ts) ? m.ts : 0 };
    default:
      return null;
  }
}

export function versionMatches(v: string | undefined): boolean {
  return v === PROTOCOL_VERSION;
}

export type { CpuLevel };
