import { describe, expect, it } from 'vitest';
import { Room, RoomManager } from '../../server/room.js';
import { RECONNECT_GRACE_MS, STEP } from '../../shared/core/constants.js';

function pairedRoom(code: string, seed = 1): Room {
  const room = new Room(code, { now: () => 0 }, seed);
  room.claimSeat(null);
  room.claimSeat(null);
  room.start();
  return room;
}

describe('independent online lifecycle review', () => {
  it('accumulates sub-step server intervals instead of dropping a second of play', () => {
    const room = new Room('REVIEW', { now: () => 0 }, 1);
    room.claimSeat(null);
    room.claimSeat(null);
    room.start();
    for (let i = 0; i < 60; i++) room.advance(0.016);
    expect(room.tick).toBeGreaterThanOrEqual(50);
    expect(room.match.timer).toBeLessThan(2.2);
  });

  it('does not expire a room while both players remain connected', () => {
    let now = 0;
    const manager = new RoomManager(5, { now: () => now }, 1000);
    const room = manager.create(2)!;
    room.claimSeat(null);
    room.claimSeat(null);
    room.start();
    now = 2000;
    expect(manager.sweep()).not.toContain(room.code);
    expect(manager.get(room.code)).toBe(room);
  });

  it('resumes an auto-paused rally when the missing seat reclaims', () => {
    const room = new Room('REJOIN', { now: () => 0 }, 3);
    room.claimSeat(null);
    const guest = room.claimSeat(null)!;
    room.start();
    room.match.phase = 'rally';
    room.disconnect(guest.side);
    expect(room.paused).toBe(true);
    expect(room.claimSeat(guest.token)?.side).toBe(guest.side);
    expect(room.bothConnected).toBe(true);
    expect(room.paused).toBe(false);
  });

  // ---- added while fixing the above -------------------------------------------

  it('retains the remainder across single-step intervals and never bursts', () => {
    const room = pairedRoom('REMAIN', 11);
    for (let i = 0; i < 600; i++) room.advance(STEP * 0.9);
    // 540 steps of input: the retired fraction must not vanish, and the clamp must
    // stop a single call from fast-forwarding the rally.
    expect(room.tick).toBeGreaterThanOrEqual(530);
    expect(room.tick).toBeLessThanOrEqual(545);

    const before = room.tick;
    room.advance(10);
    expect(room.tick - before).toBeLessThanOrEqual(6);
  });

  it('drops banked time while frozen and while both seats are away', () => {
    const room = pairedRoom('FROZEN', 12);
    room.match.phase = 'rally';
    for (let i = 0; i < 30; i++) room.advance(0.016);
    const warmed = room.tick;
    expect(warmed).toBeGreaterThan(0);

    room.setPaused(true, 0);
    for (let i = 0; i < 120; i++) room.advance(0.016);
    expect(room.tick).toBe(warmed);

    room.setPaused(false, 0);
    room.advance(0.016);
    expect(room.tick - warmed).toBeLessThanOrEqual(1);
  });

  it('keeps a deliberate pause across a reconnect', () => {
    const room = pairedRoom('MANUAL', 13);
    room.match.phase = 'rally';
    const guest = { side: 1 as const, token: room.tokens[1]! };
    // A player pauses on purpose, then the *other* seat drops.
    room.setPaused(true, 0);
    room.disconnect(guest.side);
    expect(room.paused).toBe(true);
    const claim = room.claimSeat(guest.token)!;
    expect(claim.resumed).toBe(false);
    expect(room.paused).toBe(true);
    expect(room.snapshot(0).phase).toBe('paused');
  });

  it('reports the resumed rally on the snapshot both clients read', () => {
    const room = pairedRoom('SIGNAL', 14);
    room.match.phase = 'rally';
    const guest = room.claimSeat(null);
    expect(guest).toBeNull(); // already paired
    const side = 1 as const;
    room.disconnect(side);
    expect(room.snapshot(0).phase).toBe('paused');
    const claim = room.claimSeat(room.tokens[side]!)!;
    expect(claim.resumed).toBe(true);
    expect(room.paused).toBe(false);
    expect(room.snapshot(0).phase).toBe('rally');
  });

  it('lifts a tab-away pause when the seat drops and comes back', () => {
    const room = pairedRoom('TABGONE', 17);
    room.match.phase = 'rally';
    // The client reports its tab went away: a freeze the player did not ask for.
    expect(room.setPaused(true, 1, true)).toBe(true);
    expect(room.paused).toBe(true);
    room.disconnect(1);
    expect(room.paused).toBe(true);
    const claim = room.claimSeat(room.tokens[1]!)!;
    expect(claim.resumed).toBe(true);
    expect(room.paused).toBe(false);
    expect(room.snapshot(0).phase).toBe('rally');
  });

  it('lets a deliberate pause outrank an automatic one', () => {
    const room = pairedRoom('OUTRANK', 18);
    room.match.phase = 'rally';
    room.setPaused(true, 0, true);
    // A player then pauses on purpose; the freeze is now theirs to lift.
    expect(room.setPaused(true, 0, false)).toBe(true);
    room.disconnect(1);
    const claim = room.claimSeat(room.tokens[1]!)!;
    expect(claim.resumed).toBe(false);
    expect(room.paused).toBe(true);
  });

  it('still expires an idle lobby whose seats are not both present', () => {
    let now = 0;
    const manager = new RoomManager(5, { now: () => now }, 1000);
    const room = manager.create(15)!;
    room.claimSeat(null);
    now = 5000;
    expect(manager.sweep()).toContain(room.code);
    expect(manager.get(room.code)).toBeUndefined();
  });

  it('expires an abandoned room once every reclaim window has lapsed', () => {
    let now = 0;
    const manager = new RoomManager(5, { now: () => now }, 180_000);
    const room = manager.create(16)!;
    room.claimSeat(null);
    room.claimSeat(null);
    room.start();
    room.disconnect(0);
    room.disconnect(1);
    expect(manager.sweep()).not.toContain(room.code);
    now = RECONNECT_GRACE_MS + 1;
    expect(manager.sweep()).toContain(room.code);
  });
});
