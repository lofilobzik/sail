/**
 * Contextual hints: keycaps with a short action, low in the middle of the view, shown while the
 * hint's `when` holds. A hint with `done` retires for good the first time `done` holds, remembered in
 * Prefs (Esc menu "Reset hints" brings it back); `after` holds a hint back until those hints have
 * retired, so hints can form a sequence. Keys come from input/bindings.ts, so they always match the
 * real handlers. To add one, add it to HINTS. Several true at once stack in HINTS order. Where to
 * sail is the tracked quest's job (src/ui/quests.ts), not a hint's. Reads the context only; it never
 * changes the sim.
 */
import buoyData from '../../data/buoys.json';
import laser from '../../data/laser.json';
import { BINDINGS, keyLabelList } from '../input/bindings';
import type { CameraMode } from '../render/scene';
import type { BoatState, Diagnostics } from '../sim';
import { DEG, type Vec2 } from '../sim/frames';
import type { Preferences } from './prefs';

/** What a hint's conditions can read each frame. */
export interface HintContext {
  /** The own boat after this frame's fixed steps. */
  state: Readonly<BoatState>;
  diagnostics: Readonly<Diagnostics>;
  mode: CameraMode;
  /** Id of the tracked quest (src/ui/quests.ts), or null. */
  tracked: string | null;
}

export interface Hint {
  /** Stable id: retired hints are remembered by it (Prefs.hintsDone). */
  id: string;
  /** Keycaps (one per key of a binding) and what they do, a few words. */
  keys: { keys: Readonly<Record<string, string>>; label: string };
  /** Ids of hints that must have retired first. */
  after?: readonly string[];
  /** Shown while this is true. */
  when(ctx: HintContext): boolean;
  /**
   * s that `when` (and the hint's eligibility) must hold without a break before the hint shows, so a
   * passing gust or a deliberate manoeuvre does not flash it; 0 when omitted.
   */
  holdFor?: number;
  /**
   * Retires the hint for good once true; checked every frame, shown or not. `start` is where the
   * boat was when the hint first showed this session (null if it has not), for "part of the way" rules.
   */
  done?(ctx: HintContext, start: Readonly<Vec2> | null): boolean;
}

// luffAmount above this is "luffing", as in the H instruments (debug/hud.ts).
const LUFFING = 0.5;
// deg: with the apparent wind closer to the bow than this the sail luffs even sheeted hard in (the
// rig's luffStartBetaEffDeg), so the answer is steering, not trimming.
const NO_GO_DEG = laser.rig.luffStartBetaEffDeg;
// ms between one hint ending and the next appearing, so they arrive one at a time; TUNING GUESS.
const HINT_GAP_MS = 5000;

const BUOYS = new Map(buoyData.buoys.map((b) => [b.name, b]));

/** Distance from (x, z) to buoy `name`, m. */
function distanceTo(p: Readonly<Vec2>, name: string): number {
  const b = BUOYS.get(name);
  if (!b) throw new Error(`hints: no buoy ${name}`);
  return Math.hypot(b.x - p.x, b.z - p.z);
}

/** done rule: the boat has covered a third of the distance to buoy `name` from where the hint first showed. */
const thirdOfWayTo = (name: string) => (c: HintContext, start: Readonly<Vec2> | null): boolean =>
  start !== null && distanceTo(c.state, name) <= (distanceTo(start, name) * 2) / 3;

const underWay = (c: HintContext): boolean => c.mode === 'cockpit' && !c.state.moored;
const luff = (c: HintContext): number => c.diagnostics.sail?.luffAmount ?? 0;

/** The first sail out of the harbour: cast off, trim, then steer for First sail's first buoy. */
export const HINTS: readonly Hint[] = [
  // Matches the cast-off handler in main.ts: E acts only in the cockpit at a berth.
  {
    id: 'castOff',
    keys: { keys: BINDINGS.castOff.keys, label: 'Cast off' },
    when: (c) => c.mode === 'cockpit' && c.state.moored,
  },
  // W eases, S sheets in; retired the first time the sail draws under way. Only where sheeting can
  // fill the sail (not head to wind), and only once it has luffed for a moment.
  {
    id: 'trim',
    keys: { keys: BINDINGS.sheet.keys, label: 'Trim the sail' },
    holdFor: 1.5,
    when: (c) => underWay(c) && luff(c) > LUFFING && Math.abs(c.diagnostics.apparent.angle) > NO_GO_DEG * DEG,
    done: (c) => !c.state.moored && c.diagnostics.sail !== null && luff(c) <= LUFFING,
  },
  // While First sail is tracked: the quest's ring shows H1; the keys go a third of the way there.
  {
    id: 'steer',
    keys: { keys: BINDINGS.tiller.keys, label: 'Steer to buoy H1' },
    after: ['trim'],
    when: (c) => underWay(c) && c.tracked === 'first-sail',
    done: thirdOfWayTo('H1'),
  },
];

