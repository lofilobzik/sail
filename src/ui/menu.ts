/**
 * Esc menu: the controls and the player's options. Opening it never pauses the sim (the boat is on a
 * shared, running sea). Esc releases the pointer lock, which opens the menu; Resume or a click on the
 * dimmed backdrop locks the pointer again and closes it.
 */
import { BINDINGS, keyLabels } from '../input/bindings';
import { isTypingTarget } from '../input/controls';
import { requestLook } from '../input/mouseLook';

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
}

const ESC_UNLOCK_MS = 300; // an Esc this soon after the lock was released is the one that released it

const STYLE = `
.dm-backdrop{position:fixed;inset:0;display:none;background:rgba(0,0,0,0.3);z-index:20;}
.dm-panel{position:absolute;left:0;top:0;bottom:0;width:min(380px,100vw);overflow:auto;box-sizing:border-box;padding:40px 36px;
  background:rgba(12,16,20,0.86);color:rgba(255,255,255,0.92);font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;}
.dm-panel h1{margin:0 0 28px;font-size:15px;font-weight:600;letter-spacing:0.01em;}
.dm-panel h1 span{font-weight:400;color:rgba(255,255,255,0.5);}
.dm-panel h2{margin:28px 0 10px;font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.45);}
.dm-keys{display:grid;grid-template-columns:64px 1fr;gap:5px 12px;}
.dm-key{font-weight:600;white-space:pre;}
.dm-action{color:rgba(255,255,255,0.65);}
.dm-dev{opacity:0.55;}
.dm-row{display:grid;grid-template-columns:64px 1fr auto;gap:12px;align-items:center;margin:8px 0;}
.dm-row label{color:rgba(255,255,255,0.65);}
.dm-row input[type=range]{width:100%;accent-color:#fff;}
.dm-row input[type=checkbox]{accent-color:#fff;margin:0 6px 0 0;vertical-align:-2px;}
.dm-row select{grid-column:2 / 4;font:inherit;color:inherit;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,0.25);padding:3px 0;}
.dm-row select option{color:#000;}
.dm-buttons{display:flex;gap:8px;margin-top:32px;}
.dm-buttons + h2{margin-top:40px;}
.dm-panel button{font:inherit;font-weight:500;padding:7px 14px;border-radius:3px;border:1px solid rgba(255,255,255,0.22);background:none;color:inherit;cursor:pointer;}
.dm-panel button:hover{border-color:rgba(255,255,255,0.6);}
.dm-panel button.dm-primary{background:#fff;border-color:#fff;color:#0c1014;}
`;

export class Menu {
  private readonly backdrop = document.createElement('div');
  private readonly muteBox: HTMLInputElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly sailSelect = document.createElement('select');
  private isOpen = false;
  private wasLocked = false;
  private unlockedAt = -Infinity;

  constructor(private readonly opts: MenuOptions) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

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
    for (const d of opts.sailDesigns) select.add(new Option(d.name, d.id, false, d.id === opts.sailDesign));
    select.addEventListener('change', () => opts.onSailDesign(select.value));
    panel.appendChild(row('Sail', select));

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

function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
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

function row(label: string, ...controls: HTMLElement[]): HTMLElement {
  const r = document.createElement('div');
  r.className = 'dm-row';
  const l = document.createElement('label');
  l.textContent = label;
  r.append(l, ...controls);
  return r;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
