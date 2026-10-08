import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'dist-server', 'index.js');
const STATIC_DIR = join(ROOT, 'dist');

/** Newest mtime under a directory, for .ts sources only. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(path));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/** The regression is about the real bundle, so make sure we spawn a current one. */
function ensureServerBundle(): void {
  const sources = Math.max(newestSourceMtime(join(ROOT, 'server')), newestSourceMtime(join(ROOT, 'shared')));
  const built = existsSync(ENTRY) ? statSync(ENTRY).mtimeMs : 0;
  if (built < sources) {
    execFileSync('npm', ['run', 'build:server'], { cwd: ROOT, stdio: 'pipe' });
  }
}

let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
let port = 0;
let serverLog = '';

async function get(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'GET', path: rawPath, headers: { connection: 'close' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolveResult({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', rejectResult);
    req.end();
  });
}

/** Send bytes straight down a socket, for request targets the http client refuses. */
async function rawSocket(payload: string): Promise<string> {
  return new Promise((resolveResult, rejectResult) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(payload));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (received += chunk));
    socket.on('close', () => resolveResult(received));
    socket.on('error', rejectResult);
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolveResult(received);
    });
  });
}

beforeAll(async () => {
  ensureServerBundle();
  child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STATIC_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  port = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error('server did not report a port')), 20_000);
    const onData = (chunk: Buffer): void => {
      const text = String(chunk);
      serverLog += text;
      const match = serverLog.match(/\{"msg":"retro-padel server up"[^}]*"port":(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    };
    child?.stdout.on('data', onData);
    child?.stderr.on('data', onData);
    child?.on('exit', (code) => {
      clearTimeout(timer);
      rejectPort(new Error('server exited early with code ' + String(code) + ': ' + serverLog));
    });
  });
}, 180_000);

afterAll(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
});

describe('public HTTP surface', () => {
  it('serves health, the shell and client assets', async () => {
    const health = await get('/healthz');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, v: 'RP1' });

    const shell = await get('/');
    expect(shell.status).toBe(200);
    expect(shell.body.toLowerCase()).toContain('<!doctype html');
  });

  it('answers a malformed percent escape with 400 and keeps serving', async () => {
    const before = await get('/healthz');
    expect(before.status).toBe(200);

    const bad = await get('/%ZZ');
    expect(bad.status).toBe(400);
    expect(bad.body.length).toBeGreaterThan(0);

    expect(child?.exitCode).toBeNull();
    const after = await get('/healthz');
    expect(after.status).toBe(200);
  }, 20_000);

  it.each([['/%ZZ'], ['/%'], ['/%E0%A4%A'], ['/%00'], ['/%c0%af']])(
    'rejects the malformed percent escape %s with 400',
    async (rawPath) => {
      const res = await get(rawPath);
      expect(res.status).toBe(400);
      expect(res.body.length).toBeGreaterThan(0);

      expect(child?.exitCode).toBeNull();
      expect((await get('/healthz')).status).toBe(200);
    },
    20_000
  );

  it('never serves a byte from outside the static root', async () => {
    const attempts = [
      '/../server/index.ts',
      '/..%2fserver%2findex.ts',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd'
    ];
    for (const rawPath of attempts) {
      const res = await get(rawPath);
      expect(res.status).toBeLessThan(500);
      expect(res.body).not.toContain('root:');
      expect(res.body).not.toContain('createServer');
      // Anything that does resolve is the SPA shell, never a source-tree file.
      if (res.status === 200) expect(res.body.toLowerCase()).toContain('<!doctype html>');
    }
    expect(child?.exitCode).toBeNull();
    expect((await get('/healthz')).status).toBe(200);
  }, 20_000);

  it('answers an absurdly long path without dying', async () => {
    const res = await get('/' + 'a'.repeat(4000));
    expect(res.status).toBeLessThan(500);
    expect(child?.exitCode).toBeNull();
    expect((await get('/healthz')).status).toBe(200);
  }, 20_000);

  it('keeps traversal and missing files off the source tree', async () => {
    for (const rawPath of ['/../server/index.ts', '/..%2fserver%2findex.ts', '/does-not-exist.js']) {
      const res = await get(rawPath);
      expect(res.status).not.toBe(200);
    }
    const health = await get('/healthz');
    expect(health.status).toBe(200);
  }, 20_000);

  it('serves the SPA shell for extensionless routes and 404 for missing assets', async () => {
    const route = await get('/some/deep/route');
    expect(route.status).toBe(200);
    expect(route.body.toLowerCase()).toContain('<!doctype html');

    const missing = await get('/definitely-missing.js');
    expect(missing.status).toBe(404);
  });

  it('does not die on a malformed WebSocket upgrade target', async () => {
    // Absolute-form target with an unterminated IPv6 literal: URL parsing throws, and
    // that throw used to be an uncaught exception in the upgrade handler.
    await rawSocket(
      'GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
    await rawSocket('GET /%ZZ HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
    await rawSocket('NOT-EVEN-HTTP\r\n\r\n');

    await new Promise((r) => setTimeout(r, 200));
    expect(child?.exitCode).toBeNull();
    const after = await get('/healthz');
    expect(after.status).toBe(200);
  }, 20_000);
});
