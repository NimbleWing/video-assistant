import { BATCH_KEY, RATES } from '../core/constants.js';
import { escapeHtml, formatBytes, formatDuration, formatEta } from '../core/utils.js';
import { clearDirHandle, dirGranted, loadDirHandle, saveDirHandle } from '../net/fsdir.js';
import { ICONS } from '../ui/icons.js';

// Side panel workspace. Video state lives in the content script of the active
// rou.video tab (pulled via rv-get-state, pushed via rv-state, commanded via
// rv-cmd); batch state lives in chrome.storage and is subscribed to directly.

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer = 0;

let currentTabId = null;
let snap = null;
let batchState = null;
let dirState = { name: null, granted: null }; // 自定义下载目录状态
// Panel-local UI state for batch setup
let modeSel = null;   // 'series' | 'single' | null(=跟随检测结果)
let scopeSel = 'page'; // 'page' | 'all'
let limitVal = '';

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

async function pullBatch() {
  batchState = null;
  try {
    const raw = await chrome.storage.local.get(BATCH_KEY);
    batchState = raw[BATCH_KEY] || null;
  } catch {}
}

async function pullDir() {
  const h = await loadDirHandle();
  const granted = await dirGranted();
  if (!h) dirState = { name: null, granted: null };
  else dirState = { name: h.name, granted: granted === h };
}

async function syncDirFlag() {
  // 供 SW 快速判断是否走自定义目录直查（避免无谓唤醒 offscreen）
  try {
    if (dirState.name) await chrome.storage.local.set({ 'rv-hud:fsdir': { name: dirState.name } });
    else await chrome.storage.local.remove('rv-hud:fsdir');
  } catch {}
}

function dirHtml() {
  if (!dirState.name) {
    return `
      <div class="dirrow">
        <span class="dirname">浏览器默认下载目录</span>
        <button class="ghost mini" data-bact="pickdir">选择目录…</button>
      </div>`;
  }
  if (dirState.granted) {
    return `
      <div class="dirrow">
        <span class="dirname ok">${escapeHtml(dirState.name)}</span>
        <button class="ghost mini" data-bact="pickdir">更换</button>
        <button class="ghost mini" data-bact="cleardir">恢复默认</button>
      </div>`;
  }
  return `
    <div class="dirrow">
      <span class="dirname warn">${escapeHtml(dirState.name)}（待授权，暂存默认目录）</span>
      <button class="ghost mini" data-bact="reauth">重新授权</button>
      <button class="ghost mini" data-bact="cleardir">恢复默认</button>
    </div>`;
}

