import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LEN } from '../../shared/core/constants.js';
import { RateLimiter, Room, RoomManager } from '../../server/room.js';

function fakeRand(bytes: number[]): (n: number) => Buffer {
  return (n: number) => Buffer.from(bytes.slice(0, n));
}

describe('room codes', () => {
  it('are six characters from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = Room.generateCode();
      expect(code).toHaveLength(ROOM_CODE_LEN);
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    for (const bad of ['O', 'I', 'L', '0', '1', 'B', 'S', 'Z', '8', '5', '2']) {
      expect(ROOM_CODE_ALPHABET.includes(bad)).toBe(false);
    }
  });

  it('maps deterministic bytes to deterministic codes', () => {
    expect(Room.generateCode(fakeRand([0, 1, 2, 3, 4, 5]))).toBe(
      'A' + ROOM_CODE_ALPHABET[1] + ROOM_CODE_ALPHABET[2] + ROOM_CODE_ALPHABET[3] + ROOM_CODE_ALPHABET[4] + ROOM_CODE_ALPHABET[5]
    );
  });

  it('generates a cryptographic-length reconnect token', () => {
    const token = Room.newToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(Room.newToken()).not.toBe(token);
  });
});

describe('seat claims and reconnect', () => {
  it('gives two distinct seats and rejects a third', () => {
    const room = new Room('AAAAAA', { now: () => 0 }, 1);
    const first = room.claimSeat(null);
    const second = room.claimSeat(null);
    const third = room.claimSeat(null);
    expect(first?.side).toBe(0);
    expect(second?.side).toBe(1);
    expect(third).toBeNull();
    expect(room.bothConnected).toBe(true);
  });

  it('lets a dropped seat reclaim with its token inside the grace window', () => {
    let now = 1000;
    const room = new Room('BBBBBB', { now: () => now }, 1);
    const seat = room.claimSeat(null);
    expect(seat).not.toBeNull();
    const token = seat!.token;
    room.disconnect(seat!.side);
    expect(room.connected[0]).toBe(false);
    now += 30_000;
    const reclaimed = room.claimSeat(token);
    expect(reclaimed?.side).toBe(0);
    expect(room.connected[0]).toBe(true);
  });

  it('rejects a wrong token and releases the seat after the grace window', () => {
    let now = 0;
    const room = new Room('CCCCCC', { now: () => now }, 1);
    const seat = room.claimSeat(null)!;
    room.disconnect(seat.side);
    expect(room.claimSeat('deadbeef')).toBeNull();
    now += 61_000;
    const released = room.expireSeats();
    expect(released).toContain(0);
    expect(room.tokens[0]).toBeNull();
    const fresh = room.claimSeat(null);
    expect(fresh?.side).toBe(0);
    expect(fresh?.token).not.toBe(seat.token);
  });

  it('pauses a live rally when a player drops', () => {
    let now = 0;
    const room = new Room('DDDDDD', { now: () => now }, 2);
    room.claimSeat(null);
    room.claimSeat(null);
    room.start();
    let guard = 0;
    while (room.match.phase !== 'rally' && guard++ < 600) {
      // Online rooms hold at a zero countdown until the server side requests the serve.
      room.inputs[room.match.server].serve = true;
      room.advance(1 / 60);
    }
    expect(room.match.phase).toBe('rally');
    room.disconnect(1);
    expect(room.paused).toBe(true);
    const before = JSON.stringify(room.match.ball);
    room.advance(1);
    expect(JSON.stringify(room.match.ball)).toBe(before);
  });
});

describe('rematch', () => {
  it('requires both players and then resets the match', () => {
    const room = new Room('EEEEEE', { now: () => 0 }, 3);
    room.claimSeat(null);
    room.claimSeat(null);
    room.match.phase = 'game-over';
    room.match.score = [7, 3];
    expect(room.voteRematch(0)).toBe(false);
    expect(room.match.phase).toBe('game-over');
    expect(room.voteRematch(1)).toBe(true);
    expect(room.match.score).toEqual([0, 0]);
  });
});

describe('rate limiting', () => {
  it('allows a burst then blocks until refilled', () => {
    const limiter = new RateLimiter(10, 10);
    let now = 0;
    for (let i = 0; i < 10; i++) {
      expect(limiter.take(now).allowed).toBe(true);
    }
    const blocked = limiter.take(now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    now += 1000;
    expect(limiter.take(now).allowed).toBe(true);
  });
});

describe('room manager bounds', () => {
  it('refuses to create rooms past the cap', () => {
    const manager = new RoomManager(3, { now: () => 0 });
    expect(manager.create(1)).not.toBeNull();
    expect(manager.create(2)).not.toBeNull();
    expect(manager.create(3)).not.toBeNull();
    expect(manager.create(4)).toBeNull();
    expect(manager.size).toBe(3);
  });

  it('sweeps idle rooms', () => {
    let now = 0;
    const manager = new RoomManager(5, { now: () => now }, 1000);
    const room = manager.create(1)!;
    now += 2000;
    expect(manager.sweep()).toContain(room.code);
    expect(manager.size).toBe(0);
  });
});
