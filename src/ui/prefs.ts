/**
 * Player preferences kept in localStorage, so a returning player keeps their sound, sail and the
 * look guides they have already seen. Storage is best effort: private browsing or a full quota
 * leaves the defaults in place for the session.
 */
const KEY = 'dinghy.prefs.v1';

export interface Prefs {
  /** Master volume 0..1. */
  volume: number;
  muted: boolean;
  /** Printed sail design id (data/sail-designs.json); null keeps the default. */
  sail: string | null;
  /** Look guides already completed (src/ui/lookGuide.ts target ids). */
  guidesSeen: string[];
}

const DEFAULTS: Prefs = { volume: 0.7, muted: false, sail: null, guidesSeen: [] };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, guidesSeen: [] };
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(Math.max(p.volume, 0), 1) : DEFAULTS.volume,
      muted: p.muted === true,
      sail: typeof p.sail === 'string' ? p.sail : null,
      guidesSeen: Array.isArray(p.guidesSeen) ? p.guidesSeen.filter((g): g is string => typeof g === 'string') : [],
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
