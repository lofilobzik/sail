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

export function loadPrefs(): Prefs {
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

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: preferences last for this session only.
  }
}
