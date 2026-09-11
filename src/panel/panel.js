import { RATES } from '../core/constants.js';
import { escapeHtml, formatBytes, formatDuration, formatEta } from '../core/utils.js';
import { ICONS } from '../ui/icons.js';

// Side panel workspace. All state lives in the content script of the active
// rou.video tab; this panel pulls a snapshot on open, subscribes to pushes,
// and sends commands back.

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer = 0;

let currentTabId = null;
let snap = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
}

async function pull() {
  snap = null;
  if (currentTabId != null) {
    try {
      snap = await chrome.tabs.sendMessage(currentTabId, { type: 'rv-get-state' });
    } catch {
      snap = null; // active tab is not a matched rou.video page
    }
  }
  render();
}

function cmd(name, value) {
  if (currentTabId == null) return;
  chrome.tabs.sendMessage(currentTabId, { type: 'rv-cmd', cmd: name, value }).catch(() => {});
}

function currentStream() {
  return snap?.qualities?.[0] || null;
}

function statusLabel() {
  if (snap.download?.running) return { text: snap.download.pct >= 99 ? '封装 MP4…' : '下载中', dot: 'wait' };
  if (snap.qualities?.length) return { text: '已就绪', dot: '' };
  if (snap.booting) return { text: '解析中…', dot: 'wait' };
  return { text: '未解析', dot: 'err' };
}

function render() {
  if (!snap) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手</div>
          <div class="meta"><i class="dot wait"></i><span>未在视频页</span></div>
        </div>
      </div>
      <div class="empty">在 rou.video 的任意 <code>/v/…</code> 播放页打开本侧边栏，即可解析并下载当前视频。<br><br>页面上可使用快捷键 <kbd>Alt</kbd>+<kbd>D</kbd>，或点击浏览器工具栏中的扩展图标打开本面板。</div>`;
    return;
  }

  const isVideo = snap.path.startsWith('/v/');
  if (!isVideo) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手</div>
          <div class="meta"><i class="dot wait"></i><span>打开视频页后可用</span></div>
        </div>
      </div>
      <div class="empty">打开任意 <code>/v/…</code> 视频页后，这里可以直接下载。<br><br>快捷键 <kbd>Alt</kbd>+<kbd>D</kbd></div>`;
    return;
  }

  const d = snap.download;
  const stream = currentStream();
  const st = statusLabel();
  const dur = stream?.duration || snap.page?.duration || 0;
  const title = snap.page?.name || '当前视频';
  const pct = d?.running ? Math.max(0, Math.min(100, d.pct || 0)) : 0;
  const segInfo = stream?.segments ? `<span>·</span><span>${stream.segments} 段</span>` : '';

  const dlLabel = d?.running
    ? (d.pct >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`)
    : (stream ? '下载视频' : (snap.booting ? '解析中…' : '解析并下载'));

  app.innerHTML = `
    <div class="head">
      <div class="who">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta"><i class="dot ${st.dot}"></i><span>${st.text}</span>${dur ? `<span>·</span><span>${formatDuration(dur)}</span>` : ''}${segInfo}</div>
      </div>
    </div>
    <button class="dl" data-act="${d?.running ? 'abort' : 'download'}" ${!d?.running && !stream && snap.booting ? 'disabled' : ''}>
      <i class="dl-fill" style="width:${d?.running ? pct : 0}%"></i>
      ${d?.running ? ICONS.abort : ICONS.down}<span>${dlLabel}</span>
    </button>
    <div class="row">
      <button class="ghost" data-act="copy-m3u8" ${!stream ? 'disabled' : ''}>${ICONS.copy}复制地址</button>
      <button class="ghost" data-act="pip">${ICONS.pip}画中画</button>
    </div>
    ${d?.running ? `<div class="stats"><span>${d.done}/${d.total} · ${formatBytes(d.bytes)}</span><span>${formatBytes(d.speed)}/s · ${formatEta(d.eta)}</span></div>` : ''}
    ${d?.finished && !d.running ? '<div class="ok">已保存到浏览器下载目录</div>' : ''}
    ${!stream && !snap.booting ? '<button class="ghost" data-act="rescan" style="width:100%;margin-top:8px">重新解析</button>' : ''}
    <div class="boost">
      <div class="boost-top">
        <div>
          <div class="boost-k">长按方向键倍速</div>
          <div class="boost-s">长按右加速、长按左快退；轻点左右仍是进退 5 秒</div>
        </div>
        <button class="sw ${snap.holdBoost ? 'on' : ''}" data-act="toggle-boost" aria-pressed="${snap.holdBoost}"><i></i></button>
      </div>
      <div class="seg">
        ${RATES.map((n) => `<button data-act="rate" data-rate="${n}" class="${snap.holdRate === n ? 'on' : ''}">${n}×</button>`).join('')}
      </div>
    </div>`;
}

// Fine-grained progress update without re-rendering (keeps button state).
function renderProgress(d) {
  const pct = Math.max(0, Math.min(100, d.pct || 0));
  const fill = app.querySelector('.dl-fill');
  const label = app.querySelector('.dl span');
  const stats = app.querySelector('.stats');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = d.pct >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`;
  if (stats) {
    stats.innerHTML = `<span>${d.done}/${d.total} · ${formatBytes(d.bytes)}</span><span>${formatBytes(d.speed)}/s · ${formatEta(d.eta)}</span>`;
  } else {
    render();
  }
}

app.addEventListener('click', (ev) => {
  const act = ev.target.closest('[data-act]');
  if (!act) return;
  const kind = act.dataset.act;
  if (kind === 'download') cmd('download');
  else if (kind === 'abort') cmd('abort');
  else if (kind === 'rescan') { toast('正在解析…'); cmd('rescan'); }
  else if (kind === 'pip') cmd('pip');
  else if (kind === 'toggle-boost') cmd('toggle-boost');
  else if (kind === 'rate') cmd('rate', Number(act.dataset.rate));
  else if (kind === 'copy-m3u8') {
    const q = currentStream();
    if (!q) return toast('还没有解析到地址');
    navigator.clipboard.writeText(q.url)
      .then(() => toast('已复制'))
      .catch(() => toast('复制失败'));
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'rv-state') return;
  if (sender.tab?.id !== currentTabId) return;
  const wasRunning = snap?.download?.running;
  snap = message.state;
  const isRunning = snap?.download?.running;
  // During active downloads update only the progress bits to avoid flicker.
  if (wasRunning && isRunning) renderProgress(snap.download);
  else render();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  currentTabId = tabId;
  await pull();
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  await pull();
}

init();
