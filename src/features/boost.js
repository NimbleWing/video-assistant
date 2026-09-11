import { isTypingTarget, pageVideo } from '../core/utils.js';
import { state } from '../state.js';
import { showSpeedHud } from '../ui/hud.js';

// Long-press arrow key boost: hold → Nx forward / rewind, tap → ±5s seek.
const hold = {
  timer: 0,
  rewindTimer: 0,
  active: false,
  dir: 0,
  pendingDir: 0,
  originalRate: 1,
  startedPlay: false,
  resumeAfter: false,
  video: null,
};

function arrowDir(e) {
  if (e.code === 'ArrowRight' || e.key === 'ArrowRight') return 1;
  if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') return -1;
  return 0;
}

function seekBy(video, seconds) {
  try {
    const t = Math.min(video.duration || 1e9, Math.max(0, (video.currentTime || 0) + seconds));
    video.currentTime = t;
  } catch {}
}

function beginBoost(video, dir) {
  if (!video || !dir) return;
  if (hold.active && hold.dir === dir) return;
  if (hold.active) endBoost();
  hold.active = true;
  hold.dir = dir;
  hold.video = video;
  hold.originalRate = video.playbackRate || 1;
  hold.startedPlay = false;
  hold.resumeAfter = false;
  if (dir > 0) {
    hold.startedPlay = video.paused;
    video.playbackRate = state.holdRate;
    if (video.paused) {
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    }
  } else {
    hold.resumeAfter = !video.paused;
    if (!video.paused) {
      try { video.pause(); } catch {}
    }
    const tick = 50;
    hold.rewindTimer = setInterval(() => {
      const v = hold.video || pageVideo();
      if (!v) return;
      seekBy(v, -state.holdRate * (tick / 1000));
    }, tick);
  }
  showSpeedHud(true, dir);
}

export function endBoost() {
  clearTimeout(hold.timer);
  hold.timer = 0;
  hold.pendingDir = 0;
  clearInterval(hold.rewindTimer);
  hold.rewindTimer = 0;
  if (!hold.active) return;
  const v = hold.video || pageVideo();
  const dir = hold.dir;
  if (v) {
    try { v.playbackRate = hold.originalRate || 1; } catch {}
    if (dir > 0 && hold.startedPlay && v.paused === false) {
      try { v.pause(); } catch {}
    }
    if (dir < 0 && hold.resumeAfter && v.paused) {
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    }
  }
  hold.active = false;
  hold.startedPlay = false;
  hold.resumeAfter = false;
  hold.video = null;
  hold.dir = 0;
  showSpeedHud(false);
}

// Called when the user picks a new rate while a boost is active.
export function updateActiveRate(n) {
  if (hold.active && hold.video && hold.dir > 0) hold.video.playbackRate = n;
  showSpeedHud(hold.active, hold.dir || 1);
}

// Returns true when the event was consumed by the boost feature.
export function handleKeyDown(e) {
  if (!state.holdBoost) return false;
  const dir = arrowDir(e);
  if (!dir) return false;
  if (isTypingTarget(e.target)) return false;
  const video = pageVideo();
  if (!video) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat) return true;
  if (hold.active && hold.dir === dir) return true;
  clearTimeout(hold.timer);
  hold.pendingDir = dir;
  hold.timer = setTimeout(() => beginBoost(video, dir), 160);
  return true;
}

export function handleKeyUp(e) {
  const dir = arrowDir(e);
  if (!dir) return false;
  if (!state.holdBoost) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (hold.active && hold.dir && hold.dir !== dir) return true;
  const wasPending = !!hold.timer && !hold.active && hold.pendingDir === dir;
  clearTimeout(hold.timer);
  hold.timer = 0;
  hold.pendingDir = 0;
  if (wasPending) {
    const video = pageVideo();
    if (video) seekBy(video, dir * 5);
    return true;
  }
  if (hold.active && hold.dir === dir) endBoost();
  return true;
}

export function initBoost() {
  window.addEventListener('blur', endBoost);
  document.addEventListener('visibilitychange', () => { if (document.hidden) endBoost(); });
}
