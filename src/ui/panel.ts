/**
 * The shared look of the left-hand panels: the Esc menu (src/ui/menu.ts) and the challenge log
 * (src/ui/challengeLog.ts).
 */
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
.dm-row input[type=text]{min-width:0;font:inherit;color:inherit;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,0.25);padding:3px 0;}
.dm-buttons{display:flex;gap:8px;margin-top:32px;}
.dm-buttons + h2{margin-top:40px;}
.dm-panel button{font:inherit;font-weight:500;padding:7px 14px;border-radius:3px;border:1px solid rgba(255,255,255,0.22);background:none;color:inherit;cursor:pointer;}
.dm-panel button:hover{border-color:rgba(255,255,255,0.6);}
.dm-panel button.dm-primary{background:#fff;border-color:#fff;color:#0c1014;}
.dm-panel p{margin:4px 0;}
.dm-note{color:rgba(255,255,255,0.65);}
.dm-code{font:600 13px/1.5 ui-monospace,monospace;letter-spacing:0.04em;user-select:all;}
.dm-error{color:#f08a7e;}
.dm-log-layer{position:fixed;inset:0;display:none;pointer-events:none;z-index:19;}
.dm-challenge p{margin:4px 0;color:rgba(255,255,255,0.65);}
.dm-done{color:#8fd19e;}
.dm-locked{color:rgba(255,255,255,0.45);}
`;

const STYLE_ID = 'dm-style';

/** Adds the panel stylesheet once per page. */
export function installPanelStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

/** A labelled options row: label, then up to two controls. */
export function row(label: string, ...controls: HTMLElement[]): HTMLElement {
  const r = document.createElement('div');
  r.className = 'dm-row';
  const l = document.createElement('label');
  l.textContent = label;
  r.append(l, ...controls);
  return r;
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
