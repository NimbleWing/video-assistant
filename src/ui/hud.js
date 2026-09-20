import { state } from '../state.js';
import { CSS } from './styles.js';

// In-page HUD: the big speed badge for hold-boost, the persistent
// already-downloaded pill, plus transient toasts.
// The workspace lives entirely in the Chrome side panel (src/panel/).
/** @type {{ badge: HTMLElement | null, toast: HTMLElement | null, hit: HTMLElement | null }} */
let ui = { badge: null, toast: null, hit: null };
/** @type {ReturnType<typeof setTimeout> | 0} */
let toastTimer = 0;

/** @returns {void} */
export function mount() {
  if (document.getElementById('rv-ext-host')) return;
  const host = document.createElement('div');
  host.id = 'rv-ext-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style>
    <div class="hud">
      <div class="badge" id="badge">2×</div>
      <div class="toast" id="toast"></div>
      <div class="hit" id="hit"></div>
    </div>`;
  (document.body || document.documentElement).appendChild(host);
  ui = {
    badge: shadow.getElementById('badge'),
    toast: shadow.getElementById('toast'),
    hit: shadow.getElementById('hit'),
  };
}

/**
 * @param {string} msg
 * @param {number} [ms]
 * @returns {void}
 */
export function toast(msg, ms = 1800) {
  const el = ui.toast;
  if (!el) {
    // HUD 未挂载（极端时序）时至少落到控制台，错误不至于完全不可见
    console.warn('[RouVideo]', msg);
    return;
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

/**
 * @param {boolean} on
 * @param {number} [dir] 1 加速 / -1 快退
 * @returns {void}
 */
export function showSpeedHud(on, dir = 1) {
  if (!ui.badge) return;
  const n = state.holdRate;
  ui.badge.textContent = dir < 0 ? `−${n}×` : `${n}×`;
  ui.badge.classList.toggle('on', !!on);
}

/**
 * 播放页右上角常驻的「已下载/未下载」徽标。
 * @param {import('../state.js').LocalHitState | null} hit null/探测中 = 隐藏（避免闪现）
 * @returns {void}
 */
export function showLocalHit(hit) {
  const el = ui.hit;
  if (!el) return;
  if (!hit || hit.checking) {
    el.classList.remove('on');
    return;
  }
  el.textContent = hit.exists ? '已下载' : '未下载';
  el.title = hit.path || (hit.exists ? '本地媒体库已收录' : '本地未找到（含下载历史回退）');
  el.classList.toggle('ok', !!hit.exists);
  el.classList.add('on');
}
