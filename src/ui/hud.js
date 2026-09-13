import { state } from '../state.js';
import { CSS } from './styles.js';

// In-page HUD: the big speed badge for hold-boost plus transient toasts.
// The workspace lives entirely in the Chrome side panel (src/panel/).
let root = null;
let ui = {};
let toastTimer = 0;

export function mount() {
  if (document.getElementById('rv-ext-host')) return;
  const host = document.createElement('div');
  host.id = 'rv-ext-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="hud">
      <div class="badge" id="badge">2×</div>
      <div class="toast" id="toast"></div>
    </div>`;
  (document.body || document.documentElement).appendChild(host);
  root = shadow;
  ui = {
    badge: shadow.getElementById('badge'),
    toast: shadow.getElementById('toast'),
  };
}

export function toast(msg, ms = 1800) {
  if (!ui.toast) return;
  ui.toast.textContent = msg;
  ui.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('on'), ms);
}

export function showSpeedHud(on, dir = 1) {
  if (!ui.badge) return;
  const n = state.holdRate;
  ui.badge.textContent = dir < 0 ? `−${n}×` : `${n}×`;
  ui.badge.classList.toggle('on', !!on);
}
