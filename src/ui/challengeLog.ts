/**
 * Challenge log (J): every challenge as a card with its steps, progress and reward, in the Esc menu's
 * panel, where the player picks the quest to track. Opening it frees the mouse to click (telling the
 * Esc menu first, so the release does not open it); J, Esc or a click beside the panel closes it and
 * captures the mouse again. The sim keeps running and the keys keep steering.
 */
import { BINDINGS } from '../input/bindings';
import { isTypingTarget } from '../input/controls';
import { requestLook } from '../input/mouseLook';
import type { ChallengeStatus } from '../net/protocol';
import { CHALLENGES } from './challengeInfo';
import { installPanelStyle } from './panel';

export interface ChallengeLogOptions {
  /** The canvas that holds the pointer lock. */
  canvas: HTMLElement;
  /** False while something else (the Esc menu) holds the screen. */
  canOpen(): boolean;
  /** Called just before the log releases the pointer lock, so the menu ignores that release. */
  beforeRelease(): void;
  /** Display name of a sail design id. */
  sailName(id: string): string;
  /** Id of the quest tracked now (src/ui/quests.ts), or null. */
  tracked(): string | null;
  /** The player tracks quest `id`, or nothing (null). */
  onTrack(id: string | null): void;
}

export class ChallengeLog {
  private readonly layer = document.createElement('div');
  private readonly panel = document.createElement('div');
  private list: ChallengeStatus[] | null = null;
  private isOpen = false;
  /** The log released the pointer lock itself and is waiting for that change. */
  private releasing = false;

  constructor(private readonly opts: ChallengeLogOptions) {
    installPanelStyle();
    this.layer.className = 'dm-log-layer';
    this.panel.className = 'dm-panel';
    this.layer.appendChild(this.panel);
    document.body.appendChild(this.layer);
    this.layer.addEventListener('click', (e) => {
      if (e.target === this.layer) this.close();
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat || isTypingTarget(e.target)) return;
      if (e.code === BINDINGS.challenges.keys.toggle) {
        if (this.isOpen) this.close();
        else if (opts.canOpen()) this.openLog();
      } else if (e.code === BINDINGS.menu.keys.toggle && this.isOpen) {
        this.close();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === null && this.releasing) {
        this.releasing = false;
        return;
      }
      // The mouse captured again (a click on the sea), or released by someone else (the menu): close.
      if (this.isOpen) this.setOpen(false);
    });
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** The newest progress; null while challenges are unavailable. */
  setChallenges(list: ChallengeStatus[] | null): void {
    this.list = list;
    if (this.isOpen) this.render();
  }

  private openLog(): void {
    this.setOpen(true);
    if (document.pointerLockElement === this.opts.canvas) {
      this.releasing = true;
      this.opts.beforeRelease();
      document.exitPointerLock();
    }
  }

  private close(): void {
    this.setOpen(false);
    requestLook(this.opts.canvas);
  }

  private setOpen(open: boolean): void {
    this.isOpen = open;
    if (open) this.render();
    this.layer.style.display = open ? 'block' : 'none';
  }

  private render(): void {
    const title = document.createElement('h1');
    const hint = document.createElement('span');
    hint.textContent = '  J to close';
    title.append('Challenges', hint);
    this.panel.replaceChildren(title);
    if (this.list === null) {
      this.panel.appendChild(paragraph('Challenges are not available in this session.'));
      return;
    }
    const tracked = this.opts.tracked();
    for (const c of CHALLENGES) {
      const status = this.list.find((s) => s.id === c.id);
      const reached = status?.steps ?? [];
      const complete = status?.completedAt !== undefined;
      const isTracked = c.id === tracked;
      const card = document.createElement('div');
      card.className = `dm-card${isTracked ? ' dm-tracked' : ''}${complete ? ' dm-complete' : ''}`;

      const head = document.createElement('div');
      head.className = 'dm-card-head';
      const name = document.createElement('span');
      name.className = 'dm-card-title';
      name.textContent = c.title;
      const badge = document.createElement('span');
      badge.className = 'dm-badge';
      badge.textContent = complete ? '\u2713 Complete' : isTracked ? '\u25C6 Tracking' : '';
      head.append(name, badge);
      card.append(head, paragraph(c.description));

      // Steps as chips: reached, the next one (a course in order, otherwise any), still to go.
      const chips = document.createElement('div');
      chips.className = 'dm-steps';
      const next = c.kind === 'course' ? c.steps.find((s) => !reached.includes(s)) : undefined;
      for (const step of c.steps) {
        const chip = document.createElement('span');
        const done = reached.includes(step);
        chip.className = `dm-step${done ? ' dm-step-done' : step === next ? ' dm-step-next' : ''}`;
        chip.textContent = done ? `\u2713 ${step}` : step;
        chips.appendChild(chip);
      }
      card.appendChild(chips);

      const foot = document.createElement('div');
      foot.className = 'dm-card-foot';
      const count = c.steps.filter((s) => reached.includes(s)).length;
      const progress = document.createElement('span');
      progress.textContent = complete && status?.completedAt
        ? `Completed ${new Date(status.completedAt).toLocaleDateString()}`
        : `${count} / ${c.steps.length}`;
      foot.appendChild(progress);
      if (c.reward) {
        const reward = document.createElement('span');
        reward.className = complete ? 'dm-done' : 'dm-locked';
        reward.textContent = `${this.opts.sailName(c.reward.id)} sail ${complete ? 'unlocked' : 'locked'}`;
        foot.appendChild(reward);
      }
      card.appendChild(foot);

      if (!complete) {
        const track = document.createElement('button');
        track.type = 'button';
        track.textContent = isTracked ? 'Untrack' : 'Track';
        if (!isTracked) track.classList.add('dm-primary');
        track.addEventListener('click', () => {
          this.opts.onTrack(isTracked ? null : c.id);
          this.render();
        });
        card.appendChild(track);
      }
      this.panel.appendChild(card);
    }
  }
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}
