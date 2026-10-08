/**
 * Esc menu: the controls and the player's options. Opening it never pauses the sim (the boat is on a
 * shared, running sea). Esc releases the pointer lock, which opens the menu; Resume or a click on the
 * dimmed backdrop locks the pointer again and closes it.
 */
import { BINDINGS, keyLabels } from '../input/bindings';
import { isTypingTarget } from '../input/controls';
import { requestLook } from '../input/mouseLook';
import { formatSailorCode, normalizeSailorCode } from '../net/sailorCode';
import type { ChallengeStatus } from '../net/protocol';
import { CHALLENGES } from './challengeInfo';
import { button, heading, installPanelStyle, row } from './panel';

// Sailing controls and developer tools come from the same bindings used by their input handlers.

export interface MenuOptions {
  /** The canvas that holds the pointer lock. */
  canvas: HTMLElement;
  sailDesigns: readonly { id: string; name: string }[];
  sailDesign: string;
  onSailDesign(id: string): void;
  volume: number;
  muted: boolean;
  onVolume(volume: number): void;
  onMuted(muted: boolean): void;
  /** Respawns the boat (on a server, in the shared room). */
  onRespawn(): void;
  onShowGuidance(): void;
  /** The player's sailor code, when connected to a server; shows the Challenges section once progress arrives. */
  sailor?: { code: string; onRestore(code: string): void };
}

const ESC_UNLOCK_MS = 300; // an Esc this soon after the lock was released is the one that released it

export class Menu {
  private readonly backdrop = document.createElement('div');
  private readonly muteBox: HTMLInputElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly sailSelect = document.createElement('select');
  private readonly challenges = document.createElement('div');
  private readonly challengeSummary = document.createElement('p');
  private locked: ReadonlyMap<string, string> = new Map();
  private isOpen = false;
  private wasLocked = false;
  private unlockedAt = -Infinity;

