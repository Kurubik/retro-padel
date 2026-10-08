import { FIELD_H, clamp } from '@shared/core/constants.js';
import type { PaddleInput, Side } from '@shared/core/types.js';
import type { Action, Device } from './device.js';

export interface InputContext {
  /** Which side this device drives when the zones are not split. */
  side: Side;
  /** Two independent halves (local 2P) instead of one paddle. */
  split: boolean;
}

interface PointerZone {
  side: Side;
  fieldY: number;
}

const KEY_ACTIONS: Record<string, Action> = {
  Enter: 'a',
  ' ': 'a',
  Escape: 'b',
  Backspace: 'b',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Shift: 'select',
  Tab: 'select'
};

export class InputHub {
  private ctx: InputContext = { side: 0, split: false };
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, PointerZone>();
  private padUp = false;
  private padDown = false;

  constructor(
    private readonly screen: HTMLElement,
    private readonly device: Device
  ) {
    this.bindKeyboard();
    this.bindPointer();
    this.bindGamepadHint();
  }

  setContext(ctx: InputContext): void {
    this.ctx = ctx;
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (!node || !node.tagName) return false;
    const tag = node.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (ev) => {
      if (this.isTypingTarget(ev.target)) return;
      const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      const gameKey = ['w', 's', 'a', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Enter', 'Escape'].includes(key);
      if (gameKey) ev.preventDefault();
      if (ev.repeat) return;
      this.keys.add(key);
      if ((key === 'w' || key === 's') && ev.shiftKey) return;
      const action = KEY_ACTIONS[key];
      if (action) {
        this.device.press(action, 'key');
        this.device.setPressed(action as 'a', true);
        return;
      }
      if (key === 'a') this.device.press('a', 'key');
      if (key === 'b') this.device.press('b', 'key');
      if (key === 'w') this.device.setPressed('up', true);
      if (key === 's') this.device.setPressed('down', true);
      if (key === 'ArrowUp') this.device.setPressed('up', true);
      if (key === 'ArrowDown') this.device.setPressed('down', true);
    });

    window.addEventListener('keyup', (ev) => {
      const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
      this.keys.delete(key);
      if (key === 'a') this.device.setPressed('a', false);
      if (key === 'b') this.device.setPressed('b', false);
      if (key === 'w' || key === 'ArrowUp') this.device.setPressed('up', false);
      if (key === 's' || key === 'ArrowDown') this.device.setPressed('down', false);
      const action = KEY_ACTIONS[key];
      if (action) this.device.setPressed(action as 'a', false);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.padUp = false;
      this.padDown = false;
    });
  }

  private fieldYFromClient(clientY: number): number {
    const rect = this.screen.getBoundingClientRect();
    const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    return clamp(ratio * FIELD_H, 0, FIELD_H);
  }

  private bindPointer(): void {
    const down = (ev: PointerEvent) => {
      const rect = this.screen.getBoundingClientRect();
      const side: Side = this.ctx.split && ev.clientX - rect.left > rect.width / 2 ? 1 : this.ctx.side;
      const zone: PointerZone = { side, fieldY: this.fieldYFromClient(ev.clientY) };
      this.pointers.set(ev.pointerId, zone);
      this.screen.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    };
    const move = (ev: PointerEvent) => {
      const zone = this.pointers.get(ev.pointerId);
      if (!zone) return;
      zone.fieldY = this.fieldYFromClient(ev.clientY);
      ev.preventDefault();
    };
    const up = (ev: PointerEvent) => {
      this.pointers.delete(ev.pointerId);
    };

    this.screen.addEventListener('pointerdown', down);
    this.screen.addEventListener('pointermove', move);
    this.screen.addEventListener('pointerup', up);
    this.screen.addEventListener('pointercancel', up);
    this.screen.addEventListener('lostpointercapture', up);
    this.screen.addEventListener('contextmenu', (ev) => ev.preventDefault());
    this.screen.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false });
  }

  private bindGamepadHint(): void {
    // Gamepad is an optional extra and never replaces touch or keyboard.
    window.addEventListener(
      'gamepadconnected',
      () => {
        this.device.press('select', 'key');
      },
      { once: true }
    );
  }

  /** Set by the device's physical D-pad. */
  notePad(dir: 'up' | 'down' | 'release'): void {
    if (dir === 'up') {
      this.padUp = true;
      this.padDown = false;
    } else if (dir === 'down') {
      this.padDown = true;
      this.padUp = false;
    } else {
      this.padUp = false;
      this.padDown = false;
    }
  }

  private keyDir(up: string[], down: string[]): number {
    let dir = 0;
    for (const k of up) if (this.keys.has(k)) dir -= 1;
    for (const k of down) if (this.keys.has(k)) dir += 1;
    return Math.max(-1, Math.min(1, dir));
  }

  intents(): [PaddleInput, PaddleInput] {
    const out: [PaddleInput, PaddleInput] = [
      { dir: 0, target: null },
      { dir: 0, target: null }
    ];

    if (this.ctx.split) {
      out[0].dir = this.keyDir(['w'], ['s']) + (this.padUp ? -1 : 0) + (this.padDown ? 1 : 0);
      out[1].dir = this.keyDir(['ArrowUp'], ['ArrowDown']);
    } else {
      const side = this.ctx.side;
      const dir =
        this.keyDir(['w', 'ArrowUp'], ['s', 'ArrowDown']) + (this.padUp ? -1 : 0) + (this.padDown ? 1 : 0);
      out[side].dir = Math.max(-1, Math.min(1, dir));
    }

    for (const zone of this.pointers.values()) {
      out[zone.side].target = zone.fieldY;
      out[zone.side].dir = 0;
    }
    return out;
  }

  /** Optional analog gamepad read; returns null when nothing is connected. */
  gamepadIntent(): number | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      const axis = pad.axes[1] ?? 0;
      const up = pad.buttons[12]?.pressed ? -1 : 0;
      const dn = pad.buttons[13]?.pressed ? 1 : 0;
      const value = Math.abs(axis) > 0.18 ? axis : up + dn;
      if (value !== 0) return clamp(value, -1, 1);
    }
    return null;
  }
}
