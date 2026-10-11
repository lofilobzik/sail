/**
 * Player preferences kept in localStorage, so a returning player keeps their sound, sail and the
 * look guides they have already seen. Storage is best effort: private browsing or a full quota
 * leaves the defaults in place for the session.
 */
import { normalizeSailorCode } from '../net/sailorCode';
import type { Quality } from '../render/quality';

const KEY = 'dinghy.prefs.v1';

export interface Prefs {
  /** Master volume 0..1. */
  volume: number;
  muted: boolean;
  /** Mouse-look speed multiplier, LOOK_SENSITIVITY_MIN..MAX (1 = default). */
  lookSensitivity: number;
  /** Graphics preset: 'auto' picks from the GPU (render/quality.ts detectQuality); applies on the next load. */
  graphics: 'auto' | Quality;
  /** Printed sail design id (data/sail-designs.json); null keeps the default. */
  sail: string | null;
  /** Look guides already completed (src/ui/lookGuide.ts target ids). */
  guidesSeen: string[];
  /** Sailor code (src/net/sailorCode.ts) that keeps challenge progress on the server; null until generated. */
  player: string | null;
}

export const LOOK_SENSITIVITY_MIN = 0.25;
export const LOOK_SENSITIVITY_MAX = 4;

const DEFAULTS: Prefs = { volume: 0.7, muted: false, lookSensitivity: 1, graphics: 'auto', sail: null, guidesSeen: [], player: null };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, guidesSeen: [] };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(Math.max(p.volume, 0), 1) : DEFAULTS.volume,
      muted: p.muted === true,
      lookSensitivity: typeof p.lookSensitivity === 'number' && Number.isFinite(p.lookSensitivity)
        ? Math.min(Math.max(p.lookSensitivity, LOOK_SENSITIVITY_MIN), LOOK_SENSITIVITY_MAX) : DEFAULTS.lookSensitivity,
      graphics: p.graphics === 'low' || p.graphics === 'high' ? p.graphics : 'auto',
      sail: typeof p.sail === 'string' ? p.sail : null,
      guidesSeen: Array.isArray(p.guidesSeen) ? p.guidesSeen.filter((g): g is string => typeof g === 'string') : [],
      player: typeof p.player === 'string' ? normalizeSailorCode(p.player) : null,
    };
  } catch {
    return { ...DEFAULTS, guidesSeen: [] };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: preferences last for this session only.
  }
}

/**
 * The live preferences: every change is saved and announced, so the sound, the menu and the debug
 * panel follow one source instead of each updating the others by hand.
 */
export class Preferences {
  private data = loadPrefs();
  private readonly listeners: ((prefs: Readonly<Prefs>) => void)[] = [];

  get value(): Readonly<Prefs> {
    return this.data;
  }

  set(patch: Partial<Prefs>): void {
    this.data = { ...this.data, ...patch };
    savePrefs(this.data);
    for (const listener of this.listeners) listener(this.data);
  }

  /** `listener` runs after every change, not at subscription; read `value` for the starting state. */
  subscribe(listener: (prefs: Readonly<Prefs>) => void): void {
    this.listeners.push(listener);
  }
}
