/**
 * Challenge log (J): every challenge with its steps, progress and reward, in the Esc menu's panel.
 * Read-only: it keeps the pointer lock and never pauses the sim, and Esc (which opens the menu)
 * closes it.
 */
import { BINDINGS } from '../input/bindings';
import { isTypingTarget } from '../input/controls';
import type { ChallengeStatus } from '../net/protocol';
import { CHALLENGES } from './challengeInfo';
import { installPanelStyle } from './panel';

export interface ChallengeLogOptions {
  /** False while something else (the Esc menu) holds the screen. */
  canOpen(): boolean;
  /** Display name of a sail design id. */
  sailName(id: string): string;
}

export class ChallengeLog {
  private readonly layer = document.createElement('div');
  private readonly panel = document.createElement('div');
  private list: ChallengeStatus[] | null = null;
  private isOpen = false;

  constructor(private readonly opts: ChallengeLogOptions) {
    installPanelStyle();
    this.layer.className = 'dm-log-layer';
    this.panel.className = 'dm-panel';
    this.layer.appendChild(this.panel);
    document.body.appendChild(this.layer);

    window.addEventListener('keydown', (e) => {
      if (e.repeat || isTypingTarget(e.target)) return;
      if (e.code === BINDINGS.challenges.keys.toggle) this.setOpen(!this.isOpen && opts.canOpen());
      else if (e.code === BINDINGS.menu.keys.toggle) this.setOpen(false);
    });
    // The pointer lock ending means the menu is opening.
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === null) this.setOpen(false);
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
    for (const c of CHALLENGES) {
      const status = this.list.find((s) => s.id === c.id);
      const reached = status?.steps ?? [];
      const section = document.createElement('div');
      section.className = 'dm-challenge';
      const h = document.createElement('h2');
      h.textContent = c.title;
      section.append(h, paragraph(c.description));

      const grid = document.createElement('div');
      grid.className = 'dm-keys';
      for (const step of c.steps) {
        const name = document.createElement('div');
        name.className = 'dm-key';
        name.textContent = step;
        const state = document.createElement('div');
        const visited = reached.includes(step);
        state.className = visited ? 'dm-action dm-done' : 'dm-action';
        state.textContent = visited ? '\u2713 visited' : '\u25CB not yet';
        grid.append(name, state);
      }
      section.appendChild(grid);

      const count = c.steps.filter((s) => reached.includes(s)).length;
      section.appendChild(paragraph(`${count} / ${c.steps.length}`));
      if (status?.completedAt !== undefined) {
        const done = paragraph(`Completed ${new Date(status.completedAt).toLocaleDateString()}`);
        done.className = 'dm-done';
        section.appendChild(done);
      }
      if (c.reward) {
        const reward = paragraph(`Reward: ${this.opts.sailName(c.reward.id)} sail `);
        const state = document.createElement('span');
        const unlocked = status?.completedAt !== undefined;
        state.className = unlocked ? 'dm-done' : 'dm-locked';
        state.textContent = unlocked ? 'unlocked' : 'locked';
        reward.appendChild(state);
        section.appendChild(reward);
      }
      this.panel.appendChild(section);
    }
  }
}

function paragraph(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}
