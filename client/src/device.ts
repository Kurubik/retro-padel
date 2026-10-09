export type Action =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'a'
  | 'b'
  | 'start'
  | 'select'
  | 'hold-up'
  | 'hold-down'
  | 'release';

export interface DeviceRefs {
  console: HTMLElement;
  themeLabel: HTMLElement;
  screen: HTMLElement;
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  ledLink: HTMLElement;
  ledServe: HTMLElement;
  screenTier: HTMLElement;
  screenSession: HTMLElement;
  screenConn: HTMLElement;
  footMode: HTMLElement;
  footHint: HTMLElement;
  rail: HTMLElement;
  railThemeLabel: HTMLElement;
  railKv: HTMLElement;
  railMode: HTMLElement;
  railSub: HTMLElement;
  actionA: HTMLElement;
  actionB: HTMLElement;
}

export type ActionListener = (action: Action, source: 'key' | 'touch' | 'pointer') => void;

export interface Device {
  refs: DeviceRefs;
  onAction(fn: ActionListener): void;
  press(action: Action, source?: 'key' | 'touch' | 'pointer'): void;
  setPressed(element: 'a' | 'b' | 'select' | 'start' | 'up' | 'down' | 'left' | 'right', down: boolean): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  attrs?: Record<string, string>
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function buildDevice(mount: HTMLElement): Device {
  mount.innerHTML = '';
  const listeners: ActionListener[] = [];
  const emit: ActionListener = (a, s) => listeners.forEach((fn) => fn(a, s));

  const workspace = el('div', 'workspace');
  workspace.style.display = 'contents';

  const consoleEl = el('section', 'console', { id: 'console', 'data-phase': 'attract' });

  // ---- marquee ---------------------------------------------------------
  const top = el('div', 'console__top');
  const logo = el('span', 'logo');
  logo.innerHTML = 'RETRO<span class="slash">//</span>PADEL';
  const subsys = el('span', 'chip', { 'aria-hidden': 'true' });
  subsys.textContent = 'SIGNAL/09';
  top.append(logo, subsys);

  // ---- bezel + screen --------------------------------------------------
  const bezel = el('div', 'bezel');
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    bezel.append(el('span', `bezel__tick bezel__tick--${corner}`));
  }
  const screen = el('div', 'screen', { id: 'screen' });
  const canvas = el('canvas', 'screen__canvas', { id: 'screen-canvas', 'aria-label': 'RETRO//PADEL playfield' });
  const crt = el('div', 'screen__crt');
  crt.setAttribute('aria-hidden', 'true');
  const sweep = el('div', 'screen__sweep');
  sweep.setAttribute('aria-hidden', 'true');
  const glare = el('div', 'screen__glare');
  glare.setAttribute('aria-hidden', 'true');

  const bars = el('div', 'screen__bars');
  const barL = el('span', 'screen__bar-l');
  barL.innerHTML = 'RETRO<span class="slash">//</span>PADEL';
  const screenTier = el('span', 'screen__bar-r', { id: 'screen-tier' });
  screenTier.textContent = 'LV.01';
  bars.append(barL, screenTier);

  const barsBottom = el('div', 'screen__bars screen__bars--bottom');
  const screenSession = el('span', 'screen__bar-l', { id: 'screen-session' });
  screenSession.textContent = 'P/01';
  const screenConn = el('span', 'screen__bar-r', { id: 'screen-conn' });
  screenConn.textContent = 'LOCAL';
  screenConn.dataset.state = 'local';
  barsBottom.append(screenSession, screenConn);

  const ui = el('div', 'ui', { id: 'ui' });
  const power = el('div', 'screen__power');
  power.setAttribute('aria-hidden', 'true');
  screen.append(canvas, sweep, crt, glare, bars, barsBottom, ui, power);
  bezel.append(screen);

  const leds = el('div', 'leds');
  leds.setAttribute('aria-hidden', 'true');
  const ledPower = el('span', 'led led--power');
  ledPower.dataset.on = '1';
  const ledLink = el('span', 'led led--link', { id: 'led-link' });
  const ledServe = el('span', 'led led--serve', { id: 'led-serve' });
  leds.append(ledPower, ledLink, ledServe);
  bezel.append(leds);

