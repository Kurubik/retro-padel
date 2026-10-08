import { randomBytes } from 'node:crypto';
import {
  RECONNECT_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LEN,
  SNAPSHOT_EVERY,
  COUNTDOWN_TIME,
  STEP
} from '../shared/core/constants.js';
import { createMatch, stepMatch, resetMatch } from '../shared/core/match.js';
import type { MatchState, PaddleInput, Side } from '../shared/core/types.js';
import type { WireSnapshot } from '../shared/protocol.js';

export type RoomEventKind =
  | 'point'
  | 'game-over'
  | 'connect'
  | 'disconnect'
  | 'expired'
  | 'rematch'
  | 'paused'
  | 'resumed';

export interface RoomEvent {
  kind: RoomEventKind;
  side?: Side;
  score?: [number, number];
}

export interface RoomClock {
  now(): number;
}

export class Room {
  readonly code: string;
  readonly match: MatchState;
  /** Raw intent per side, already sanitised by the transport. */
  readonly inputs: [PaddleInput, PaddleInput] = [
    { dir: 0, target: null },
    { dir: 0, target: null }
  ];
  /** Crypto reconnect token per side; `null` while that seat is unclaimed. */
  readonly tokens: [string | null, string | null] = [null, null];
  readonly connected: [boolean, boolean] = [false, false];
  /** When a seat dropped, the epoch ms until which it may be reclaimed. */
  readonly reclaimUntil: [number | null, number | null] = [null, null];
  readonly rematchVotes = new Set<Side>();
  paused = false;
  tick = 0;
  lastActivity: number;
  started = false;
  private readonly clock: RoomClock;

  constructor(code: string, clock: RoomClock, seed: number) {
    this.code = code;
    this.clock = clock;
    this.match = createMatch(seed, 0);
    this.match.phase = 'countdown';
    this.lastActivity = clock.now();
  }

  static generateCode(rand: (n: number) => Buffer = (n) => randomBytes(n)): string {
    const bytes = rand(ROOM_CODE_LEN);
    let out = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
    return out;
  }

  static newToken(rand: (n: number) => Buffer = (n) => randomBytes(n)): string {
    return rand(24).toString('hex');
  }

  /** Seat a fresh connection, reusing the first free seat or the reclaimable one. */
  claimSeat(token: string | null): { side: Side; token: string } | null {
    const now = this.clock.now();
    if (token !== null) {
      for (const side of [0, 1] as const) {
        if (!this.connected[side] && this.tokens[side] === token) {
          this.connected[side] = true;
          this.reclaimUntil[side] = null;
          this.lastActivity = now;
          return { side, token };
        }
      }
      return null;
    }
    for (const side of [0, 1] as const) {
      if (!this.connected[side] && this.tokens[side] === null) {
        const fresh = Room.newToken();
        this.tokens[side] = fresh;
        this.connected[side] = true;
        this.reclaimUntil[side] = null;
        this.lastActivity = now;
        return { side, token: fresh };
      }
    }
    return null;
  }

  disconnect(side: Side): void {
    this.connected[side] = false;
    this.reclaimUntil[side] = this.clock.now() + RECONNECT_GRACE_MS;
    this.inputs[side] = { dir: 0, target: null };
    if (this.match.phase === 'rally') this.paused = true;
    this.lastActivity = this.clock.now();
  }

  /** Drop seats whose reclaim window elapsed. Returns the released sides. */
  expireSeats(): Side[] {
    const now = this.clock.now();
    const released: Side[] = [];
    for (const side of [0, 1] as const) {
      const until = this.reclaimUntil[side];
      if (!this.connected[side] && until !== null && now >= until) {
        this.reclaimUntil[side] = null;
        this.tokens[side] = null;
        released.push(side);
      }
    }
    return released;
  }

  get empty(): boolean {
    return !this.connected[0] && !this.connected[1];
  }

  get bothConnected(): boolean {
    return this.connected[0] && this.connected[1];
  }

  bothReadyToReclaim(): boolean {
    return this.reclaimUntil[0] === null && this.reclaimUntil[1] === null;
  }

