/**
 * The tracked quest in the top-right corner: its title, the next goal and the distance to it. A
 * reached goal flares white (glow, lit text, a tick popping with a ring), then slides off to the
 * right as the next one slides in; a finished quest shows a flaring "complete" banner before the
 * next quest takes its place. Display only: main.ts picks the quest
 * (src/ui/quests.ts) and reports completions.
 */

export interface TrackerView {
  questId: string;
  title: string;
  /** The open goals in display order; one that disappears was reached and flares away. */
  goals: { step: string; text: string; distance: number }[];
}

const COMPLETE_MS = 2600; // the "complete" banner stays this long before the next quest shows

const STYLE = `
@keyframes qt-in{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}
@keyframes qt-out{0%{opacity:1;transform:none}20%{opacity:1;transform:translateX(-6px)}100%{opacity:0;transform:translateX(160px)}}
@keyframes qt-shine{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes qt-show{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
@keyframes qt-flare{0%{opacity:0;transform:scaleX(0.3)}18%{opacity:1;transform:scaleX(1)}100%{opacity:0;transform:scaleX(1.25)}}
@keyframes qt-lit{0%{color:#fff;text-shadow:0 0 10px #fff,0 0 22px rgba(255,255,255,0.8)}45%{color:#fff;text-shadow:0 0 8px rgba(255,255,255,0.7)}
  100%{color:#8fd19e;text-shadow:none}}
@keyframes qt-pop{0%{transform:scale(0.2)}45%{transform:scale(1.7)}100%{transform:scale(1)}}
@keyframes qt-ring{from{opacity:0.95;transform:translate(-50%,-50%) scale(0.3)}to{opacity:0;transform:translate(-50%,-50%) scale(2.6)}}
.qt{position:fixed;top:16px;right:16px;width:250px;box-sizing:border-box;padding:10px 14px 12px;display:none;overflow:hidden;
  pointer-events:none;user-select:none;z-index:6;border-radius:3px;background:rgba(12,16,20,0.72);
  border:1px solid rgba(255,255,255,0.12);border-left:3px solid #e8c56b;color:rgba(255,255,255,0.92);
  font:500 14px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;}
.qt.qt-on{display:block;animation:qt-show 0.3s ease-out;}
.qt-title{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#e8c56b;margin-bottom:6px;}
.qt-goals{position:relative;min-height:20px;display:flex;flex-direction:column;gap:4px;}
.qt-goal{display:flex;align-items:baseline;gap:8px;white-space:nowrap;}
.qt-goal.qt-enter{animation:qt-in 0.45s ease-out 0.8s both;}
.qt-goal.qt-leave{position:relative;color:#8fd19e;
  animation:qt-lit 0.75s ease-out both,qt-out 0.55s cubic-bezier(.5,0,.9,.4) 0.7s forwards;}
.qt-mark{position:relative;display:inline-block;font-size:10px;color:#e8c56b;}
.qt-leave .qt-mark{color:#fff;font-size:13px;animation:qt-pop 0.45s ease-out both;}
.qt-leave .qt-mark::after{content:'';position:absolute;left:50%;top:50%;width:18px;height:18px;border-radius:50%;
  border:2px solid #fff;box-shadow:0 0 8px #fff;animation:qt-ring 0.6s ease-out forwards;}
.qt-flare{position:absolute;left:-14px;right:-14px;top:-8px;bottom:-8px;pointer-events:none;mix-blend-mode:screen;
  background:radial-gradient(ellipse 60% 70% at 30% 50%,rgba(255,255,255,0.85),rgba(255,255,255,0.3) 40%,transparent 72%);
  transform-origin:30% 50%;animation:qt-flare 0.8s ease-out forwards;}
.qt-text{flex:1;overflow:hidden;text-overflow:ellipsis;}
.qt-goal.qt-collapse{overflow:hidden;transition:height 0.3s ease-in-out,margin-bottom 0.3s ease-in-out;}
.qt-dist{color:rgba(255,255,255,0.55);font-variant-numeric:tabular-nums;}
.qt-goal.qt-complete{color:#8fd19e;font-weight:600;position:relative;animation:qt-in 0.45s ease-out 0.7s both,qt-lit 1.1s ease-out 0.7s both;}
.qt-complete .qt-flare{animation-delay:0.7s;animation-fill-mode:both;}
.qt-shine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,0.4) 50%,transparent 70%);
  animation:qt-shine 0.8s ease-out 0.7s both;}
`;

export class QuestTracker {
  private readonly root = document.createElement('div');
  private readonly title = document.createElement('div');
  private readonly goals = document.createElement('div');
  private questId: string | null = null;
  /** The rows of the open goals, by step name, with the distance text shown. */
  private readonly rows = new Map<string, { row: HTMLElement; dist: HTMLElement; text: string }>();
  /** performance.now() until which the "complete" banner holds the panel. */
  private celebratingUntil = -Infinity;

