/** A short message at the top of the screen, styled like the connection banner (src/net/link.ts). */
const TOAST_GAP_PX = 30; // stacked toasts sit one line apart

export function showToast(text: string, ms = 4000): void {
  const toast = document.createElement('div');
  const stacked = document.querySelectorAll('[data-toast]').length;
  toast.dataset.toast = '';
  toast.style.cssText =
    `position:fixed;top:${40 + stacked * TOAST_GAP_PX}px;left:50%;transform:translateX(-50%);padding:4px 10px;z-index:20;` +
    'background:rgba(0,0,0,0.7);color:#e8e8e8;font:13px/1.35 ui-monospace,monospace;';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), ms);
}
