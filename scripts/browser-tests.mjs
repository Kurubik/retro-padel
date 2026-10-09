#!/usr/bin/env node
/**
 * RETRO//PADEL — real-browser acceptance run.
 *
 * Boots the production server bundle and drives it with headless Chrome:
 *   · four documented viewports and visual screenshots
 *   · a real solo rally driven by keyboard input until a point is scored
 *   · independent two-sided local controls
 *   · two separate browser clients joined to one LINK room over a real WebSocket,
 *     playing until a point is scored, then a refresh/reclaim check
 *   · touch drag on a phone viewport
 *   · settings, pause and console-error checks
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, 'artifacts/screenshots');
const PORT = Number(process.env.RP_TEST_PORT ?? 8123);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';

const results = [];
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const flag = ok ? 'PASS' : 'FAIL';
  console.log(`${flag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('server did not become healthy');
}

function attachConsole(page, bucket) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bucket.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => bucket.push(`pageerror: ${err.message}`));
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(shots, `${name}.png`) });
}

async function newPage(browser, bucket, viewport) {
  const page = await browser.newPage();
  attachConsole(page, bucket);
  if (viewport) await page.setViewport(viewport);
  return page;
}

async function bootApp(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__RP), { timeout: 15000 });
  // The power-on overlay starts fading at 880 ms and takes 420 ms. Wait for it to be
  // genuinely hidden instead of guessing a duration, so every capture is a stable
  // frame rather than a transitional one.
  await page.waitForFunction(
    () => {
      const boot = document.getElementById('boot');
      if (!boot) return true;
      const style = getComputedStyle(boot);
      return style.visibility === 'hidden' && Number(style.opacity) === 0;
    },
    { timeout: 15000 }
  );
}

const mobile = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });

  const server = spawn(process.execPath, [resolve(root, 'dist-server/index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', STATIC_DIR: resolve(root, 'dist') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));

  let browser;
  try {
    const health = await waitForServer();
    record('server /healthz responds', Boolean(health.ok), JSON.stringify(health));

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--font-render-hinting=none']
    });

    // ---------------------------------------------------------------- desktop
    // deviceScaleFactor 2 for every capture: it matches real high-density displays and
    // avoids a headless full-page compositing artifact seen only at scale factor 1.
    const desktopErrors = [];
    const page = await newPage(browser, desktopErrors, { width: 1440, height: 900, deviceScaleFactor: 2 });
    await bootApp(page);

    const attractText = await page.evaluate(() => document.getElementById('ui')?.textContent ?? '');
    record('attract shows PRESS START', /PRESS START/.test(attractText));
    await shot(page, '1440x900-attract');

    await page.keyboard.press('Enter');
    await sleep(350);
    const modeText = await page.evaluate(() => document.getElementById('ui')?.textContent ?? '');
    record(
      'mode select lists all three modes plus help and settings',
      /SOLO \/ CPU/.test(modeText) && /LOCAL \/ 2P/.test(modeText) && /LINK \/ FRIEND/.test(modeText) && /HOW TO PLAY/.test(modeText) && /SETTINGS/.test(modeText)
    );
    await shot(page, '1440x900-modes');

    // settings screen
    await page.keyboard.press('ArrowDown');
    await sleep(120);
    const settingsText = await page.evaluate(() => {
      window.__RP.openSettings();
      return document.getElementById('ui')?.textContent ?? '';
    });
    await sleep(200);
    record('settings exposes theme, sound, motion and contrast', /THEME/.test(settingsText) && /SOUND/.test(settingsText) && /MOTION/.test(settingsText) && /CONTRAST/.test(settingsText));
    await shot(page, '1440x900-settings');
    await page.click('[data-id="theme"]');
    const blackwall = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      value: document.querySelector('[data-id="theme"] .row__value')?.textContent,
      stored: JSON.parse(localStorage.getItem('rp.settings.v1') ?? '{}').theme
    }));
    record('BLACKWALL toggles and persists', blackwall.theme === 'blackwall' && blackwall.value === 'BLACKWALL' && blackwall.stored === 'blackwall');
    await shot(page, '1440x900-blackwall-settings');
    await page.evaluate(() => window.__RP.setScreen('attract'));
    await sleep(150);
    await shot(page, '1440x900-blackwall-attract');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootApp(page);
    record('BLACKWALL survives reload', await page.evaluate(() => document.documentElement.dataset.theme === 'blackwall'));
    await page.evaluate(() => window.__RP.startSolo('rookie'));
    await sleep(200);
    await shot(page, '1440x900-blackwall-rally');
    await page.evaluate(() => window.__RP.openSettings());
    await page.click('[data-id="theme"]');
    record('SIGNAL/09 can be restored', await page.evaluate(() => document.documentElement.dataset.theme === 'signal'));
    await page.evaluate(() => window.__RP.setScreen('attract'));

    // ---- real solo rally driven by keyboard -----------------------------
    await page.evaluate(() => window.__RP.startSolo('rookie'));
    await sleep(200);
    const solo = await driveSoloToPoint(page, 45000);
    record('solo: real keyboard rally scores a point', solo.ok, solo.detail);
    const soloShots = await page.evaluate(() => window.__RP.screenName());
    record('solo: match screen active', soloShots === 'playing' || soloShots === 'over', soloShots);
    const soloLabels = await page.evaluate(() => window.__RP.scoreLabels());
    record('solo: score labels read YOU / CPU', JSON.stringify(soloLabels) === JSON.stringify(['YOU', 'CPU']), JSON.stringify(soloLabels));
    await shot(page, '1440x900-solo-rally');

    // ---- finished winner state -------------------------------------------
    await page.evaluate(() => window.__RP.startSolo('pro'));
    await sleep(200);
    await page.evaluate(() => {
      const m = window.__RP.match();
      m.score = [6, 3];
      m.phase = 'rally';
      m.ball.x = 99999;
      m.ball.y = 560;
      m.ball.vx = 0;
      m.ball.vy = 0;
    });
    await sleep(2400);
    const overText = await page.evaluate(() => document.getElementById('ui')?.textContent ?? '');
    record('game over shows a winner and a rematch control', /YOU WIN/.test(overText) && /REMATCH/.test(overText));
    await shot(page, '1440x900-winner');

    // pause overlay
    await page.evaluate(() => window.__RP.startSolo('pro'));
    await sleep(2000);
    await page.keyboard.press('Escape');
    await sleep(250);
    const pausedText = await page.evaluate(() => document.getElementById('ui')?.textContent ?? '');
    record('pause overlay offers resume / settings / quit', /RESUME/.test(pausedText) && /QUIT TO MENU/.test(pausedText));
    await shot(page, '1440x900-paused');
    await page.keyboard.press('Escape');
    await sleep(200);

    // ---- local 2P independent controls ----------------------------------
    await page.evaluate(() => window.__RP.startLocal());
    await sleep(2400);
    const before = await page.evaluate(() => {
      const m = window.__RP.match();
      return { p0: m.paddles[0].y, p1: m.paddles[1].y };
    });
    await page.keyboard.down('w');
    await page.keyboard.down('ArrowDown');
    await sleep(700);
    const during = await page.evaluate(() => {
      const m = window.__RP.match();
      return { p0: m.paddles[0].y, p1: m.paddles[1].y };
    });
    await page.keyboard.up('w');
    await page.keyboard.up('ArrowDown');
    const p0Moved = Math.abs(during.p0 - before.p0) > 40;
    const p1Moved = Math.abs(during.p1 - before.p1) > 40;
    const opposite = Math.sign(during.p0 - before.p0) !== Math.sign(during.p1 - before.p1);
    record('local 2P: both paddles move independently', p0Moved && p1Moved && opposite, JSON.stringify({ before, during }));
    const localLabels = await page.evaluate(() => window.__RP.scoreLabels());
    record('local 2P: score labels read P1 / P2', JSON.stringify(localLabels) === JSON.stringify(['P1', 'P2']), JSON.stringify(localLabels));
    await shot(page, '1440x900-local-rally');

    await page.evaluate(() => window.__RP.setScreen('attract'));
    await sleep(150);
    record('desktop console stays clean', desktopErrors.length === 0, desktopErrors.slice(0, 3).join(' | '));
    await page.close();

    // ---------------------------------------------------------------- phone
    const phoneErrors = [];
    const phone = await newPage(browser, phoneErrors, mobile);
    await bootApp(phone);
    await shot(phone, '390x844-attract');
    await phone.tap('#btn-start');
    await sleep(350);
    await shot(phone, '390x844-modes');

    await phone.evaluate(() => window.__RP.startSolo('pro'));
    await sleep(2600);

    // touch drag steers the paddle
    const canvasBox = await phone.evaluate(() => {
      const r = document.getElementById('screen-canvas').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const beforeTouch = await phone.evaluate(() => window.__RP.match().paddles[0].y);
    await phone.touchscreen.touchStart(canvasBox.x + canvasBox.w * 0.25, canvasBox.y + canvasBox.h * 0.25);
    await phone.touchscreen.touchMove(canvasBox.x + canvasBox.w * 0.25, canvasBox.y + canvasBox.h * 0.6);
    await sleep(450);
    const afterTouch = await phone.evaluate(() => window.__RP.match().paddles[0].y);
    await phone.touchscreen.touchEnd();
    record('phone: touch drag steers the paddle', Math.abs(afterTouch - beforeTouch) > 40, `${beforeTouch.toFixed(0)} -> ${afterTouch.toFixed(0)}`);
    await shot(phone, '390x844-solo-rally');

    await phone.evaluate(() => window.__RP.openHowTo());
    await sleep(250);
    const howTo = await phone.evaluate(() => document.getElementById('ui')?.textContent ?? '');
    record('how-to overlay documents movement and serve', /MOVE/.test(howTo) && /SERVE/.test(howTo));
    await shot(phone, '390x844-howto');

    await phone.evaluate(() => window.__RP.openSettings());
    await sleep(250);
    const phoneSettings = await phone.evaluate(() => document.getElementById('ui')?.textContent ?? '');
    record('phone settings renders all options', /THEME/.test(phoneSettings) && /SOUND/.test(phoneSettings) && /CONTRAST/.test(phoneSettings));
    await shot(phone, '390x844-settings');

    await phone.tap('[data-id="theme"]');
    record('phone: touch switches to BLACKWALL', await phone.evaluate(() => document.documentElement.dataset.theme === 'blackwall'));
    await shot(phone, '390x844-blackwall-settings');
    await phone.evaluate(() => window.__RP.setScreen('attract'));
    await sleep(120);
    await shot(phone, '390x844-blackwall-attract');
    await phone.evaluate(() => window.__RP.openSettings());
    await phone.tap('[data-id="theme"]');

    await phone.evaluate(() => window.__RP.setScreen('attract'));
    await sleep(120);
    record('phone console stays clean', phoneErrors.length === 0, phoneErrors.slice(0, 3).join(' | '));
    await phone.close();

    // ---------------------------------------------------------------- 320x640
    const smallErrors = [];
    const small = await newPage(browser, smallErrors, { width: 320, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await bootApp(small);
    const overflow = await small.evaluate(() => {
      const el = document.querySelector('.console');
      const rect = el.getBoundingClientRect();
      const controls = document.querySelectorAll('.dpad__key, .face__btn, .mid__btn');
      let minTarget = Infinity;
      for (const node of controls) {
        const r = node.getBoundingClientRect();
        minTarget = Math.min(minTarget, Math.min(r.width, r.height));
      }
      return { width: rect.width, height: rect.height, minTarget, docWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
    });
    record('320x640: console fits width without horizontal overflow', overflow.docWidth <= overflow.viewport + 1, JSON.stringify(overflow));
    record('320x640: touch targets are at least 44 CSS px', overflow.minTarget >= 44, `min=${overflow.minTarget.toFixed(1)}`);
    const noteCheck = await small.evaluate(() => {
      const note = document.querySelector('.stage__note');
      const shell = document.querySelector('.console');
      if (!note || !shell) return { present: Boolean(note), overlaps: false, hidden: true };
      const style = getComputedStyle(note);
      const hidden = style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
      if (hidden) return { present: true, hidden: true, overlaps: false };
      const n = note.getBoundingClientRect();
      const c = shell.getBoundingClientRect();
      const overlaps = !(n.bottom <= c.top || n.top >= c.bottom || n.right <= c.left || n.left >= c.right);
      return {
        present: true,
        hidden: false,
        overlaps,
        note: { top: Math.round(n.top), bottom: Math.round(n.bottom) },
        shell: { top: Math.round(c.top), bottom: Math.round(c.bottom) }
      };
    });
    record(
      '320x640: external hint row does not overlap the console',
      noteCheck.hidden === true || noteCheck.overlaps === false,
      JSON.stringify(noteCheck)
    );
    await shot(small, '320x640-attract');
    await small.evaluate(() => window.__RP.openModes());
    await sleep(260);
    await shot(small, '320x640-modes');
    await small.evaluate(() => window.__RP.startSolo('pro'));
    await sleep(2600);
    await shot(small, '320x640-solo-rally');
    record('320x640 console stays clean', smallErrors.length === 0, smallErrors.slice(0, 3).join(' | '));
    await small.close();

    // ---------------------------------------------------------------- landscape
    const landErrors = [];
    const land = await newPage(browser, landErrors, { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await bootApp(land);
    await land.evaluate(() => window.__RP.startSolo('pro'));
    await sleep(2600);
    const landLayout = await land.evaluate(() => {
      const screen = document.querySelector('.screen').getBoundingClientRect();
      const dpad = document.querySelector('.dpad').getBoundingClientRect();
      return { screenH: screen.height, dpadBottom: dpad.bottom, viewportH: window.innerHeight, scrollH: document.documentElement.scrollHeight };
    });
    record(
      'landscape: screen and controls remain visible without clipping',
      landLayout.screenH > 120 && landLayout.dpadBottom <= landLayout.viewportH + 2 && landLayout.scrollH <= landLayout.viewportH + 4,
      JSON.stringify(landLayout)
    );
    await shot(land, '844x390-solo-rally');
    record('landscape console stays clean', landErrors.length === 0, landErrors.slice(0, 3).join(' | '));
    await land.close();

    // ------------------------------------------------- crafted invite link
    // A query-supplied endpoint must not be able to aim the socket, and the stored
    // reconnect token that travels with it, at a host the player never chose.
    const originErrors = [];
    const hostile = await newPage(browser, originErrors, { width: 1200, height: 800, deviceScaleFactor: 1 });
    await hostile.goto(`${BASE}/?server=wss%3A%2F%2Fevil.example%2Fsteal`, { waitUntil: 'domcontentloaded' });
    await hostile.waitForFunction(() => Boolean(window.__RP), { timeout: 15000 });
    await sleep(900);
    await hostile.evaluate(() => window.__RP.openLink(null));
    const hostileCode = await (async () => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const code = await hostile.evaluate(() => window.__RP.inviteCode());
        if (code) return code;
        await sleep(150);
      }
      return null;
    })();
    record(
      'link: a crafted ?server= cannot redirect the socket off-origin',
      Boolean(hostileCode) && hostileCode.length === 6 && originErrors.length === 0,
      JSON.stringify({ code: hostileCode, errors: originErrors.slice(0, 3) })
    );
    await hostile.close();

    // ---------------------------------------------------------------- LINK
    const linkErrors = [];
    const host = await newPage(browser, linkErrors, { width: 1440, height: 900, deviceScaleFactor: 2 });
    await bootApp(host);
    await host.evaluate(() => window.__RP.openLink(null));
    const code = await waitFor(async () => host.evaluate(() => window.__RP.inviteCode()), 12000, 'room code');
    record('link: host creates a 6-character room', Boolean(code) && code.length === 6, String(code));
    await shot(host, '1440x900-lobby-host');

    const guestErrors = [];
    const guest = await newPage(browser, guestErrors, { width: 1440, height: 900, deviceScaleFactor: 2 });
    const guestUrl = `${BASE}/?join=${code}`;
    await guest.goto(guestUrl, { waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => Boolean(window.__RP), { timeout: 15000 });
    const guestSeat = await waitFor(
      async () =>
        guest.evaluate(() => {
          const s = window.__RP.session();
          return s ? { code: s.code, side: s.side } : null;
        }),
      15000,
      'guest seat'
    );
    record('link: guest joins the same room on the second seat', guestSeat?.code === code && guestSeat?.side === 1, JSON.stringify(guestSeat));

    await sleep(1200);
    await shot(host, '1440x900-lobby-both');

    // Both clients play: pin the paddles to the top edge and serve when required.
    const scored = await playLinkToPoint(host, guest, 45000);
    record('link: two real browsers score a point over WebSocket', scored.ok, scored.detail);
    const hostScore = await host.evaluate(() => window.__RP.linkState()?.score ?? null);
    const guestScore = await guest.evaluate(() => window.__RP.linkState()?.score ?? null);
    record('link: both clients agree on the score', JSON.stringify(hostScore) === JSON.stringify(guestScore), JSON.stringify({ hostScore, guestScore }));
    const hostLabels = await host.evaluate(() => window.__RP.scoreLabels());
    const guestLabels = await guest.evaluate(() => window.__RP.scoreLabels());
    record(
      'link: score labels are side-correct for host and guest',
      JSON.stringify(hostLabels) === JSON.stringify(['YOU', 'FRIEND']) &&
        JSON.stringify(guestLabels) === JSON.stringify(['FRIEND', 'YOU']),
      JSON.stringify({ hostLabels, guestLabels })
    );
    await shot(guest, '1440x900-link-guest');
    await shot(host, '1440x900-link-match');

    // A dropped seat auto-pauses the rally, so a reclaim has to lift that freeze on
    // its own: both clients must come back to live play with nobody pressing resume.
    // Online serves are gated, so a rally only exists once a side has served.
    const prePhase = await (async () => {
      const deadline = Date.now() + 30000;
      let seen = null;
      while (Date.now() < deadline) {
        seen = await host.evaluate(() => window.__RP.linkState()?.phase ?? null);
        if (seen === 'rally') return 'rally';
        if (seen === 'countdown' || seen === 'lobby') {
          for (const page of [host, guest]) await page.keyboard.press('Enter');
        }
        await sleep(120);
      }
      return seen;
    })();
    record('link: a live rally runs before the seat drops', prePhase === 'rally', String(prePhase));

    // refresh / reclaim
    await guest.reload({ waitUntil: 'domcontentloaded' });
    await guest.waitForFunction(() => Boolean(window.__RP), { timeout: 15000 });
    const reclaimed = await waitFor(
      async () =>
        guest.evaluate(() => {
          const s = window.__RP.session();
          return s ? { code: s.code, side: s.side } : null;
        }),
      15000,
      'reclaim'
    );
    record('link: refresh reclaims the same seat with the stored token', reclaimed?.code === code && reclaimed?.side === 1, JSON.stringify(reclaimed));
    await sleep(600);
    await shot(guest, '1440x900-reconnect');

    // The frozen state is the only one that must never persist: a resumed rally may
    // legitimately move on to point/countdown, so require that live play was observed
    // at least once and that neither client was left parked.
    const observed = { sawRally: false, hostPhase: null, guestPhase: null, hostScreen: null, guestScreen: null };
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      observed.hostPhase = await host.evaluate(() => window.__RP.linkState()?.phase ?? null);
      observed.guestPhase = await guest.evaluate(() => window.__RP.linkState()?.phase ?? null);
      observed.hostScreen = await host.evaluate(() => window.__RP.screenName());
      observed.guestScreen = await guest.evaluate(() => window.__RP.screenName());
      // Serves are gated, so the resumed match needs a serve press to reach a rally.
      if (observed.hostPhase === 'countdown' || observed.hostPhase === 'lobby') {
        for (const page of [host, guest]) await page.keyboard.press('Enter');
      }
      if (observed.hostPhase === 'rally' && observed.guestPhase === 'rally') observed.sawRally = true;
      const live = observed.hostPhase !== 'paused' && observed.guestPhase !== 'paused';
      const playing = observed.hostScreen === 'playing' && observed.guestScreen === 'playing';
      if (observed.sawRally && live && playing) break;
      await sleep(120);
    }
    record(
      'link: reconnect never leaves the match frozen',
      observed.sawRally &&
        observed.hostPhase !== 'paused' &&
        observed.guestPhase !== 'paused' &&
        observed.hostScreen === 'playing' &&
        observed.guestScreen === 'playing',
      JSON.stringify({ prePhase, ...observed })
    );
    await shot(host, '1440x900-link-resumed');

    const linkOk = linkErrors.length === 0 && guestErrors.length === 0;
    record('link consoles stay clean', linkOk, [...linkErrors, ...guestErrors].slice(0, 3).join(' | '));

    await host.evaluate(() => window.__RP.setScreen('attract'));
    await sleep(200);
    await shot(host, '1440x900-attract-final');
    await host.close();
    await guest.close();
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    if (server.exitCode === null) server.kill('SIGKILL');
  }

  console.log('');
  console.log(`${results.length - failures}/${results.length} checks passed`);
  if (serverLog.trim() && failures > 0) console.log(`--- server log ---\n${serverLog.slice(-1500)}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Plays a genuine solo match with real key events. The tracker steers the paddle so
 * contact happens off-centre, which drives angled returns toward the corners. If the
 * CPU survives that for a while, the tracker deliberately stops covering so the rally
 * resolves into a real point rather than spinning forever.
 */