const STYLE = `
@keyframes kh-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.kh-stack{position:fixed;left:50%;top:66%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:10px;
  pointer-events:none;user-select:none;z-index:6;}
.kh-hint{display:none;align-items:center;gap:12px;padding:8px 16px 8px 8px;border-radius:3px;background:rgba(12,16,20,0.72);
  border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.92);
  font:500 18px/1 system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:0.01em;}
.kh-hint.kh-on{display:flex;animation:kh-in 0.25s ease-out;}
.kh-keys{display:flex;gap:4px;}
.kh-key{min-width:34px;height:34px;padding:0 9px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
  border:1px solid rgba(255,255,255,0.45);border-bottom-width:3px;border-radius:3px;background:rgba(255,255,255,0.06);
  color:#fff;font:600 17px/1 system-ui,-apple-system,'Segoe UI',sans-serif;}
`;

export class Hints {
  /** Key hint rows, by HINTS index. */
  private readonly rows: HTMLElement[];
  /** Showing now, by HINTS index (held while the menu covers them). */
  private readonly on: boolean[];
  private readonly done: Set<string>;
  /** Where the boat was when each hint first showed this session (Hint.done's `start`). */
  private readonly start: (Vec2 | null)[];
  /** performance.now() since each hint's condition has held without a break; NaN while it does not. */
  private readonly trueSince: number[];
  /** performance.now() when a hint last stopped showing: no new hint appears for HINT_GAP_MS after. */
  private lastOff = -Infinity;
  private menuWasOpen = false;

  constructor(private readonly prefs: Preferences, private readonly hints: readonly Hint[] = HINTS) {
    this.done = new Set(prefs.value.hintsDone);
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    const stack = document.createElement('div');
    stack.className = 'kh-stack';
    this.rows = hints.map((hint) => {
      const row = document.createElement('div');
      row.className = 'kh-hint';
      const keys = document.createElement('div');
      keys.className = 'kh-keys';
      for (const label of keyLabelList(hint.keys.keys)) {
        const key = document.createElement('kbd');
        key.className = 'kh-key';
        key.textContent = label;
        keys.appendChild(key);
      }
      const text = document.createElement('span');
      text.textContent = hint.keys.label;
      row.append(keys, text);
      stack.appendChild(row);
      return row;
    });
    this.on = hints.map(() => false);
    this.start = hints.map(() => null);
    this.trueSince = hints.map(() => NaN);
    document.body.appendChild(stack);
  }

  /**
   * Once per frame: retires hints whose `done` holds and shows the rest. A hint shows once its
   * condition has held for its `holdFor`. A hint that ends (retired or no longer true) holds every
   * new hint back for HINT_GAP_MS; one already showing stays. The menu only covers hints, so closing
   * it brings them back at once.
   */
  update(ctx: HintContext, menuOpen: boolean): void {
    const now = performance.now();
    let retired = false;
    for (let i = 0; i < this.hints.length; i++) {
      const hint = this.hints[i]!;
      if (hint.done && !this.done.has(hint.id) && hint.done(ctx, this.start[i] ?? null)) {
        this.done.add(hint.id);
        retired = true;
      }
    }
    if (retired) this.prefs.set({ hintsDone: [...this.done] });
    for (let i = 0; i < this.hints.length; i++) {
      const hint = this.hints[i]!;
      const holds = !this.done.has(hint.id) && (hint.after ?? []).every((id) => this.done.has(id)) && hint.when(ctx);
      if (!holds) this.trueSince[i] = NaN;
      else if (Number.isNaN(this.trueSince[i])) this.trueSince[i] = now;
      const wanted = holds && now - this.trueSince[i]! >= (hint.holdFor ?? 0) * 1000;
      const was = this.on[i]!;
      const on = wanted && (was || now - this.lastOff >= HINT_GAP_MS);
      if (was && !on) this.lastOff = now;
      this.on[i] = on;
      if (on && !this.start[i]) this.start[i] = { x: ctx.state.x, z: ctx.state.z };
      if (on !== was || menuOpen !== this.menuWasOpen) this.rows[i]!.classList.toggle('kh-on', on && !menuOpen);
    }
    this.menuWasOpen = menuOpen;
  }

  /** Brings every retired hint back. */
  reset(): void {
    this.done.clear();
    this.start.fill(null);
    this.trueSince.fill(NaN);
    this.lastOff = -Infinity;
    this.prefs.set({ hintsDone: [] });
  }
}
