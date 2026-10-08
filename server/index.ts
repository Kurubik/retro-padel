import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  versionMatches,
  type ServerMessage,
  type ClientMessage
} from '../shared/protocol.js';
import { RateLimiter, Room, RoomManager } from './room.js';
import type { Side } from '../shared/core/types.js';
import { randomSeed } from '../shared/core/rng.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? resolve(HERE, '..', 'dist');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 200);
const TICK_MS = 1000 / 60;

const clock = { now: () => Date.now() };
const manager = new RoomManager(MAX_ROOMS, clock);

interface Conn {
  room: string | null;
  side: Side | null;
  token: string | null;
  limiter: RateLimiter;
  alive: boolean;
  lastSeq: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.includes('\0')) {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname === '/healthz') {
    const body = JSON.stringify({ ok: true, rooms: manager.size, uptime: Math.round(process.uptime()), v: PROTOCOL_VERSION });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(safe) === '') {
      file = join(STATIC_DIR, 'index.html');
    }
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const ext = extname(file);
  const immutable = pathname.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS
  });
  createReadStream(file).pipe(res);
}

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const conns = new Map<WebSocket, Conn>();
const roomSockets = new Map<string, [WebSocket | null, WebSocket | null]>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function socketsFor(code: string): [WebSocket | null, WebSocket | null] {
  return roomSockets.get(code) ?? [null, null];
}

function broadcast(code: string, msg: ServerMessage): void {
  const [a, b] = socketsFor(code);
  if (a) send(a, msg);
  if (b) send(b, msg);
}

function roomPayload(room: Room, side: Side, token: string): ServerMessage {
  return {
    t: 'room',
    code: room.code,
    side,
    token,
    phase: room.paused ? 'paused' : room.match.phase === 'game-over' ? 'game-over' : room.bothConnected ? (room.started ? room.match.phase : 'countdown') : 'lobby',
    connected: [room.connected[0], room.connected[1]],
    reclaimExpiresAt: room.reclaimUntil[side === 0 ? 1 : 0]
  };
}

function attach(ws: WebSocket, conn: Conn, room: Room, side: Side, token: string): void {
  const [a, b] = socketsFor(room.code);
  const next: [WebSocket | null, WebSocket | null] = [a, b];
  next[side] = ws;
  roomSockets.set(room.code, next);
  conn.room = room.code;
  conn.side = side;
  conn.token = token;
  if (room.bothConnected && !room.started) room.start();
  send(ws, roomPayload(room, side, token));
}

function detach(ws: WebSocket): void {
  const conn = conns.get(ws);
  if (!conn || !conn.room || conn.side === null) return;
  const code = conn.room;
  const room = manager.get(code);
  const pair = socketsFor(code);
  if (pair[conn.side] === ws) pair[conn.side] = null;
  if (room) {
    room.disconnect(conn.side);
    broadcast(code, { t: 'event', kind: 'disconnect', side: conn.side });
    broadcast(code, { t: 'state', ...room.snapshot(Date.now()) });
  }
  if (!pair[0] && !pair[1]) roomSockets.delete(code);
}