async function driveSoloToPoint(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const giveUpTracking = Date.now() + Math.round(timeoutMs * 0.55);
  let held = null;
  let hits = 0;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const m = window.__RP.match();
      return m
        ? { phase: m.phase, ballY: m.ball.y, ballVx: m.ball.vx, paddleY: m.paddles[0].y, score: [m.score[0], m.score[1]], hits: m.rallyHits }
        : null;
    });
    if (!st) return { ok: false, detail: 'no match state' };
    if (st.score[0] !== 0 || st.score[1] !== 0) {
      if (held) await page.keyboard.up(held);
      return { ok: true, detail: `score ${st.score.join('-')} after ${hits} paddle hits` };
    }
    if (st.phase === 'rally') {
      hits = Math.max(hits, st.hits);
      let want = null;
      if (Date.now() < giveUpTracking) {
        const reach = 95 + 24;
        // Push the ball toward the nearer corner instead of hitting it flat.
        const sign = st.ballY < 560 ? -1 : 1;
        const target = st.ballY - sign * reach * 0.75;
        const diff = target - st.paddleY;
        want = diff > 12 ? 's' : diff < -12 ? 'w' : null;
      }
      if (want !== held) {
        if (held) await page.keyboard.up(held);
        if (want) await page.keyboard.down(want);
        held = want;
      }
    }
    await sleep(26);
  }
  if (held) await page.keyboard.up(held);
  return { ok: false, detail: `no point within ${timeoutMs}ms (${hits} hits)` };
}

async function playLinkToPoint(host, guest, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let served = false;
  const pinned = new Set();
  try {
    while (Date.now() < deadline) {
      const snap = await host.evaluate(() => window.__RP.linkState());
      if (!snap) {
        await sleep(120);
        continue;
      }
      if (snap.phase === 'countdown' || snap.phase === 'lobby') {
        for (const page of [host, guest]) await page.keyboard.press('Enter');
        if (pinned.size) {
          for (const page of pinned) await page.keyboard.up('ArrowUp');
          pinned.clear();
        }
        served = true;
      } else if (snap.phase === 'rally') {
        for (const page of [host, guest]) {
          if (!pinned.has(page)) {
            await page.keyboard.down('ArrowUp');
            pinned.add(page);
          }
        }
      }
      if (snap.score && (snap.score[0] !== 0 || snap.score[1] !== 0)) {
        return { ok: true, detail: `point scored, score ${snap.score.join('-')} (served=${served})` };
      }
      await sleep(90);
    }
  } finally {
    for (const page of pinned) await page.keyboard.up('ArrowUp');
  }
  return { ok: false, detail: `no point within ${timeoutMs}ms` };
}

main().catch((err) => {
  console.error('browser harness error:', err);
  process.exit(1);
});