  constructor(private readonly opts: MenuOptions) {
    installPanelStyle();

    this.backdrop.className = 'dm-backdrop';
    const panel = document.createElement('div');
    panel.className = 'dm-panel';
    this.backdrop.appendChild(panel);
    document.body.appendChild(this.backdrop);
    // A click on the dimmed sea outside the panel goes back to sailing.
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.resume();
    });

    const title = document.createElement('h1');
    const tld = document.createElement('span');
    tld.textContent = '.ing';
    title.append('dinghysail', tld);
    panel.append(title, heading('Controls'), keyList(false));

    panel.appendChild(heading('Options'));
    this.volumeSlider = document.createElement('input');
    this.volumeSlider.type = 'range';
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '1';
    this.volumeSlider.step = '0.05';
    this.volumeSlider.value = String(opts.volume);
    this.volumeSlider.addEventListener('input', () => opts.onVolume(Number(this.volumeSlider.value)));
    this.muteBox = document.createElement('input');
    this.muteBox.type = 'checkbox';
    this.muteBox.checked = opts.muted;
    this.muteBox.addEventListener('change', () => opts.onMuted(this.muteBox.checked));
    const muteLabel = document.createElement('label');
    muteLabel.append(this.muteBox, 'Mute');
    panel.appendChild(row('Sound', this.volumeSlider, muteLabel));

    const select = this.sailSelect;
    this.fillSails(opts.sailDesign);
    select.addEventListener('change', () => opts.onSailDesign(select.value));
    panel.appendChild(row('Sail', select));

    if (opts.sailor) panel.appendChild(this.buildChallenges(opts.sailor));

    const buttons = document.createElement('div');
    buttons.className = 'dm-buttons';
    const resume = button('Resume', () => this.resume());
    resume.classList.add('dm-primary');
    buttons.append(
      resume,
      button('Respawn', () => {
        opts.onRespawn();
        this.resume();
      }),
      button('Reset hints', () => {
        opts.onShowGuidance();
        this.resume();
      }),
    );
    panel.appendChild(buttons);

    const developer = keyList(true);
    developer.classList.add('dm-dev');
    panel.append(heading('Developer'), developer);

    // Esc while the pointer is locked is taken by the browser to release it: that opens the menu.
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === opts.canvas;
      if (locked) this.setOpen(false);
      else if (this.wasLocked) {
        this.setOpen(true);
        this.unlockedAt = performance.now();
      }
      this.wasLocked = locked;
    });
    // Esc with the pointer free (before the first click, or after a failed resume) toggles the menu.
    // Some browsers also deliver the Esc that released the lock: that one must not close the menu again.
    window.addEventListener('keydown', (e) => {
      if (e.code !== BINDINGS.menu.keys.toggle || e.repeat || isTypingTarget(e.target)) return;
      if (performance.now() - this.unlockedAt < ESC_UNLOCK_MS) return;
      if (document.pointerLockElement !== opts.canvas) this.setOpen(!this.open);
    });
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Keeps the checkbox in step when M mutes from the keyboard. */
  setMuted(muted: boolean): void {
    this.muteBox.checked = muted;
  }

  /** Keeps the sail picker in step when the debug panel changes the design. */
  setSailDesign(id: string): void {
    this.sailSelect.value = id;
  }

  /** Shows the Challenges section (hidden until the first call) with the number complete. */
  setChallenges(list: readonly ChallengeStatus[]): void {
    const done = list.filter((c) => c.completedAt !== undefined).length;
    this.challengeSummary.textContent = `${done} of ${CHALLENGES.length} challenges complete. Press J for the log.`;
    this.challenges.style.display = '';
  }

  /** Disables the sails in `locked` (sail id -> title of the challenge that unlocks it). */
  setLockedSails(locked: ReadonlyMap<string, string>): void {
    this.locked = locked;
    this.fillSails(this.sailSelect.value);
  }

  private fillSails(selected: string): void {
    const select = this.sailSelect;
    select.replaceChildren();
    for (const d of this.opts.sailDesigns) {
      const challenge = this.locked.get(d.id);
      const option = new Option(challenge ? `${d.name} (locked: ${challenge})` : d.name, d.id, false, d.id === selected);
      option.disabled = challenge !== undefined;
      select.add(option);
    }
    select.value = selected;
  }

  private buildChallenges(sailor: { code: string; onRestore(code: string): void }): HTMLElement {
    const box = this.challenges;
    box.style.display = 'none';
    const code = document.createElement('p');
    code.className = 'dm-code';
    code.textContent = formatSailorCode(sailor.code);
    const note = document.createElement('p');
    note.className = 'dm-note';
    note.textContent = 'Keep this code to restore your progress on another browser.';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Sailor code';
    input.spellcheck = false;
    input.autocomplete = 'off';
    const error = document.createElement('p');
    error.className = 'dm-error';
    const restore = (): void => {
      const normalized = normalizeSailorCode(input.value);
      if (normalized === null) {
        error.textContent = 'Not a valid code';
        return;
      }
      error.textContent = '';
      sailor.onRestore(normalized);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') restore();
    });
    input.addEventListener('input', () => {
      error.textContent = '';
    });
    box.append(heading('Challenges'), this.challengeSummary, code, note, row('Restore', input, button('Restore', restore)), error);
    return box;
  }

  private setOpen(open: boolean): void {
    this.isOpen = open;
    this.backdrop.style.display = open ? 'flex' : 'none';
  }

  private resume(): void {
    this.setOpen(false);
    // Chrome refuses a new lock for about a second after Esc released one; the click prompt then
    // stays up and the next click on the sea locks it.
    requestLook(this.opts.canvas);
  }
}

function keyList(developer: boolean): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'dm-keys';
  for (const binding of Object.values(BINDINGS)) {
    if (binding.developer !== developer) continue;
    const k = document.createElement('div');
    k.className = 'dm-key';
    k.textContent = keyLabels(binding.keys);
    const a = document.createElement('div');
    a.className = 'dm-action';
    a.textContent = binding.action;
    if ('movement' in binding) {
      const m = binding.movement;
      a.title = [
        `${keyLabels({ forward: m.forward, back: m.back })}: forward / back`,
        `${keyLabels({ left: m.left, right: m.right })}: left / right`,
        `${keyLabels({ up: m.up, down: m.down })}: up / down`,
        `${keyLabels({ left: m.fastLeft, right: m.fastRight })}: fast`,
      ].join('; ');
    }
    grid.append(k, a);
  }
  return grid;
}
