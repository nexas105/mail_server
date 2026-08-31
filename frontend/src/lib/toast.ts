// Toast-Stack ohne React-State: hängt animierte Knoten an einen fixen Container.
type Kind = 'ok' | 'err' | 'info';

const ICONS: Record<Kind, string> = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 8v5"/><circle cx="12" cy="16.6" r=".2"/><circle cx="12" cy="12" r="9.2"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 11v6"/><circle cx="12" cy="7.4" r=".2"/><circle cx="12" cy="12" r="9.2"/></svg>',
};

function container(): HTMLElement {
  let el = document.getElementById('toast-stack');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-stack';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

export function toast(msg: string, kind: Kind = 'ok', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-icon">${ICONS[kind]}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg')!.textContent = msg;
  el.addEventListener('click', () => dismiss());
  container().appendChild(el);
  let closed = false;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // Fallback bei reduced motion
  };
  setTimeout(dismiss, ms);
}
