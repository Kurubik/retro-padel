import {
  COUNTDOWN_TIME,
  FIELD_H,
  STEP,
  clamp,
  createMatch,
  cpuInput,
  createCpuMemory,
  serveBall,
  stepMatch,
  type CpuLevel,
  type CpuMemory,
  type MatchState,
  type PaddleInput,
  type Side
} from '@shared/core/index.js';
import { AudioEngine } from './audio.js';
import { buildDevice, type Action, type Device } from './device.js';
import { InputHub } from './input.js';
import { renderMenu, renderRows, h, type MenuRow } from './menu.js';
import { LinkClient } from './net.js';
import { FieldRenderer, type RenderView } from './renderer.js';
import { applySettings, loadSettings, saveSettings, type Settings } from './settings.js';
import { randomSeed } from '@shared/core/rng.js';
import type { ServerMessage } from '@shared/protocol.js';

type Mode = 'solo' | 'local' | 'link';
type Screen =
  | 'attract'
  | 'modes'
  | 'howto'
  | 'settings'
  | 'link'
  | 'lobby'
  | 'playing'
  | 'paused'
  | 'over'
  | 'reconnecting';

const LEVELS: CpuLevel[] = ['rookie', 'pro', 'legend'];
const LEVEL_LABEL: Record<CpuLevel, string> = { rookie: 'ROOKIE', pro: 'PRO', legend: 'LEGEND' };
const MODE_LABEL: Record<Mode, string> = { solo: 'SOLO / CPU', local: 'LOCAL / 2P', link: 'LINK / FRIEND' };

interface SnapshotBufferEntry {
  snap: Extract<ServerMessage, { t: 'state' }>;
  recvAt: number;
}

interface LinkSession {
  code: string;
  side: Side;
  token: string;
  connected: [boolean, boolean];
  reclaimUntil: number | null;
  buffer: SnapshotBufferEntry[];
  predictedY: number;
  ping: number;
  lastPingSent: number;
}

export class App {
  private readonly device: Device;
  private readonly input: InputHub;
  private readonly renderer: FieldRenderer;
  private readonly audio = new AudioEngine();
  private settings: Settings = loadSettings();

  private screen: Screen = 'attract';
  private mode: Mode = 'solo';
  private level: CpuLevel = 'pro';
  private selectIndex = 0;
  private menuIndex = 0;

  private demo: MatchState;
  private demoMem: [CpuMemory, CpuMemory] = [createCpuMemory(), createCpuMemory()];

  private match: MatchState | null = null;
  private cpuMem: CpuMemory = createCpuMemory();

  private link: LinkClient | null = null;
  private session: LinkSession | null = null;
  private queueCode = '';
  private linkError = '';
  private retry = 0;
  private retryTimer: number | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private overTimer: number | null = null;
  private accumulator = 0;
  private lastTs = 0;
  private fps = 60;
  private frames = 0;
  private fpsTimer = 0;
  private sendTimer = 0;
  private headless = false;

  constructor(mount: HTMLElement) {
    this.device = buildDevice(mount);
    this.input = new InputHub(this.device.refs.screen, this.device);
    this.renderer = new FieldRenderer(this.device.refs.canvas);
    this.demo = createMatch(randomSeed(), 0);
    this.demo.phase = 'rally';
    serveBall(this.demo, 0);

    this.device.onAction((action) => this.handleAction(action));
    this.renderer.resize(1, 1);
    this.setSettings(this.settings, false);
    this.wireQueue();
  }