async function onDirAction(act) {
  if (act === 'pickdir') {
    try {
      const h = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
      await saveDirHandle(h);
      await pullDir();
      await syncDirFlag();
      toast(`下载目录已设为「${h.name}」`);
    } catch (e) {
      if (e?.name !== 'AbortError') toast('选择目录失败: ' + (e?.message || e));
    }
    render();
  } else if (act === 'cleardir') {
    await clearDirHandle();
    await pullDir();
    await syncDirFlag();
    toast('已恢复浏览器默认下载目录');
    render();
  } else if (act === 'reauth') {
    const h = await loadDirHandle();
    if (!h) return;
    try {
      const p = await h.requestPermission({ mode: 'readwrite' });
      await pullDir();
      await syncDirFlag();
      toast(p === 'granted' ? '已重新授权' : '未授权');
    } catch (e) {
      toast('授权失败: ' + (e?.message || e));
    }
    render();
  }
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

// ------------------------------------------------------------------ 连续下载

function batchHtml() {
  const b = batchState;
  if (b?.active) {
    const pending = (b.videoQueue?.length || 0) + (b.seriesQueue?.length || 0) + (b.listingPages?.length || 0);
    return `
      <div class="batch">
        <div class="batch-top">
          <span class="batch-k">连续下载进行中</span>
          <span class="batch-mode">${b.mode === 'series' ? '剧集' : '单片'}</span>
        </div>
        <div class="batch-s">${escapeHtml(b.note || '')}</div>
        <div class="batch-stats"><span>已完成 ${b.done}</span><span>失败 ${b.failed?.length || 0}</span><span>待处理 ${pending}</span></div>
        ${b.failed?.length ? `<div class="batch-failed">跳过：${b.failed.map((f) => escapeHtml(f.name)).join('、')}</div>` : ''}
        <button class="ghost batch-stop" data-bact="stop">停止连续下载</button>
      </div>`;
  }

  const report = b && !b.active && b.finishedAt
    ? `<div class="batch-s">上次完成：成功 ${b.done} · 失败 ${b.failed?.length || 0}</div>`
    : '';

  const det = snap?.listing || null;
  if (!det) {
    return `
      <div class="batch">
        <div class="batch-k">连续下载</div>
        <div class="batch-s">到列表根页（剧集库 / 视频库 / 首页 / 搜索页）可批量收割并连续下载。</div>
        ${report}
      </div>`;
  }

  const kind = modeSel || det.kind || null;
  return `
    <div class="batch">
      <div class="batch-k">连续下载</div>
      <div class="seg2">
        <button data-bact="mode" data-mode="series" class="${kind === 'series' ? 'on' : ''}">剧集</button>
        <button data-bact="mode" data-mode="single" class="${kind === 'single' ? 'on' : ''}">单片</button>
      </div>
      <div class="batch-s">本页 ${det.itemCount} 项 · 共 ${det.totalPage} 页${det.fallback ? '（粗略检测）' : ''}</div>
      <div class="seg2">
        <button data-bact="scope" data-scope="page" class="${scopeSel === 'page' ? 'on' : ''}">仅本页</button>
        <button data-bact="scope" data-scope="all" class="${scopeSel === 'all' ? 'on' : ''}" ${det.totalPage > 1 ? '' : 'disabled'}>全部 ${det.totalPage} 页</button>
      </div>
      <input class="batch-lim" id="batchLimit" type="number" min="1" step="1" placeholder="项数上限（默认不限）" value="${escapeHtml(limitVal)}">
      <button class="dl batch-start" data-bact="start" ${!kind ? 'disabled' : ''}>${ICONS.down}<span>开始连续下载</span></button>
      ${report}
    </div>`;
}

// ------------------------------------------------------------------ 渲染

function render() {
  if (!snap) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手</div>
          <div class="meta"><i class="dot wait"></i><span>未在视频页</span></div>
        </div>
      </div>
      <div class="empty">在 rou.video 的页面打开本侧边栏即可使用。<br><br>视频播放页可直接下载；列表根页（剧集库 / 视频库 / 首页 / 搜索页）可连续下载。<br><br>快捷键 <kbd>Alt</kbd>+<kbd>D</kbd></div>`;
    return;
  }

  const isVideo = snap.path.startsWith('/v/');
  if (!isVideo) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手</div>
          <div class="meta"><i class="dot ${snap.listing ? '' : 'wait'}"></i><span>${snap.listing ? '列表页已就绪' : '打开视频页后可单独下载'}</span></div>
        </div>
      </div>
      <div class="dirbox">${dirHtml()}</div>
      ${batchHtml()}`;
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
    <div class="dirbox">${dirHtml()}</div>
    <button class="dl" data-act="${d?.running ? 'abort' : 'download'}" ${!d?.running && !stream && snap.booting ? 'disabled' : ''}>
      <i class="dl-fill" style="width:${d?.running ? pct : 0}%"></i>
      ${d?.running ? ICONS.abort : ICONS.down}<span>${dlLabel}</span>
    </button>
    <div class="row">
      <button class="ghost" data-act="copy-m3u8" ${!stream ? 'disabled' : ''}>${ICONS.copy}复制地址</button>
      <button class="ghost" data-act="pip">${ICONS.pip}画中画</button>
    </div>
    ${d?.running ? `<div class="stats"><span>${d.done}/${d.total} · ${formatBytes(d.bytes)}</span><span>${formatBytes(d.speed)}/s · ${formatEta(d.eta)}</span></div>` : ''}
    ${d?.finished && !d.running ? `<div class="ok">${d.skipped ? '本地已存在，已跳过下载' : '已保存到浏览器下载目录'}</div>` : ''}
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
    </div>
    ${batchHtml()}`;
}

// Fine-grained progress update without re-rendering (keeps button state).
function renderProgress(d) {
  const pct = Math.max(0, Math.min(100, d.pct || 0));
  const fill = app.querySelector('.dl-fill');
  const label = app.querySelector('.dl:not(.batch-start) span');
  const stats = app.querySelector('.stats');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = d.pct >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`;
  if (stats) {
    stats.innerHTML = `<span>${d.done}/${d.total} · ${formatBytes(d.bytes)}</span><span>${formatBytes(d.speed)}/s · ${formatEta(d.eta)}</span>`;
  } else {
    render();
  }
}

// ------------------------------------------------------------------ 事件

app.addEventListener('click', (ev) => {
  const act = ev.target.closest('[data-act],[data-bact]');
  if (!act) return;
  const kind = act.dataset.act;
  const bkind = act.dataset.bact;
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
  } else if (bkind === 'mode') {
    modeSel = act.dataset.mode;
    render();
  } else if (bkind === 'scope') {
    scopeSel = act.dataset.scope;
    render();
  } else if (bkind === 'start') {
    const mode = modeSel || snap?.listing?.kind;
    if (!mode) return toast('请先选择 剧集 或 单片');
    const limit = Number(limitVal) > 0 ? Number(limitVal) : 0;
    cmd('batch-start', { mode, allPages: scopeSel === 'all', limit });
    toast('连续下载已启动…');
  } else if (bkind === 'stop') {
    cmd('batch-stop');
    toast('正在停止…');
  } else if (bkind === 'pickdir' || bkind === 'cleardir' || bkind === 'reauth') {
    onDirAction(bkind);
  }
});

app.addEventListener('input', (ev) => {
  if (ev.target?.id === 'batchLimit') limitVal = ev.target.value;
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

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' || area === 'local') && changes[BATCH_KEY]) {
    batchState = changes[BATCH_KEY].newValue || null;
    render();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  currentTabId = tabId;
  modeSel = null;
  scopeSel = 'page';
  await pullDir();
  await pull();
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  await pullDir();
  await pullBatch();
  await pull();
}

init();
