import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseClientMessage, versionMatches } from '../../shared/protocol.js';

describe('wire protocol', () => {
  it('exposes a version tag', () => {
    expect(PROTOCOL_VERSION).toMatch(/^RP\d+$/);
    expect(versionMatches(PROTOCOL_VERSION)).toBe(true);
    expect(versionMatches('RP0')).toBe(false);
    expect(versionMatches(undefined)).toBe(false);
  });

  it('accepts well-formed frames', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }))).toEqual({
      t: 'hello',
      v: PROTOCOL_VERSION
    });
    expect(parseClientMessage(JSON.stringify({ t: 'join', code: 'abcd' }))).toEqual({ t: 'join', code: 'ABCD' });
    expect(parseClientMessage(JSON.stringify({ t: 'input', seq: 4, dir: 0.5, serve: true }))).toEqual({
      t: 'input',
      seq: 4,
      dir: 0.5,
      serve: true
    });
  });

  it('clamps hostile input values', () => {
    const msg = parseClientMessage(JSON.stringify({ t: 'input', seq: -3, dir: 99, serve: 'yes' }));
    expect(msg).toEqual({ t: 'input', seq: -3, dir: 1, serve: false });
  });

  it('rejects malformed, oversized and unknown frames', () => {
    expect(parseClientMessage('{')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'input', dir: 'fast' }))).toBeNull();
    expect(parseClientMessage('x'.repeat(2000))).toBeNull();
  });

  it('truncates over-long identifiers instead of trusting them', () => {
    const msg = parseClientMessage(JSON.stringify({ t: 'join', code: 'a'.repeat(60) }));
    expect(msg).toEqual({ t: 'join', code: 'A'.repeat(12) });
  });

  it('drops frames larger than the transport budget', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'join', code: 'a'.repeat(600) }))).toBeNull();
  });
});