  voteRematch(side: Side): boolean {
    if (this.match.phase !== 'game-over') return false;
    this.rematchVotes.add(side);
    if (this.rematchVotes.has(0) && this.rematchVotes.has(1)) {
      this.rematchVotes.clear();
      resetMatch(this.match, (Math.random() * 0xffffffff) >>> 0, 0);
      this.match.phase = 'countdown';
      return true;
    }
    return false;
  }

  setPaused(value: boolean, side: Side): boolean {
    if (this.match.phase === 'game-over' || this.match.phase === 'lobby') return false;
    if (value === this.paused) return false;
    this.paused = value;
    this.inputs[side] = { dir: 0, target: null };
    return true;
  }

  /** Advance at most `elapsed` seconds of simulation in fixed steps. */
  advance(elapsed: number): { events: RoomEvent[]; snapshots: boolean } {
    const events: RoomEvent[] = [];
    if (!this.bothConnected && !this.started) {
      this.lastActivity = this.clock.now();
      return { events, snapshots: false };
    }
    if (this.paused) {
      // Keep the clock honest but freeze the world.
      this.match.elapsed += 0;
      return { events, snapshots: false };
    }
    const steps = Math.min(Math.floor(elapsed / STEP), 6);
    for (let i = 0; i < steps; i++) {
      this.tick++;
      const simEvents = stepMatch(this.match, { inputs: this.inputs, serveGate: true });
      this.inputs[0].serve = false;
      this.inputs[1].serve = false;
      for (const e of simEvents) {
        if (e.kind === 'point') events.push({ kind: 'point', side: e.side, score: e.score });
        else if (e.kind === 'game-over') events.push({ kind: 'game-over', side: e.side });
      }
      if (this.match.phase === 'game-over') break;
    }
    const snapshots = this.tick % SNAPSHOT_EVERY === 0;
    return { events, snapshots };
  }

  start(): void {
    this.started = true;
    this.match.timer = COUNTDOWN_TIME;
    this.match.phase = 'countdown';
  }

  snapshot(at: number): WireSnapshot {
    const m = this.match;
    const phase = this.paused && m.phase === 'rally' ? 'paused' : m.phase;
    return {
      tick: this.tick,
      at,
      phase,
      score: [...m.score] as [number, number],
      server: m.server,
      ball: { ...m.ball },
      paddles: [{ ...m.paddles[0] }, { ...m.paddles[1] }],
      timer: m.timer,
      rallyHits: m.rallyHits,
      suddenDeath: m.suddenDeath,
      matchWinner: m.matchWinner,
      pointWinner: m.pointWinner,
      connected: [this.connected[0], this.connected[1]]
    };
  }

  sweepServers(_now: number): void {
    void _now;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/** Token-bucket rate limiter: `capacity` messages, refilled at `perSecond`. */
export class RateLimiter {
  private tokens: number;
  private last: number | null = null;
  constructor(
    private readonly capacity: number,
    private readonly perSecond: number
  ) {
    this.tokens = capacity;
  }

  take(now: number): RateLimitResult {
    if (this.last === null) this.last = now;
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.perSecond);
    if (this.tokens < 1) {
      const needed = 1 - this.tokens;
      return { allowed: false, retryAfterMs: Math.ceil((needed / this.perSecond) * 1000) };
    }
    this.tokens -= 1;
    return { allowed: true, retryAfterMs: 0 };
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  constructor(
    private readonly maxRooms: number,
    private readonly clock: RoomClock,
    private readonly idleMs = 180_000
  ) {}

  create(seed: number): Room | null {
    if (this.rooms.size >= this.maxRooms) return null;
    for (let i = 0; i < 64; i++) {
      const code = Room.generateCode();
      if (!this.rooms.has(code)) {
        const room = new Room(code, this.clock, seed);
        this.rooms.set(code, room);
        return room;
      }
    }
    return null;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  /** Expire idle/empty rooms; returns codes removed. */
  sweep(): string[] {
    const now = this.clock.now();
    const removed: string[] = [];
    for (const [code, room] of this.rooms) {
      for (const side of room.expireSeats()) {
        void side;
      }
      const idle = now - room.lastActivity > this.idleMs;
      const abandoned = room.empty && room.bothReadyToReclaim();
      if (abandoned || idle) {
        this.rooms.delete(code);
        removed.push(code);
      }
    }
    return removed;
  }

  get size(): number {
    return this.rooms.size;
  }

  list(): Room[] {
    return Array.from(this.rooms.values());
  }
}