  constructor() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    this.root.className = 'qt';
    this.title.className = 'qt-title';
    this.goals.className = 'qt-goals';
    this.root.append(this.title, this.goals);
    document.body.appendChild(this.root);
  }

  /** Once per frame; null hides the panel. */
  update(view: TrackerView | null, hidden: boolean): void {
    this.root.classList.toggle('qt-on', !hidden && (view !== null || performance.now() < this.celebratingUntil));
    if (performance.now() < this.celebratingUntil) return;
    if (!view) {
      this.questId = null;
      return;
    }
    const fresh = this.questId !== view.questId;
    if (fresh) {
      // A different quest: start over, no flares.
      this.questId = view.questId;
      this.title.textContent = view.title;
      this.goals.replaceChildren();
      this.rows.clear();
    }
    const open = new Set(view.goals.map((g) => g.step));
    for (const step of [...this.rows.keys()]) if (!open.has(step)) this.leave(step);
    for (const goal of view.goals) {
      if (!this.rows.has(goal.step)) this.add(goal.step, goal.text, !fresh);
      const r = this.rows.get(goal.step)!;
      const d = goal.distance < 1000 ? `${Math.round(goal.distance)} m` : `${(goal.distance / 1000).toFixed(1)} km`;
      if (d !== r.text) r.dist.textContent = r.text = d;
    }
    // Keep the rows in view order (nearest first); move them only when the order changes.
    const order = view.goals.map((g) => this.rows.get(g.step)!.row);
    const current = [...this.goals.children].filter((c) => !c.classList.contains('qt-leave'));
    if (order.some((row, i) => current[i] !== row)) for (const row of order) this.goals.appendChild(row);
  }

  /** `title` was just completed: its last goals flare away and a flaring banner shows before the next quest. */
  complete(title: string): void {
    this.title.textContent = title;
    for (const step of [...this.rows.keys()]) this.leave(step);
    const done = document.createElement('div');
    done.className = 'qt-goal qt-complete';
    done.append('Complete!', flare());
    const shine = document.createElement('div');
    shine.className = 'qt-shine';
    this.goals.append(done);
    this.root.appendChild(shine);
    shine.addEventListener('animationend', () => shine.remove());
    this.questId = null;
    this.celebratingUntil = performance.now() + COMPLETE_MS;
  }

  /** A row for an open goal; `slide` brings it in after any flare (a goal that opened mid-quest). */
  private add(step: string, text: string, slide: boolean): void {
    const row = document.createElement('div');
    row.className = slide ? 'qt-goal qt-enter' : 'qt-goal';
    const mark = document.createElement('span');
    mark.className = 'qt-mark';
    mark.textContent = '\u25C6';
    const label = document.createElement('span');
    label.className = 'qt-text';
    label.textContent = text;
    const dist = document.createElement('span');
    dist.className = 'qt-dist';
    row.append(mark, label, dist);
    this.goals.appendChild(row);
    // Played once: reordering the rows later (a new nearest buoy) must not replay the slide in.
    if (slide) row.addEventListener('animationend', (e) => {
      if (e.target === row && e.animationName === 'qt-in') row.classList.remove('qt-enter');
    });
    this.rows.set(step, { row, dist, text: '' });
  }

  /**
   * A reached goal: a white flare behind it, the text lit white, the mark popping to a tick, then it
   * slides out. It keeps its place meanwhile; only then does it fold away, so the rows below slide up.
   */
  private leave(step: string): void {
    const r = this.rows.get(step);
    if (!r) return;
    this.rows.delete(step);
    const row = r.row;
    row.className = 'qt-goal qt-leave';
    row.querySelector('.qt-mark')!.textContent = '\u2713';
    r.dist.textContent = '';
    row.appendChild(flare());
    // Its children's animations bubble here too: only the slide out ends the row.
    row.addEventListener('animationend', (e) => {
      if (e.target === row && e.animationName === 'qt-out') collapse(row);
    });
  }
}

/**
 * Folds `row` to nothing, the column gap after it included (the negative margin), so the rows below
 * slide up into its place, then removes it.
 */
function collapse(row: HTMLElement): void {
  row.style.height = `${row.offsetHeight}px`;
  row.classList.add('qt-collapse');
  // Start from the measured height: the change to 0 below must be a new frame to transition.
  requestAnimationFrame(() => {
    row.style.height = '0px';
    row.style.marginBottom = '-4px';
  });
  // A hidden tab may never fire transitionend: the timeout removes it either way.
  const done = () => row.remove();
  row.addEventListener('transitionend', (e) => { if (e.propertyName === 'height') done(); });
  setTimeout(done, 600);
}

/** A white flare that bursts behind its parent row and fades. */
function flare(): HTMLElement {
  const f = document.createElement('div');
  f.className = 'qt-flare';
  return f;
}
