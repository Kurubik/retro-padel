import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkClient } from '../../client/src/net.js';

afterEach(() => vi.unstubAllGlobals());

describe('online endpoint origin', () => {
  it('ignores a query-supplied WebSocket endpoint so reconnect tokens stay on this origin', () => {
    let requested = '';
    vi.stubGlobal('location', {
      protocol: 'https:',
      host: 'padel.xtr.sh',
      search: '?server=wss%3A%2F%2Fevil.example%2Fsteal'
    });
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;
      constructor(url: string) { requested = url; }
    });
    new LinkClient().connect();
    expect(requested).toBe('wss://padel.xtr.sh/ws');
  });
});