  // ---- deck ------------------------------------------------------------
  const deck = el('div', 'deck');
  deck.append(el('div', 'pipe'));

  const facts = el('div', 'deck__facts');
  const brand = el('span', 'deck__brand');
  brand.innerHTML = 'RETRO<span class="slash">//</span>PADEL';
  const series = el('span', 'deck__series');
  series.textContent = 'ARCADE SERIES';
  facts.append(brand, series);

  const rule = el('div', 'deck__rule');
  rule.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 10; i++) rule.append(el('i'));

  const controls = el('div', 'deck__controls');

  const pad = el('div', 'pad');
  const dpad = el('div', 'dpad', { role: 'group', 'aria-label': 'Directional pad' });
  const dpadKeys: Record<string, HTMLButtonElement> = {};
  const padDefs: { dir: string; cls: string; label: string }[] = [
    { dir: 'up', cls: 'dpad__key--up', label: 'Up' },
    { dir: 'down', cls: 'dpad__key--down', label: 'Down' },
    { dir: 'left', cls: 'dpad__key--left', label: 'Left' },
    { dir: 'right', cls: 'dpad__key--right', label: 'Right' }
  ];
  for (const def of padDefs) {
    const key = el('button', `dpad__key ${def.cls}`, {
      type: 'button',
      'data-pad': def.dir,
      'aria-label': `D-pad ${def.label}`
    });
    dpadKeys[def.dir] = key;
    dpad.append(key);
  }
  dpad.append(el('span', 'dpad__hub'));
  pad.append(dpad);

  const face = el('div', 'face');
  const mkFaceButton = (cls: string, data: string, letter: string, caption: string, label: string) => {
    const button = el('button', `face__btn ${cls}`, { type: 'button', 'data-btn': data, 'aria-label': label });
    const glyph = el('span', 'face__btn-glyph');
    glyph.textContent = letter;
    const small = el('small');
    small.textContent = caption;
    button.append(glyph, small);
    return button;
  };
  const btnB = mkFaceButton('face__btn--b', 'b', 'B', 'back', 'B button — back or pause');
  const btnA = mkFaceButton('face__btn--a', 'a', 'A', 'action', 'A button — confirm or serve');
  face.append(btnB, btnA);

  const mid = el('div', 'mid');
  const btnSelect = el('button', 'mid__btn', { type: 'button', 'data-btn': 'select', id: 'btn-select' });
  btnSelect.textContent = 'SELECT';
  const btnStart = el('button', 'mid__btn', { type: 'button', 'data-btn': 'start', id: 'btn-start' });
  btnStart.textContent = 'START';
  mid.append(btnSelect, btnStart);

  const speaker = el('div', 'speaker');
  speaker.setAttribute('aria-hidden', 'true');

  controls.append(pad, face, mid, speaker);

  const foot = el('p', 'deck__foot');
  const footMode = el('span', '', { id: 'foot-mode' });
  footMode.textContent = 'ATTRACT';
  const d1 = el('span', 'deck__dot');
  d1.textContent = '•';
  const ver = el('span');
  ver.textContent = 'v1.0.0';
  const d2 = el('span', 'deck__dot');
  d2.textContent = '•';
  const footHint = el('span', '', { id: 'foot-hint' });
  footHint.textContent = 'ENTER = START';
  foot.append(footMode, d1, ver, d2, footHint);

  deck.append(facts, rule, controls, foot);
  consoleEl.append(top, bezel, deck);

  // ---- technical rail (desktop) ---------------------------------------
  const rail = el('aside', 'rail', { id: 'rail', 'aria-label': 'Console status' });
  const railBrand = el('div', 'rail__block');
  const railEyebrow = el('div', 'rail__eyebrow');
  railEyebrow.textContent = 'SIGNAL/09 HANDHELD';
  const railTitle = el('div', 'rail__title');
  railTitle.textContent = 'RETRO//PADEL';
  const railText = el('p', 'rail__text');
  railText.textContent =
    'A private two-paddle duel. First to 7, win by 2, sudden death at 10–10. Built to be played, not watched.';
  railBrand.append(railEyebrow, railTitle, railText);

  const railStatus = el('div', 'rail__block');
  const railStatusHead = el('div', 'rail__eyebrow');
  railStatusHead.textContent = 'STATUS';
  const railKv = el('dl', 'rail__kv', { id: 'rail-kv' });
  railStatus.append(railStatusHead, railKv);

  const railKeys = el('div', 'rail__block');
  const railKeysHead = el('div', 'rail__eyebrow');
  railKeysHead.textContent = 'CONTROLS';
  const keys = el('div', 'rail__keys');
  const keyRows: [string, string][] = [
    ['P1 move', 'W / S'],
    ['P2 move', '↑ / ↓'],
    ['Serve · confirm', 'ENTER / A'],
    ['Pause · back', 'ESC / B'],
    ['Cycle mode', 'SELECT'],
    ['Start match', 'START']
  ];
  for (const [label, k] of keyRows) {
    const row = el('div');
    const span = el('span');
    span.textContent = label;
    const kbd = el('kbd');
    kbd.textContent = k;
    row.append(span, kbd);
    keys.append(row);
  }
  railKeys.append(railKeysHead, keys);

  const railFoot = el('div', 'rail__block');
  const flag = el('span', 'rail__flag');
  flag.append(el('i'), document.createTextNode('NO ACCOUNT · NO TRACKING'));
  railFoot.append(flag);

  rail.append(railBrand, railStatus, railKeys, railFoot);

  workspace.append(consoleEl, rail);
  mount.append(workspace);

  const railMode = el('dd', '', { id: 'rail-mode' });
  railMode.textContent = 'Attract';

  // ---- wiring ----------------------------------------------------------
  const setPressed: Device['setPressed'] = (element, down) => {
    const map: Record<string, HTMLElement | undefined> = {
      a: btnA,
      b: btnB,
      select: btnSelect,
      start: btnStart,
      up: dpadKeys.up,
      down: dpadKeys.down,
      left: dpadKeys.left,
      right: dpadKeys.right
    };
    const node = map[element];
    if (!node) return;
    if (down) {
      node.dataset.pressed = '1';
      node.setAttribute('aria-pressed', 'true');
    } else {
      delete node.dataset.pressed;
      node.setAttribute('aria-pressed', 'false');
    }
  };

  const bindTap = (node: HTMLElement, action: Action) => {
    node.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      node.setPointerCapture?.(ev.pointerId);
      setPressed(action as 'a', true);
      emit(action, 'touch');
    });
    const up = () => setPressed(action as 'a', false);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('lostpointercapture', up);
  };

  for (const def of padDefs) bindTap(dpadKeys[def.dir], def.dir as Action);
  bindTap(btnA, 'a');
  bindTap(btnB, 'b');
  bindTap(btnSelect, 'select');
  bindTap(btnStart, 'start');

  // Held direction state for the physical D-pad.
  const held = new Set<string>();
  for (const def of padDefs) {
    const key = dpadKeys[def.dir];
    key.addEventListener('pointerdown', () => {
      held.add(def.dir);
      emit(def.dir === 'up' ? 'hold-up' : def.dir === 'down' ? 'hold-down' : (def.dir as Action), 'touch');
    });
    const release = () => {
      held.delete(def.dir);
      if (!held.has('up') && !held.has('down')) emit('release', 'touch');
    };
    key.addEventListener('pointerup', release);
    key.addEventListener('pointercancel', release);
    key.addEventListener('lostpointercapture', release);
  }

  return {
    refs: {
      console: consoleEl,
      themeLabel: subsys,
      screen,
      canvas,
      ui,
      ledLink,
      ledServe,
      screenTier,
      screenSession,
      screenConn,
      footMode,
      footHint,
      rail,
      railThemeLabel: railEyebrow,
      railKv,
      railMode,
      railSub: railMode,
      actionA: btnA,
      actionB: btnB
    },
    onAction: (fn) => listeners.push(fn),
    press: (action, source = 'key') => emit(action, source),
    setPressed
  };
}