  // ---------------------------------------------------------------- lifecycle
  start(): void {
    const boot = document.getElementById('boot');
    const bootMs = this.settings.motion === 'reduced' ? 80 : 660;
    this.device.refs.console.classList.add('is-booting');
    window.setTimeout(() => this.device.refs.console.classList.remove('is-booting'), bootMs);
    window.setTimeout(() => boot?.classList.add('is-done'), bootMs + 220);

    if (this.queueCode) {
      // A shared invite link opens the room directly.
      window.setTimeout(() => this.openLink(this.queueCode), bootMs + 80);
    }
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      // The screen box resolves late (aspect-ratio + webfont metrics), so keep tracking it
      // instead of trusting a single boot-time measurement.
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.device.refs.screen);
    }
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => window.setTimeout(() => this.resize(), 120));
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready.then(() => this.resize()).catch(() => undefined);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseOrBack();
    });
    this.renderScreen();
    this.lastTs = performance.now();
    requestAnimationFrame((ts) => this.frame(ts));
  }

  private resize(): void {
    // offsetWidth/offsetHeight report the *layout* box, so the power-on transform and the
    // point-shake transform cannot corrupt the canvas backing-store size.
    const node = this.device.refs.screen;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width < 12 || height < 12) return;
    this.renderer.resize(width, height);
  }

  private wireQueue(): void {
    const params = new URLSearchParams(location.search);
    const join = params.get('join') ?? params.get('room');
    if (join) {
      this.queueCode = join.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      this.mode = 'link';
    }
  }

  // ---------------------------------------------------------------- settings
  private setSettings(next: Settings, persist = true): void {
    this.settings = next;
    applySettings(next);
    this.audio.setEnabled(next.sound);
    if (persist) saveSettings(next);
  }

  // ---------------------------------------------------------------- actions
  private handleAction(action: Action): void {
    if (action === 'hold-up') return this.input.notePad('up');
    if (action === 'hold-down') return this.input.notePad('down');
    if (action === 'release') return this.input.notePad('release');

    if (this.screen === 'attract') {
      if (action === 'select') {
        this.selectIndex = (this.selectIndex + 1) % 3;
        this.audio.ui();
        this.renderScreen();
        return;
      }
      if (action === 'start' || action === 'a') {
        this.audio.unlock();
        this.menuIndex = 0;
        this.changeScreen('modes');
        return;
      }
      return;
    }

    if (this.screen === 'modes') {
      const rows = this.modeRows();
      if (action === 'up') this.moveIndex(rows.length, -1);
      else if (action === 'down') this.moveIndex(rows.length, 1);
      else if (action === 'start') this.moveIndex(rows.length, 1);
      else if (action === 'left' && this.mode === 'solo') this.cycleLevel(-1);
      else if (action === 'right' && this.mode === 'solo') this.cycleLevel(1);
      else if (action === 'a') {
        this.audio.unlock();
        this.activateMode(this.selectedMode());
      } else if (action === 'select') {
        if (this.mode === 'solo') this.cycleLevel(1);
        else this.moveIndex(rows.length, 1);
      } else if (action === 'b') return this.changeScreen('attract');
      return;
    }

    if (this.screen === 'settings') {
      const rows = this.settingRows();
      if (action === 'up') this.moveIndex(rows.length, -1);
      else if (action === 'down') this.moveIndex(rows.length, 1);
      else if (action === 'left' || action === 'right' || action === 'a' || action === 'start') {
        this.audio.ui();
        this.adjustSetting(this.settingRows()[this.menuIndex].id);
      } else if (action === 'select') this.moveIndex(rows.length, 1);
      else if (action === 'b') return this.back();
      return;
    }

    if (this.screen === 'link') {
      const rows = this.linkRows();
      if (action === 'up') this.moveIndex(rows.length, -1);
      else if (action === 'down' || action === 'start') this.moveIndex(rows.length, 1);
      else if (action === 'a') {
        this.audio.unlock();
        this.selectLink(this.linkRows()[this.menuIndex].id);
      } else if (action === 'select') this.moveIndex(rows.length, 1);
      else if (action === 'b') return this.back();
      return;
    }

    if (this.screen === 'lobby') {
      if (action === 'b') this.leaveLink(true);
      if (action === 'a' || action === 'start') {
        if (this.session?.connected[this.session.side === 0 ? 1 : 0]) this.device.refs.screen.focus();
      }
      return;
    }

    if (this.screen === 'reconnecting') {
      if (action === 'b') this.leaveLink(true);
      return;
    }

    if (this.screen === 'paused') {
      const rows = ['resume', 'settings', 'menu'];
      if (action === 'up') this.moveIndex(rows.length, -1);
      else if (action === 'down' || action === 'select') this.moveIndex(rows.length, 1);
      else if (action === 'a' || action === 'start') {
        const id = rows[this.menuIndex];
        if (id === 'resume') this.resume();
        else if (id === 'settings') this.changeScreen('settings');
        else this.quitToMenu();
      } else if (action === 'b') this.resume();
      return;
    }

    if (this.screen === 'over') {
      const rows = ['rematch', 'menu'];
      if (action === 'up') this.moveIndex(rows.length, -1);
      else if (action === 'down' || action === 'select') this.moveIndex(rows.length, 1);
      else if (action === 'a' || action === 'start') {
        if (rows[this.menuIndex] === 'rematch') this.requestRematch();
        else this.quitToMenu();
      } else if (action === 'b') this.quitToMenu();
      return;
    }

    if (this.screen === 'howto') {
      if (action === 'b' || action === 'a' || action === 'start') this.back();
      return;
    }

    if (this.screen === 'playing') {
      if (action === 'b') this.pauseOrBack();
      else if (action === 'a') this.serve();
    }
  }

  private moveIndex(len: number, delta: number): void {
    this.menuIndex = (this.menuIndex + delta + len) % len;
    this.audio.ui();
    this.renderScreen();
  }

  private back(): void {
    this.audio.back();
    if (this.screen === 'settings' || this.screen === 'howto' || this.screen === 'link') {
      this.changeScreen(this.previousScreen);
    } else {
      this.changeScreen('attract');
    }
  }

  private previousScreen: Screen = 'attract';

  private changeScreen(screen: Screen): void {
    if (screen !== 'settings' && screen !== 'howto') this.previousScreen = this.screen;
    if (screen === 'settings' || screen === 'howto' || screen === 'link' || screen === 'modes') this.menuIndex = 0;
    this.screen = screen;
    this.renderScreen();
  }

  private cycleLevel(delta: number): void {
    const i = LEVELS.indexOf(this.level);
    this.level = LEVELS[(i + delta + LEVELS.length) % LEVELS.length];
    this.audio.ui();
    this.renderScreen();
  }

  private selectedMode(): Mode {
    return (['solo', 'local', 'link'] as Mode[])[this.menuIndex] ?? 'solo';
  }

  private modeRows(): MenuRow[] {
    return [
      { id: 'solo', label: 'SOLO / CPU', note: LEVEL_LABEL[this.level] },
      { id: 'local', label: 'LOCAL / 2P', note: '2 players' },
      { id: 'link', label: 'LINK / FRIEND', note: 'invite link' },
      { id: 'howto', label: 'HOW TO PLAY', note: 'controls' },
      { id: 'settings', label: 'SETTINGS', note: 'options' }
    ];
  }

  private activateMode(mode: Mode): void {
    if (mode === 'solo') return this.startOffline('solo');
    if (mode === 'local') return this.startOffline('local');
    this.changeScreen('link');
  }

  /** Cancel a pending "game over" screen switch so it cannot hijack the next state. */
  private clearOverTimer(): void {
    if (this.overTimer !== null) {
      clearTimeout(this.overTimer);
      this.overTimer = null;
    }
  }

  private startOffline(mode: 'solo' | 'local'): void {
    this.clearOverTimer();
    this.mode = mode;
    this.match = createMatch(randomSeed(), 0);
    this.cpuMem = createCpuMemory();
    this.accumulator = 0;
    this.changeScreen('playing');
    this.audio.countdown(false);
  }

  private serve(): void {
    if (this.screen !== 'playing') return;
    if (this.mode === 'link') {
      this.link?.sendInput(this.input.intents()[this.session?.side ?? 0].dir, true);
      return;
    }
    if (this.match && this.match.phase === 'countdown' && this.match.timer <= 0) {
      const side = this.match.server;
      const intents = this.input.intents();
      intents[side].serve = true;
      stepMatch(this.match, { inputs: intents });
      this.audio.serve();
    }
  }

  private pauseOrBack(): void {
    if (this.screen === 'playing') {
      this.audio.back();
      if (this.mode === 'link') this.link?.send({ t: 'pause' });
      this.changeScreen('paused');
      this.menuIndex = 0;
    }
  }

  private resume(): void {
    if (this.mode === 'link') this.link?.send({ t: 'resume' });
    this.changeScreen('playing');
  }

  private requestRematch(): void {
    if (this.mode === 'link') {
      this.link?.send({ t: 'rematch' });
      return;
    }
    if (this.screen === 'over') this.startOffline(this.mode === 'local' ? 'local' : 'solo');
  }

  private quitToMenu(): void {
    this.clearOverTimer();
    if (this.mode === 'link') this.leaveLink(true);
    this.match = null;
    this.changeScreen('attract');
  }

  private settingRows(): { id: string; label: string; hint?: string; value: string; on?: boolean }[] {
    return [
      { id: 'sound', label: 'SOUND', hint: 'web audio, off until enabled', value: this.settings.sound ? 'ON' : 'OFF', on: this.settings.sound },
      { id: 'motion', label: 'MOTION', hint: 'sweep, trail, pulses', value: this.settings.motion === 'reduced' ? 'REDUCED' : 'FULL', on: this.settings.motion === 'full' },
      { id: 'contrast', label: 'CONTRAST', hint: 'ink + shell', value: this.settings.contrast === 'high' ? 'HIGH' : 'STD', on: this.settings.contrast === 'high' },
      { id: 'back', label: 'BACK', value: '', on: false }
    ];
  }

  private adjustSetting(id: string): void {
    if (id === 'sound') this.setSettings({ ...this.settings, sound: !this.settings.sound });
    else if (id === 'motion') this.setSettings({ ...this.settings, motion: this.settings.motion === 'full' ? 'reduced' : 'full' });
    else if (id === 'contrast') this.setSettings({ ...this.settings, contrast: this.settings.contrast === 'high' ? 'standard' : 'high' });
    else if (id === 'back') return this.back();
    this.renderScreen();
  }

  // ---------------------------------------------------------------- link mode
  private linkRows(): MenuRow[] {
    return [
      { id: 'create', label: 'CREATE ROOM', note: 'host a private duel' },
      { id: 'join', label: 'JOIN WITH CODE', note: this.queueCode || '6 characters' },
      { id: 'back', label: 'BACK', note: '' }
    ];
  }

  private selectLink(id: string): void {
    if (id === 'back') return this.back();
    if (id === 'create') return this.openLink(null);
    this.openLink(this.queueCode || null);
  }

  private storedLink(): { code: string; token: string } | null {
    try {
      const raw = sessionStorage.getItem('rp.link');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { code?: string; token?: string };
      return parsed.code && parsed.token ? { code: parsed.code, token: parsed.token } : null;
    } catch {
      return null;
    }
  }

  private clearStoredLink(): void {
    try {
      sessionStorage.removeItem('rp.link');
    } catch {
      /* ignore */
    }
  }

  private openLink(code: string | null): void {
    this.retry = 0;
    this.linkError = '';
    this.link?.close();
    const stored = this.storedLink();
    const reclaim = code && stored && stored.code === code ? stored : null;
    const link = new LinkClient();
    this.link = link;
    link.setHandlers({
      onRoom: (msg) => this.onRoom(msg),
      onState: (msg) => this.onState(msg),
      onEvent: (msg) => this.onEvent(msg),
      onError: (msg) => this.onLinkError(msg),
      onOpen: () => {
        this.retry = 0;
        if (this.session) {
          link.send({ t: 'reclaim', code: this.session.code, token: this.session.token });
        } else if (reclaim) {
          link.send({ t: 'reclaim', code: reclaim.code, token: reclaim.token });
        } else if (code) {
          link.send({ t: 'join', code });
        } else {
          link.send({ t: 'create' });
        }
      },
      onClose: (info) => this.onLinkClosed(info.willRetry)
    });
    link.connect();
    this.changeScreen(this.session ? 'reconnecting' : 'lobby');
  }

  private onRoom(msg: Extract<ServerMessage, { t: 'room' }>): void {
    const isNew = !this.session || this.session.code !== msg.code;
    this.session = {
      code: msg.code,
      side: msg.side,
      token: msg.token,
      connected: msg.connected,
      reclaimUntil: msg.reclaimExpiresAt,
      buffer: isNew ? [] : this.session?.buffer ?? [],
      predictedY: this.session?.predictedY ?? FIELD_H / 2,
      ping: this.session?.ping ?? 0,
      lastPingSent: 0
    };
    this.mode = 'link';
    try {
      sessionStorage.setItem('rp.link', JSON.stringify({ code: msg.code, token: msg.token }));
    } catch {
      /* ignore */
    }
    this.audio.connect();
    const url = new URL(location.href);
    url.searchParams.set('join', msg.code);
    history.replaceState(null, '', url.toString());
    this.changeScreen('lobby');
  }

  private onLinkError(msg: Extract<ServerMessage, { t: 'error' }>): void {
    this.linkError = msg.message;
    this.audio.error();
    if (msg.code === 'NOT_FOUND' || msg.code === 'FULL' || msg.code === 'BAD_TOKEN' || msg.code === 'SERVER_BUSY') {
      this.session = null;
      this.changeScreen('link');
    }
    this.renderScreen();
  }

  private onLinkClosed(willRetry: boolean): void {
    if (this.screen === 'attract' || !this.session) return;
    if (!willRetry) this.attemptRetry();
    this.changeScreen('reconnecting');
  }

  private attemptRetry(): void {
    if (!this.session || this.retry >= 8) return;
    this.retry++;
    const delay = Math.min(6000, 500 * 2 ** this.retry);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.screen === 'reconnecting') this.link?.connect();
    }, delay);
  }

  private onState(msg: Extract<ServerMessage, { t: 'state' }>): void {
    if (!this.session) return;
    const buffer = this.session.buffer;
    buffer.push({ snap: msg, recvAt: performance.now() });
    while (buffer.length > 24) buffer.shift();
    this.session.connected = msg.connected;
    if (this.screen === 'lobby' && msg.phase !== 'lobby') this.changeScreen('playing');
    if (this.screen === 'reconnecting') {
      this.changeScreen(msg.phase === 'lobby' ? 'lobby' : 'playing');
    }
    const other = this.session.side === 0 ? 1 : 0;
    if (!msg.connected[other] && msg.phase !== 'lobby') {
      if (this.screen === 'playing' || this.screen === 'paused') this.changeScreen('reconnecting');
    }
    if (msg.phase === 'game-over' && this.screen === 'playing') this.changeScreen('over');
    if (msg.phase === 'paused' && this.screen === 'playing') {
      this.changeScreen('paused');
      this.menuIndex = 0;
    }
  }

  private onEvent(msg: Extract<ServerMessage, { t: 'event' }>): void {
    switch (msg.kind) {
      case 'point':
        this.audio.point(msg.side === this.session?.side);
        this.renderer.ping(this.session?.side === 0 ? 60 : 940, FIELD_H / 2, 'score');
        break;
      case 'game-over':
        if (msg.side === this.session?.side) this.audio.win();
        else this.audio.lose();
        this.changeScreen('over');
        break;
      case 'paused':
        this.changeScreen('paused');
        this.menuIndex = 0;
        break;
      case 'resumed':
        this.changeScreen('playing');
        break;
      case 'disconnect':
        this.changeScreen('reconnecting');
        break;
      case 'expired':
        this.linkError = 'The room expired. Create a new one.';
        this.session = null;
        this.changeScreen('link');
        break;
      case 'rematch':
        this.changeScreen('playing');
        break;
      case 'connect':
        break;
    }
  }

  private leaveLink(backToMenu: boolean): void {
    this.clearOverTimer();
    this.link?.close();
    this.link = null;
    this.session = null;
    this.clearStoredLink();
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const url = new URL(location.href);
    url.searchParams.delete('join');
    history.replaceState(null, '', url.toString());
    if (backToMenu) this.changeScreen('attract');
  }

  // ---------------------------------------------------------------- loop
  private frame(ts: number): void {
    const dt = Math.min((ts - this.lastTs) / 1000, 0.25);
    this.lastTs = ts;
    this.frames++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTimer);
      this.frames = 0;
      this.fpsTimer = 0;
    }
    this.update(dt);
    this.renderer.render(this.currentView(), dt);
    if (this.frames % 6 === 0 || this.fpsTimer === 0) this.updateRail();
    requestAnimationFrame((next) => this.frame(next));
  }

  private update(dt: number): void {
    if (this.screen === 'attract' || this.screen === 'modes' || this.screen === 'howto' || this.screen === 'settings') {
      this.stepDemo(dt);
      return;
    }
    if (this.mode === 'link') {
      this.updateLink(dt);
      return;
    }
    if ((this.screen === 'playing' || this.screen === 'over') && this.match) {
      this.stepOffline(dt);
    }
  }

  private stepDemo(dt: number): void {
    this.accumulator += dt;
    let guard = 0;
    while (this.accumulator >= STEP && guard++ < 6) {
      this.accumulator -= STEP;
      const a = cpuInput(this.demo, 0, 'pro', this.demoMem[0]);
      const b = cpuInput(this.demo, 1, 'pro', this.demoMem[1]);
      const events = stepMatch(this.demo, { inputs: [a, b] });
      for (const ev of events) {
        if (ev.kind === 'paddle') {
          this.renderer.ping(this.demo.ball.x, this.demo.ball.y, 'paddle');
          break;
        }
        if (ev.kind === 'point') {
          this.demo.score = [0, 0];
          serveBall(this.demo, ev.side === 0 ? 1 : 0);
        }
      }
    }
  }

  private stepOffline(dt: number): void {
    if (!this.match) return;
    if (this.screen === 'over') {
      stepMatch(this.match, { inputs: [{ dir: 0, target: null }, { dir: 0, target: null }] });
      return;
    }
    this.accumulator += dt;
    let guard = 0;
    while (this.accumulator >= STEP && guard++ < 6) {
      this.accumulator -= STEP;
      const inputs = this.intentsForOffline();
      const events = stepMatch(this.match, { inputs, serveGate: false });
      for (const ev of events) {
        if (ev.kind === 'paddle') {
          this.renderer.ping(this.match.ball.x, this.match.ball.y, 'paddle');
          this.audio.paddle();
          this.buzz(6);
        } else if (ev.kind === 'wall') {
          this.audio.wall();
          this.buzz(3);
        } else if (ev.kind === 'countdown') {
          if (ev.value > 0) this.audio.countdown(false);
        } else if (ev.kind === 'point') {
          const mine = this.mode === 'local' ? true : ev.side === 0;
          this.audio.point(mine);
          this.renderer.ping(ev.side === 0 ? 60 : 940, FIELD_H / 2, 'score');
          this.buzz(14);
          this.shake();
        } else if (ev.kind === 'game-over') {
          if (this.mode === 'local' || ev.side === 0) this.audio.win();
          else this.audio.lose();
          this.clearOverTimer();
          this.overTimer = window.setTimeout(() => {
            this.overTimer = null;
            // Only take over the screen if this match is still the finished one.
            if (this.screen === 'playing' && this.match?.phase === 'game-over') this.changeScreen('over');
          }, 620);
        }
      }
    }
  }

  private intentsForOffline(): [PaddleInput, PaddleInput] {
    const split = this.mode === 'local';
    this.input.setContext({ side: 0, split });
    const base = this.input.intents();
    if (split) return base;
    const pad = this.input.gamepadIntent();
    if (pad !== null) base[0].dir = Math.max(-1, Math.min(1, base[0].dir + pad));
    const cpu = cpuInput(this.match!, 1, this.level, this.cpuMem);
    return [base[0], cpu];
  }

  private updateLink(dt: number): void {
    if (!this.session || !this.link) return;
    this.input.setContext({ side: this.session.side, split: false });
    const intents = this.input.intents();
    const pad = this.input.gamepadIntent();
    if (pad !== null) intents[this.session.side].dir = Math.max(-1, Math.min(1, intents[this.session.side].dir + pad));

    this.sendTimer += dt;
    if (this.sendTimer >= 1 / 30) {
      this.sendTimer = 0;
      this.link.sendInput(intents[this.session.side].dir, false);
    }

    const now = performance.now();
    if (now - this.session.lastPingSent > 2000) {
      this.session.lastPingSent = now;
      this.link.send({ t: 'ping', ts: Date.now() });
    }

    // Local prediction for our own paddle so input never feels laggy.
    const latest = this.session.buffer[this.session.buffer.length - 1]?.snap;
    if (latest) {
      const predicted = { y: this.session.predictedY, vy: 0 };
      const own: PaddleInput = intents[this.session.side];
      const delta = own.target !== null ? own.target - predicted.y : Math.sign(own.dir) * 940 * dt;
      predicted.y = clamp(predicted.y + delta, 95, FIELD_H - 95);
      const serverY = latest.paddles[this.session.side].y;
      this.session.predictedY = Math.abs(predicted.y - serverY) > 110 ? serverY : predicted.y;
    }
  }

  private interpolated(): Extract<ServerMessage, { t: 'state' }> | null {
    const buffer = this.session?.buffer;
    if (!buffer || buffer.length === 0) return null;
    const latest = buffer[buffer.length - 1];
    if (buffer.length === 1) return latest.snap;
    const alpha = 0.55;
    const prev = buffer[buffer.length - 2];
    const mix = (a: number, b: number) => a + (b - a) * alpha;
    void latest;
    const snap = prev.snap;
    const target = buffer[buffer.length - 1].snap;
    return {
      ...target,
      ball: { x: mix(snap.ball.x, target.ball.x), y: mix(snap.ball.y, target.ball.y), vx: target.ball.vx, vy: target.ball.vy },
      paddles: [
        { y: mix(snap.paddles[0].y, target.paddles[0].y), vy: target.paddles[0].vy },
        { y: mix(snap.paddles[1].y, target.paddles[1].y), vy: target.paddles[1].vy }
      ]
    };
  }

  // ---------------------------------------------------------------- view
  private currentView(): RenderView {
    const reducedMotion = this.settings.motion === 'reduced';
    if (this.mode === 'link' && this.session) {
      const snap = this.interpolated();
      const buffer = this.session.buffer;
      const latest = buffer[buffer.length - 1]?.snap ?? null;
      const ambient = this.screen === 'lobby';
      const side = this.session.side;
      const paddles: [{ y: number; vy: number }, { y: number; vy: number }] = latest
        ? [{ y: snap?.paddles[0].y ?? latest.paddles[0].y, vy: latest.paddles[0].vy }, { y: snap?.paddles[1].y ?? latest.paddles[1].y, vy: latest.paddles[1].vy }]
        : [{ y: FIELD_H / 2, vy: 0 }, { y: FIELD_H / 2, vy: 0 }];
      paddles[side].y = this.session.predictedY;
      return {
        ball: snap?.ball ?? { x: 500, y: FIELD_H / 2, vx: 0, vy: 0 },
        paddles,
        score: latest?.score ?? [0, 0],
        server: latest?.server ?? 0,
        ambient,
        showPaddles: true,
        servePulse: latest ? clamp(1 - latest.timer / COUNTDOWN_TIME, 0.15, 1) : 0,
        suddenDeath: latest?.suddenDeath ?? false,
        reducedMotion,
        showScore: !ambient,
        localSplit: false
      };
    }

    if (this.match && (this.screen === 'playing' || this.screen === 'paused' || this.screen === 'over')) {
      const pulse =
        this.match.phase === 'countdown' ? clamp(1 - this.match.timer / COUNTDOWN_TIME, 0.2, 1) : 0;
      return {
        ball: this.match.ball,
        paddles: [this.match.paddles[0], this.match.paddles[1]],
        score: this.match.score,
        server: this.match.server,
        ambient: this.screen === 'over',
        showPaddles: true,
        servePulse: pulse,
        suddenDeath: this.match.suddenDeath,
        reducedMotion,
        showScore: true,
        localSplit: this.mode === 'local' && this.screen === 'playing'
      };
    }

    const ambient = this.screen !== 'playing';
    return {
      ball: this.demo.ball,
      paddles: [this.demo.paddles[0], this.demo.paddles[1]],
      score: this.demo.score,
      server: this.demo.server,
      ambient,
      showPaddles: true,
      servePulse: 0,
      suddenDeath: false,
      reducedMotion,
      // The demo rally only carries its own score readout on the attract screen.
      showScore: this.screen === 'attract',
      localSplit: false
    };
  }

  private shake(): void {
    const node = this.device.refs.console;
    node.classList.remove('is-shaking');
    void node.offsetWidth;
    node.classList.add('is-shaking');
    window.setTimeout(() => node.classList.remove('is-shaking'), 260);
  }

  private buzz(ms: number): void {
    if (this.settings.motion === 'reduced') return;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(ms);
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------- ui
  renderScreen(): void {
    const ui = this.device.refs.ui;
    ui.innerHTML = '';
    ui.hidden = true;
    const refs = this.device.refs;

    refs.console.dataset.phase = this.screen;
    refs.footMode.textContent = this.footLabel();
    refs.footHint.textContent = this.footHint();
    refs.screenSession.textContent = this.sessionLabel();
    refs.screenTier.textContent = this.screen === 'attract' ? 'LV.01' : LEVEL_LABEL[this.level];
    refs.ledServe.dataset.on = this.serveLedOn() ? '1' : '0';
    refs.ledLink.dataset.on = this.mode === 'link' ? '1' : '0';
    refs.ledLink.dataset.state =
      this.mode !== 'link' ? 'off' : this.screen === 'reconnecting' ? 'down' : this.session?.connected[this.session.side] ? 'live' : 'wait';

    if (this.screen === 'attract') {
      const panel = h('div', 'ui__panel attract');
      const kicker = h('div', 'attract__kicker');
      kicker.textContent = 'CYBER ARCADE';
      const logo = h('div', 'attract__logo');
      logo.innerHTML = 'RETRO<span class="slash">//</span><br>PADEL';
      const press = h('div', 'attract__press');
      press.textContent = 'PRESS START';
      const hint = h('div', 'attract__hint');
      hint.textContent = 'A = START · SELECT = MODE';
      const modes = h('div', 'attract__modes');
      const short: Record<Mode, string> = { solo: 'SOLO', local: 'LOCAL', link: 'LINK' };
      (['solo', 'local', 'link'] as Mode[]).forEach((m, i) => {
        const span = h('span');
        span.textContent = i === this.selectIndex ? `[${short[m]}]` : short[m];
        modes.append(span);
      });
      panel.append(kicker, logo, press, hint, modes);
      ui.append(panel);
      ui.hidden = false;
      return;
    }

    if (this.screen === 'modes') {
      ui.hidden = false;
      renderMenu(
        ui,
        {
          title: 'SELECT MODE',
          sub: 'SIGNAL/09',
          rows: this.modeRows(),
          index: this.menuIndex,
          footLeft: '↑↓ MOVE · ◄► LEVEL',
          footRight: 'A SELECT'
        },
        { onSelect: (id) => this.activateModeById(id), onHighlight: (i) => this.setIndex(i) }
      );
      return;
    }

    if (this.screen === 'settings') {
      ui.hidden = false;
      renderRows(
        ui,
        { title: 'SETTINGS', sub: 'ON DEVICE', foot: 'A TOGGLE · B BACK' },
        this.settingRows(),
        this.menuIndex,
        { onSelect: (id) => this.adjustSetting(id), onHighlight: (i) => this.setIndex(i) }
      );
      return;
    }

    if (this.screen === 'howto') {
      ui.hidden = false;
      const panel = h('div', 'ui__panel prose');
      const title = h('h2');
      title.textContent = 'HOW TO PLAY';
      const list = h('ul');
      const rows: [string, string][] = [
        ['GOAL', 'First to 7, win by 2. At 10–10 the next point decides.'],
        ['MOVE', 'Solo: W/S or drag. Local: W/S and ↑/↓, or drag the two screen halves.'],
        ['SERVE', 'Enter / A when the serve LED is lit. Serve alternates.'],
        ['PAUSE', 'Esc / B. Choose resume, settings or quit.'],
        ['LINK', 'Create a room and share the code, or open the invite link.'],
        ['TOUCH', 'Hold and drag anywhere on the screen to steer.']
      ];
      for (const [k, v] of rows) {
        const li = h('li');
        const b = h('b');
        b.textContent = k;
        const span = h('span');
        span.textContent = v;
        li.append(b, span);
        list.append(li);
      }
      const body = h('div', 'prose__list');
      body.append(list);
      const foot = h('div', 'prose__foot');
      foot.textContent = 'B / A to return';
      panel.append(title, body, foot);
      ui.append(panel);
      return;
    }

    if (this.screen === 'link') {
      ui.hidden = false;
      const panel = h('div', 'ui__panel menu');
      renderMenu(
        ui,
        {
          title: 'LINK / FRIEND',
          sub: 'PRIVATE 1v1',
          rows: this.linkRows().map((r) => (r.id === 'join' ? { ...r, note: this.queueCode || 'enter code' } : r)),
          index: this.menuIndex,
          footLeft: this.linkError || '↑↓ MOVE · A SELECT',
          footRight: 'B BACK'
        },
        { onSelect: (id) => this.selectLink(id), onHighlight: (i) => this.setIndex(i) }
      );
      const entry = h('div', 'lobby__btns');
      const input = h('input', 'lobby__code-input', {
        type: 'text',
        inputmode: 'latin',
        maxlength: '6',
        placeholder: 'CODE',
        'aria-label': 'Room code'
      });
      input.style.cssText =
        'flex:1;min-height:44px;border:2px solid currentColor;background:transparent;color:inherit;font:600 6cqw var(--f-mono);letter-spacing:.2em;text-align:center;text-transform:uppercase;border-radius:2px;padding:0 8px;';
      input.value = this.queueCode;
      input.addEventListener('input', () => {
        this.queueCode = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        input.value = this.queueCode;
      });
      const joinBtn = h('button', 'lobby__btn', { type: 'button' });
      joinBtn.textContent = 'JOIN';
      joinBtn.dataset.primary = '1';
      joinBtn.addEventListener('click', () => {
        this.audio.unlock();
        this.openLink(this.queueCode || null);
      });
      entry.append(input, joinBtn);
      panel.append(entry);
      ui.append(panel);
      void panel;
      return;
    }

    if (this.screen === 'lobby' && this.session) {
      ui.hidden = false;
      const panel = h('div', 'ui__panel lobby');
      const head = h('div', 'lobby__head');
      const title = h('div', 'lobby__title');
      title.textContent = 'LINK ACTIVE';
      const sub = h('div', 'menu__sub');
      sub.textContent = this.session.side === 0 ? 'HOST' : 'GUEST';
      head.append(title, sub);
      const label = h('div', 'lobby__label');
      label.textContent = 'ROOM CODE — SHARE IT';
      const code = h('div', 'lobby__code');
      code.textContent = this.session.code;
      const link = h('div', 'lobby__link');
      const base = location.pathname.endsWith('/index.html')
        ? `${location.origin}${location.pathname.slice(0, -'index.html'.length)}`
        : `${location.origin}${location.pathname}`;
      link.textContent = `${base}?join=${this.session.code}`;
      const players = h('div', 'lobby__players');
      (['YOU', 'FRIEND'] as const).forEach((name, i) => {
        const row = h('div', 'lobby__player');
        const left = h('span');
        left.textContent = `${name} · P${i + 1}`;
        const right = h('span');
        const online = this.session!.connected[i as 0 | 1];
        right.textContent = online ? 'READY' : 'WAITING';
        if (online) row.dataset.ready = '1';
        row.append(left, right);
        players.append(row);
      });
      const state = h('div', 'lobby__state');
      state.textContent = this.session.connected[this.session.side === 0 ? 1 : 0]
        ? 'Both ready — starting.'
        : 'Waiting for your friend to join.';
      const btns = h('div', 'lobby__btns');
      const copy = h('button', 'lobby__btn', { type: 'button' });
      copy.textContent = 'COPY LINK';
      copy.addEventListener('click', () => {
        this.audio.unlock();
        void this.copyText(link.textContent ?? '');
      });
      const leave = h('button', 'lobby__btn', { type: 'button' });
      leave.textContent = 'LEAVE';
      leave.addEventListener('click', () => this.leaveLink(true));
      btns.append(copy, leave);
      panel.append(head, label, code, link, players, state, btns);
      ui.append(panel);
      return;
    }

    if (this.screen === 'reconnecting') {
      ui.hidden = false;
      const panel = h('div', 'ui__panel notice');
      const code = h('b', 'notice__code');
      code.textContent = 'LINK LOST';
      const body = h('div');
      body.textContent = this.session
        ? 'Reconnecting to the room. Your seat is held for 60 seconds.'
        : 'Reconnecting.';
      const hint = h('div', 'stat-line');
      hint.textContent = 'B = leave room';
      hint.style.marginTop = '2cqh';
      panel.append(code, body, hint);
      ui.append(panel);
      return;
    }

    if (this.screen === 'paused') {
      ui.hidden = false;
      renderMenu(
        ui,
        { title: 'PAUSED', sub: MODE_LABEL[this.mode], rows: [
          { id: 'resume', label: 'RESUME' },
          { id: 'settings', label: 'SETTINGS' },
          { id: 'menu', label: 'QUIT TO MENU' }
        ], index: this.menuIndex, footLeft: 'A CONFIRM', footRight: 'B RESUME' },
        {
          onSelect: (id) => {
            if (id === 'resume') this.resume();
            else if (id === 'settings') this.changeScreen('settings');
            else this.quitToMenu();
          },
          onHighlight: (i) => this.setIndex(i)
        }
      );
      return;
    }

    if (this.screen === 'over') {
      ui.hidden = false;
      const panel = h('div', 'ui__panel banner');
      const plate = h('div', 'banner__plate');
      const title = h('div', 'banner__title');
      const winnerSide = this.match ? this.match.matchWinner : this.session ? (this.session.buffer.at(-1)?.snap.matchWinner ?? 0) : 0;
      const mineWon = this.mode === 'link' ? winnerSide === this.session?.side : winnerSide === 0;
      title.textContent = this.mode === 'local' ? `P${(winnerSide ?? 0) + 1} WINS` : mineWon ? 'YOU WIN' : 'CPU WINS';
      const score = h('div', 'banner__sub');
      const s = this.match ? this.match.score : (this.session?.buffer.at(-1)?.snap.score ?? [0, 0]);
      score.textContent = `FINAL ${s[0]} — ${s[1]}`;
      plate.append(title, score);
      const actions = h('div', 'banner__actions');
      const rows = ['rematch', 'menu'];
      rows.forEach((id, i) => {
        const btn = h('button', 'lobby__btn', { type: 'button' });
        btn.textContent = id === 'rematch' ? 'REMATCH' : 'MENU';
        if (i === this.menuIndex) btn.dataset.primary = '1';
        btn.addEventListener('click', () => {
          this.audio.ui();
          if (id === 'rematch') this.requestRematch();
          else this.quitToMenu();
        });
        actions.append(btn);
      });
      const note = h('div', 'stat-line');
      note.style.marginTop = '2cqh';
      note.textContent = this.mode === 'link' ? 'Rematch needs both players' : '↑↓ then A';
      panel.append(plate, actions, note);
      ui.append(panel);

      if (this.mode === 'link' && this.screen === 'over') {
        const waiting = h('div', 'stat-line');
        waiting.textContent = '';
        panel.append(waiting);
      }
      return;
    }

    // playing: no overlay; the field itself carries the HUD.
  }

  private activateModeById(id: string): void {
    if (id === 'solo') return this.startOffline('solo');
    if (id === 'local') return this.startOffline('local');
    if (id === 'link') return this.changeScreen('link');
    if (id === 'howto') return this.changeScreen('howto');
    if (id === 'settings') return this.changeScreen('settings');
  }

  private setIndex(i: number): void {
    if (i === this.menuIndex) return;
    this.menuIndex = i;
    this.renderScreen();
  }

  private footLabel(): string {
    if (this.screen === 'playing' || this.screen === 'paused' || this.screen === 'over') return MODE_LABEL[this.mode];
    if (this.screen === 'lobby' || this.screen === 'reconnecting') return 'LINK / FRIEND';
    return 'ATTRACT';
  }

  private footHint(): string {
    switch (this.screen) {
      case 'attract':
        return 'START = MENU';
      case 'playing':
        return 'B = PAUSE';
      case 'lobby':
        return 'SHARE THE CODE';
      case 'over':
        return 'A = REMATCH';
      case 'modes':
        return 'A = SELECT';
      default:
        return 'B = BACK';
    }
  }

  private sessionLabel(): string {
    if (this.mode === 'link' && this.session) return `ROOM ${this.session.code}`;
    if (this.screen === 'playing' || this.screen === 'paused' || this.screen === 'over') return 'P/01';
    return 'P/01';
  }

  private serveLedOn(): boolean {
    if (this.mode === 'link' && this.session) {
      const latest = this.session.buffer.at(-1)?.snap;
      return Boolean(latest && latest.phase === 'countdown' && latest.timer <= 0.05 && latest.server === this.session.side);
    }
    if (this.match) return this.match.phase === 'countdown' && this.match.timer <= 0.05;
    return false;
  }

  private updateRail(): void {
    const refs = this.device.refs;
    refs.railKv.innerHTML = '';
    const rows: [string, string][] = [
      ['STATE', this.screen.toUpperCase()],
      ['MODE', MODE_LABEL[this.mode]],
      ['CPU', this.mode === 'solo' ? LEVEL_LABEL[this.level] : '—'],
      ['LINK', this.mode === 'link' && this.session ? this.session.code : 'offline'],
      ['FPS', String(this.fps)]
    ];
    if (this.mode === 'link' && this.session) {
      rows.push(['SEAT', this.session.side === 0 ? 'P1 HOST' : 'P2 GUEST']);
      rows.push(['FRIEND', this.session.connected[this.session.side === 0 ? 1 : 0] ? 'online' : 'waiting']);
    }
    for (const [k, v] of rows) {
      const div = h('div');
      const dt = h('dt');
      dt.textContent = k;
      const dd = h('dd');
      dd.textContent = v;
      div.append(dt, dd);
      refs.railKv.append(div);
    }
    refs.railMode.textContent = MODE_LABEL[this.mode];
  }

  private async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('LINK COPIED');
    } catch {
      this.showToast(text);
    }
  }

  private showToast(message: string): void {
    const toast = h('div', 'toast');
    toast.textContent = message;
    this.device.refs.ui.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }

  // ---------------------------------------------------------------- test hooks
  /** Deterministic hooks used by the browser test harness. */
  get testApi() {
    return {
      setScreen: (screen: Screen) => {
        this.screen = screen;
        this.renderScreen();
      },
      startSolo: (level: CpuLevel) => {
        this.level = level;
        this.startOffline('solo');
      },
      startLocal: () => this.startOffline('local'),
      openModes: () => this.changeScreen('modes'),
      openSettings: () => this.changeScreen('settings'),
      openHowTo: () => this.changeScreen('howto'),
      openLink: (code: string | null) => this.openLink(code),
      settings: () => this.settings,
      setSound: (on: boolean) => this.setSettings({ ...this.settings, sound: on }),
      simulate: (seconds: number) => {
        if (this.match) {
          const steps = Math.round(seconds * 60);
          for (let i = 0; i < steps; i++) {
            const inputs = this.intentsForOffline();
            stepMatch(this.match, { inputs, serveGate: false });
          }
        }
      },
      match: () => this.match,
      session: () => this.session,
      linkState: () => this.session?.buffer.at(-1)?.snap ?? null,
      inviteCode: () => this.session?.code ?? null,
      screenName: () => this.screen,
      setHeadless: (value: boolean) => {
        this.headless = value;
      },
      isHeadless: () => this.headless
    };
  }
}
