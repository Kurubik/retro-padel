export type MotionSetting = 'full' | 'reduced';
export type ContrastSetting = 'standard' | 'high';

export interface Settings {
  sound: boolean;
  motion: MotionSetting;
  contrast: ContrastSetting;
}

const KEY = 'rp.settings.v1';

const DEFAULTS: Settings = { sound: false, motion: 'full', contrast: 'standard' };

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function prefersMoreContrast(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-contrast: more)').matches;
}

export function loadSettings(): Settings {
  const out: Settings = { ...DEFAULTS };
  if (prefersReducedMotion()) out.motion = 'reduced';
  if (prefersMoreContrast()) out.contrast = 'high';
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (typeof parsed.sound === 'boolean') out.sound = parsed.sound;
      if (parsed.motion === 'full' || parsed.motion === 'reduced') out.motion = parsed.motion;
      if (parsed.contrast === 'standard' || parsed.contrast === 'high') out.contrast = parsed.contrast;
    }
  } catch {
    /* storage may be unavailable (private mode / sandbox) — defaults are fine */
  }
  return out;
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* non-fatal */
  }
}

export function applySettings(settings: Settings, root: HTMLElement = document.documentElement): void {
  root.dataset.motion = settings.motion;
  root.dataset.contrast = settings.contrast;
  root.dataset.sound = settings.sound ? 'on' : 'off';
}
