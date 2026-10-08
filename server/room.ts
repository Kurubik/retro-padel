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

export interface SeatClaim {
  side: Side;
  token: string;
  /** True when this claim restored both seats and lifted an automatic pause. */
  resumed: boolean;
}

/**
 * Upper bound on simulation steps consumed by a single advance call. A stalled or
 * bursty event loop must not be able to fast-forward a live rally.
 */
const MAX_STEPS_PER_CALL = 6;

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
  /**
   * True while the freeze was not requested by a player (a seat dropped, or a client
   * reported its tab went away). Only this kind of pause lifts itself.
   */
  pausedAutomatically = false;
  tick = 0;
  lastActivity: number;
  started = false;
  /** Retained sub-step remainder so 16 ms callbacks still tick at 60 Hz. */
  private accumulator = 0;
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
  claimSeat(token: string | null): SeatClaim | null {
    const now = this.clock.now();
    if (token !== null) {
      for (const side of [0, 1] as const) {
        if (!this.connected[side] && this.tokens[side] === token) {
          this.connected[side] = true;
          this.reclaimUntil[side] = null;
          this.lastActivity = now;
          return { side, token, resumed: this.liftAutomaticPause() };
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
        return { side, token: fresh, resumed: this.liftAutomaticPause() };
      }
    }
    return null;
  }

  /**
   * A dropped seat freezes the rally so nobody loses a point to the network. Once
   * both players are back the freeze has to lift on its own; a pause a player asked
   * for deliberately must survive a reconnect.
   */
  private liftAutomaticPause(): boolean {
    if (!this.pausedAutomatically || !this.bothConnected) return false;
    this.paused = false;
    this.pausedAutomatically = false;
    return true;
  }

  disconnect(side: Side): void {
    this.connected[side] = false;
    this.reclaimUntil[side] = this.clock.now() + RECONNECT_GRACE_MS;
    this.inputs[side] = { dir: 0, target: null };
    // Only an *unrequested* freeze is marked automatic; a match a player already
    // paused by hand must not become auto-resumable because someone dropped.
    if (this.match.phase === 'rally' && !this.paused) {
      this.paused = true;
      this.pausedAutomatically = true;
    }
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

  /** Pause or resume. `automatic` marks a freeze nobody asked for, which self-lifts. */
  setPaused(value: boolean, side: Side, automatic = false): boolean {
    if (this.match.phase === 'game-over' || this.match.phase === 'lobby') return false;
    // An explicit request outranks an automatic freeze, so a player who pauses (or
    // resumes) by hand is never overruled by a later reconnect.
    if (value === this.paused && !this.pausedAutomatically) return false;
    this.paused = value;
    this.pausedAutomatically = value && automatic;
    this.inputs[side] = { dir: 0, target: null };
    return true;
  }

  /**
   * Advance the world in fixed STEP slices, retaining the sub-step remainder.
   * Interval callbacks arrive at whatever cadence the event loop manages (16 ms is
   * typical), so discarding the fraction would silently lose whole seconds of play.
   */
  advance(elapsed: number): { events: RoomEvent[]; snapshots: boolean } {
    const events: RoomEvent[] = [];
    if (!this.bothConnected && !this.started) {
      this.lastActivity = this.clock.now();
      this.accumulator = 0;
      return { events, snapshots: false };
    }
    if (this.paused) {
      // Frozen: discard elapsed time rather than bank it for a catch-up burst.
      this.accumulator = 0;
      return { events, snapshots: false };
    }
    if (Number.isFinite(elapsed) && elapsed > 0) this.accumulator += elapsed;
    const maxBanked = STEP * MAX_STEPS_PER_CALL;
    if (this.accumulator > maxBanked) this.accumulator = maxBanked;

    const before = this.tick;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS_PER_CALL) {
      this.accumulator -= STEP;
      steps++;
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
    // Snapshots ride the target cadence: emit once per boundary actually crossed,
    // and never on a call that stepped nothing (a repeated tick would re-fire).
    const snapshots =
      steps > 0 && Math.floor(this.tick / SNAPSHOT_EVERY) > Math.floor(before / SNAPSHOT_EVERY);
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
      room.expireSeats();
      // A room with both players present is a live match, not an idle one: no
      // wall-clock silence may delete it out from under them. Abandoned lobbies and
      // rooms holding a disconnected seat still expire on the idle bound.
      if (room.bothConnected) continue;
      const abandoned = room.empty && room.bothReadyToReclaim();
      const idle = now - room.lastActivity > this.idleMs;
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