function handle(ws: WebSocket, conn: Conn, msg: ClientMessage): void {
  switch (msg.t) {
    case 'hello': {
      if (!versionMatches(msg.v)) {
        send(ws, { t: 'error', code: 'BAD_VERSION', message: 'Client protocol version mismatch.' });
        ws.close(1002, 'bad version');
        return;
      }
      send(ws, { t: 'welcome', v: PROTOCOL_VERSION, at: Date.now() });
      return;
    }
    case 'create': {
      if (conn.room) return;
      const room = manager.create(randomSeed());
      if (!room) {
        send(ws, { t: 'error', code: 'SERVER_BUSY', message: 'No room slots available.' });
        return;
      }
      const seat = room.claimSeat(null);
      if (!seat) return;
      attach(ws, conn, room, seat.side, seat.token);
      return;
    }
    case 'join':
    case 'reclaim': {
      if (conn.room) return;
      const room = manager.get(msg.code);
      if (!room) {
        send(ws, { t: 'error', code: 'NOT_FOUND', message: 'That room code does not exist.' });
        return;
      }
      const seat = room.claimSeat(msg.t === 'reclaim' ? msg.token : null);
      if (!seat) {
        const code = msg.t === 'reclaim' ? 'BAD_TOKEN' : 'FULL';
        send(ws, {
          t: 'error',
          code,
          message: code === 'FULL' ? 'That room is already full.' : 'Reconnect token was not accepted.'
        });
        return;
      }
      attach(ws, conn, room, seat.side, seat.token);
      broadcast(room.code, { t: 'event', kind: 'connect', side: seat.side });
      broadcast(room.code, { t: 'state', ...room.snapshot(Date.now()) });
      return;
    }
    case 'input': {
      const room = conn.room ? manager.get(conn.room) : undefined;
      if (!room || conn.side === null) return;
      if (msg.seq < conn.lastSeq) return;
      conn.lastSeq = msg.seq;
      room.inputs[conn.side].dir = msg.dir;
      room.inputs[conn.side].target = null;
      if (msg.serve) room.inputs[conn.side].serve = true;
      return;
    }
    case 'pause':
    case 'resume': {
      const room = conn.room ? manager.get(conn.room) : undefined;
      if (!room || conn.side === null) return;
      const want = msg.t === 'pause';
      if (room.setPaused(want, conn.side)) {
        broadcast(room.code, { t: 'event', kind: want ? 'paused' : 'resumed' });
        broadcast(room.code, { t: 'state', ...room.snapshot(Date.now()) });
      }
      return;
    }
    case 'rematch': {
      const room = conn.room ? manager.get(conn.room) : undefined;
      if (!room || conn.side === null) return;
      if (room.voteRematch(conn.side)) {
        broadcast(room.code, { t: 'event', kind: 'rematch' });
        broadcast(room.code, { t: 'state', ...room.snapshot(Date.now()) });
      } else {
        send(ws, { t: 'state', ...room.snapshot(Date.now()) });
      }
      return;
    }
    case 'leave': {
      detach(ws);
      ws.close(1000, 'left');
      return;
    }
    case 'ping': {
      send(ws, { t: 'pong', ts: msg.ts, at: Date.now() });
      return;
    }
  }
}

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn: Conn = {
      room: null,
      side: null,
      token: null,
      limiter: new RateLimiter(90, 45),
      alive: true,
      lastSeq: -1
    };
    conns.set(ws, conn);
    ws.on('message', (data) => {
      const now = Date.now();
      const limit = conn.limiter.take(now);
      if (!limit.allowed) {
        send(ws, { t: 'error', code: 'RATE_LIMITED', message: 'Slow down.' });
        return;
      }
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        send(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Malformed message.' });
        return;
      }
      try {
        handle(ws, conn, msg);
      } catch {
        send(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Message could not be processed.' });
      }
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => {
      detach(ws);
      conns.delete(ws);
    });
    ws.on('error', () => {
      detach(ws);
      conns.delete(ws);
    });
  });
});

let last = Date.now();
const loop = setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;
  for (const room of manager.list()) {
    const { events, snapshots } = room.advance(dt);
    for (const e of events) broadcast(room.code, { t: 'event', kind: e.kind, side: e.side, score: e.score });
    if (snapshots || events.length > 0) {
      broadcast(room.code, { t: 'state', ...room.snapshot(now) });
    }
  }
}, TICK_MS);

const sweep = setInterval(() => {
  const removed = manager.sweep();
  for (const code of removed) {
    const [a, b] = socketsFor(code);
    if (a) send(a, { t: 'event', kind: 'expired' });
    if (b) send(b, { t: 'event', kind: 'expired' });
    roomSockets.delete(code);
  }
  const cutoff = Date.now() - 45_000;
  for (const [ws, conn] of conns) {
    if (!conn.alive) {
      ws.terminate();
      conns.delete(ws);
      continue;
    }
    conn.alive = false;
    if (ws.readyState === 1) ws.ping();
  }
  void cutoff;
}, 10_000);

function shutdown(): void {
  clearInterval(loop);
  clearInterval(sweep);
  for (const ws of conns.keys()) ws.close(1001, 'server shutdown');
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer.listen(PORT, HOST, () => {
  const addr = httpServer.address() as AddressInfo;
  console.log(JSON.stringify({ msg: 'retro-padel server up', host: addr.address, port: addr.port, staticDir: STATIC_DIR, v: PROTOCOL_VERSION }));
});

export { httpServer, manager };
