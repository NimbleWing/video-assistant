import { BATCH_KEY, RATES } from '../core/constants.js';
import { escapeHtml, formatBytes, formatDuration, formatEta } from '../core/utils.js';
import { ICONS } from '../ui/icons.js';

// Side panel workspace. Video state lives in the content script of the active
// rou.video tab (pulled via rv-get-state, pushed via rv-state, commanded via
// rv-cmd); batch state lives in chrome.storage and is subscribed to directly.
// 落盘统一走浏览器下载目录（chrome.downloads），无自定义目录功能。

/**
 * @typedef {Object} Snapshot
 * @property {string} path
 * @property {boolean} booting
 * @property {boolean} ready
 * @property {{ name: string, duration: number } | null} page
 * @property {{ label: string, url: string, height: number, duration: number, segments: number }[]} qualities
 * @property {number} selectedHeight
 * @property {number} qualityHeight
 * @property {import('../state.js').DownloadUiState | null} download
 * @property {boolean} holdBoost
 * @property {number} holdRate
 * @property {import('../features/batch.js').ListingInfo | null} listing
 */

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const toastEl = /** @type {HTMLElement} */ (document.getElementById('toast'));

// 版本号直接读 manifest——面板所见即真实安装版本
const EXT_VERSION = chrome.runtime.getManifest().version;
/** @type {ReturnType<typeof setTimeout> | 0} */
let toastTimer = 0;

/** @type {number | null} */
let currentTabId = null;
/** @type {Snapshot | null} */
let snap = null;
/** @type {import('../features/batch.js').BatchState | null} */
let batchState = null;
// Panel-local UI state for batch setup
/** @type {'series' | 'single' | null} */
let modeSel = null;   // null = 跟随检测结果
/** @type {'page' | 'all'} */
let scopeSel = 'page';
let limitVal = '';

/**
 * @param {string} msg
 * @param {number} [ms]
 */
function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), ms);
}

async function pull() {
  snap = null;
  if (currentTabId != null) {
    try {
      snap = /** @type {Snapshot} */ (await chrome.tabs.sendMessage(currentTabId, { type: 'rv-get-state' }));
    } catch {
      snap = null; // active tab is not a matched rou.video page
    }
  }
  render();
}

async function pullBatch() {
  batchState = null;
  try {
    const raw = /** @type {Record<string, any>} */ (await chrome.storage.local.get(BATCH_KEY));
    batchState = raw[BATCH_KEY] || null;
  } catch {}
}

/**
 * @param {string} name
 * @param {any} [value]
 */
function cmd(name, value) {
  if (currentTabId == null) return;
  chrome.tabs.sendMessage(currentTabId, { type: 'rv-cmd', cmd: name, value }).catch(() => {});
}

function currentStream() {
  const qs = snap?.qualities || [];
  return qs.find((q) => q.height === snap?.selectedHeight) || qs[0] || null;
}

/** @param {Snapshot} s */
function statusLabel(s) {
  if (s.download?.running) return { text: (s.download.pct || 0) >= 99 ? '封装 MP4…' : '下载中', dot: 'wait' };
  if (s.qualities?.length) return { text: '已就绪', dot: '' };
  if (s.booting) return { text: '解析中…', dot: 'wait' };
  return { text: '未解析', dot: 'err' };
}

// ------------------------------------------------------------------ 连续下载

// 历史批次报告：暂停原因（note）+ 失败明细 + 重试/继续/清除
function reportHtml() {
  const b = batchState;
  if (!b || b.active) return '';
  const failedN = b.failed?.length || 0;
  const remaining = (b.videoQueue?.length || 0) + (b.seriesQueue?.length || 0) + (b.listingPages?.length || 0);
  if (!b.finishedAt && !b.stoppedAt) return '';
  const head = b.finishedAt
    ? `上次完成：成功 ${b.done} · 失败 ${failedN}`
    : `已暂停：成功 ${b.done} · 失败 ${failedN} · 剩余 ${remaining}`;
  // 暂停原因必须可见（否则表现为"没反应"）
  const noteLine = (b.stoppedAt && b.note && b.note !== '已停止（可继续或重试失败项）')
    ? `<div class="batch-s" style="color:var(--warn,#e6a23c)">${escapeHtml(b.note)}</div>`
    : '';
  const failedList = failedN
    ? `<div class="batch-failed">${b.failed.slice(0, 8).map((f) => `<div title="${escapeHtml(f.error || '')}">${escapeHtml((f.name || '').slice(0, 26))} — ${escapeHtml((f.error || '').slice(0, 34))}</div>`).join('')}${failedN > 8 ? `<div>…共 ${failedN} 项</div>` : ''}</div>`
    : '';
  const btns = [];
  if (failedN) btns.push(`<button class="ghost mini" data-bact="retry">重试失败 (${failedN})</button>`);
  if (b.stoppedAt && remaining) btns.push(`<button class="ghost mini" data-bact="resume">继续剩余 (${remaining})</button>`);
  btns.push('<button class="ghost mini" data-bact="clear">清除记录</button>');
  return `<div class="batch-report"><div class="batch-s">${head}</div>${noteLine}${failedList}<div class="batch-btns">${btns.join('')}</div></div>`;
}

function batchHtml() {
  const b = batchState;
  if (b?.active) {
    const pending = (b.videoQueue?.length || 0) + (b.seriesQueue?.length || 0) + (b.listingPages?.length || 0);
    // 停滞检测：批次活着但长时间无推进（工作标签页被关/扩展出错）时给出可见提示
    const staleMs = Date.now() - (b.updatedAt || Date.now());
    const stale = staleMs > 90 * 1000;
    return `
      <div class="batch">
        <div class="batch-top">
          <span class="batch-k">连续下载进行中（后台标签页）</span>
          <span class="batch-mode">${b.mode === 'series' ? '剧集' : '单片'}</span>
        </div>
        <div class="batch-s">${escapeHtml(b.note || '')}</div>
        ${stale ? `<div class="batch-s" style="color:var(--warn,#e6a23c)">长时间无推进——可点"恢复后台下载"重开工作标签页</div>` : ''}
        <div class="batch-stats"><span>已完成 ${b.done}</span><span>失败 ${b.failed?.length || 0}</span><span>待处理 ${pending}</span></div>
        ${b.failed?.length ? `<div class="batch-failed">跳过：${b.failed.map((f) => escapeHtml(f.name)).join('、')}</div>` : ''}
        <div class="batch-btns">
          <button class="ghost mini" data-bact="spawn">恢复后台下载</button>
          <button class="ghost mini" data-bact="stop">停止连续下载</button>
        </div>
      </div>`;
  }

  const det = snap?.listing || null;
  if (!det) {
    return `
      <div class="batch">
        <div class="batch-k">连续下载</div>
        <div class="batch-s">到列表根页（剧集库 / 视频库 / 首页 / 搜索页）可批量收割并连续下载。</div>
        ${reportHtml()}
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
      ${reportHtml()}
    </div>`;
}

// ------------------------------------------------------------------ 渲染

function render() {
  if (!snap) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手 <span class="ver">v${EXT_VERSION}</span></div>
          <div class="meta"><i class="dot wait"></i><span>未在视频页</span></div>
        </div>
      </div>
      <div class="empty">在 rou.video 的页面打开本侧边栏即可使用。<br><br>视频播放页可直接下载；列表根页（剧集库 / 视频库 / 首页 / 搜索页）可连续下载。<br><br>文件保存到浏览器下载目录（可在 Chrome 设置中更改位置）。快捷键 <kbd>Alt</kbd>+<kbd>D</kbd></div>`;
    return;
  }

  const isVideo = snap.path.startsWith('/v/');
  if (!isVideo) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手 <span class="ver">v${EXT_VERSION}</span></div>
          <div class="meta"><i class="dot ${snap.listing ? '' : 'wait'}"></i><span>${snap.listing ? '列表页已就绪' : '打开视频页后可单独下载'}</span></div>
        </div>
      </div>
      ${batchHtml()}`;
    return;
  }

  const d = snap.download;
  const stream = currentStream();
  const st = statusLabel(snap);
  const dur = stream?.duration || snap.page?.duration || 0;
  const title = snap.page?.name || '当前视频';
  const qualities = snap.qualities;
  const selectedHeight = snap.selectedHeight;
  const pct = d?.running ? Math.max(0, Math.min(100, d.pct || 0)) : 0;
  const segInfo = stream?.segments ? `<span>·</span><span>${stream.segments} 段</span>` : '';

  const dlLabel = d?.running
    ? ((d.pct || 0) >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`)
    : (stream ? '下载视频' : (snap.booting ? '解析中…' : '解析并下载'));
  const holdRate = snap.holdRate;

  app.innerHTML = `
    <div class="head">
      <div class="who">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta"><i class="dot ${st.dot}"></i><span>${st.text}</span>${dur ? `<span>·</span><span>${formatDuration(dur)}</span>` : ''}${segInfo}<span>·</span><span class="ver">v${EXT_VERSION}</span></div>
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
    ${qualities.length > 1 ? `
    <div class="boost">
      <div class="boost-k">清晰度</div>
      <div class="seg">
        ${qualities.map((q) => `<button data-act="quality" data-height="${q.height}" class="${selectedHeight === q.height ? 'on' : ''}">${escapeHtml(q.label || (q.height ? `${q.height}p` : '源'))}</button>`).join('')}
      </div>
    </div>` : ''}
    ${d?.running ? `<div class="stats"><span>${d.done}/${d.total} · ${formatBytes(d.bytes || 0)}</span><span>${formatBytes(d.speed || 0)}/s · ${formatEta(d.eta || 0)}</span></div>` : ''}
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
        ${RATES.map((n) => `<button data-act="rate" data-rate="${n}" class="${holdRate === n ? 'on' : ''}">${n}×</button>`).join('')}
      </div>
    </div>
    ${batchHtml()}`;
}

// Fine-grained progress update without re-rendering (keeps button state).
/** @param {import('../state.js').DownloadUiState} d */
function renderProgress(d) {
  const pct = Math.max(0, Math.min(100, d.pct || 0));
  const fill = /** @type {HTMLElement | null} */ (app.querySelector('.dl-fill'));
  const label = app.querySelector('.dl:not(.batch-start) span');
  const stats = app.querySelector('.stats');
  if (fill) fill.style.width = `${pct}%`;
  if (label) {
    label.textContent = (d.pct || 0) >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`;
  }
  if (stats) {
    stats.innerHTML = `<span>${d.done}/${d.total} · ${formatBytes(d.bytes || 0)}</span><span>${formatBytes(d.speed || 0)}/s · ${formatEta(d.eta || 0)}</span>`;
  } else {
    render();
  }
}

// ------------------------------------------------------------------ 事件

app.addEventListener('click', (ev) => {
  const act = (/** @type {HTMLElement | null} */ (ev.target))?.closest('[data-act],[data-bact]');
  if (!act) return;
  const kind = (/** @type {HTMLElement} */ (act)).dataset.act;
  const bkind = (/** @type {HTMLElement} */ (act)).dataset.bact;
  if (kind === 'download') cmd('download');
  else if (kind === 'abort') cmd('abort');
  else if (kind === 'rescan') { toast('正在解析…'); cmd('rescan'); }
  else if (kind === 'pip') cmd('pip');
  else if (kind === 'toggle-boost') cmd('toggle-boost');
  else if (kind === 'rate') cmd('rate', Number((/** @type {HTMLElement} */ (act)).dataset.rate));
  else if (kind === 'quality') cmd('quality', Number((/** @type {HTMLElement} */ (act)).dataset.height));
  else if (kind === 'copy-m3u8') {
    const q = currentStream();
    if (!q) return toast('还没有解析到地址');
    navigator.clipboard.writeText(q.url)
      .then(() => toast('已复制'))
      .catch(() => toast('复制失败', 4000));
  } else if (bkind === 'mode') {
    modeSel = /** @type {'series' | 'single'} */ ((/** @type {HTMLElement} */ (act)).dataset.mode);
    render();
  } else if (bkind === 'scope') {
    scopeSel = /** @type {'page' | 'all'} */ ((/** @type {HTMLElement} */ (act)).dataset.scope);
    render();
  } else if (bkind === 'start') {
    const mode = modeSel || snap?.listing?.kind;
    if (!mode) return toast('请先选择 剧集 或 单片');
    const limit = Number(limitVal) > 0 ? Number(limitVal) : 0;
    cmd('batch-start', { mode, allPages: scopeSel === 'all', limit });
    toast('连续下载已在后台标签页启动…');
    // 启动自检：内容脚本侧 startBatch 抛错只会在页面 HUD 提示，面板复查兜底
    setTimeout(async () => {
      await pullBatch();
      if (!batchState?.active) toast('批次未能启动——请查看页面上的错误提示', 4000);
      else render();
    }, 1000);
  } else if (bkind === 'stop') {
    cmd('batch-stop');
    toast('正在停止…');
  } else if (bkind === 'spawn') {
    cmd('batch-spawn');
    toast('正在恢复后台标签页…');
  } else if (bkind === 'retry') {
    toast('开始重试失败项…');
    cmd('batch-retry');
  } else if (bkind === 'resume') {
    toast('继续剩余项…');
    cmd('batch-resume');
  } else if (bkind === 'clear') {
    cmd('batch-clear');
  }
});

app.addEventListener('input', (ev) => {
  const t = /** @type {HTMLInputElement | null} */ (ev.target);
  if (t?.id === 'batchLimit') limitVal = t.value;
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'rv-state') return;
  if (sender.tab?.id !== currentTabId) return;
  const wasRunning = snap?.download?.running;
  const ns = /** @type {Snapshot} */ (message.state);
  snap = ns;
  // During active downloads update only the progress bits to avoid flicker.
  if (wasRunning && ns.download?.running) renderProgress(ns.download);
  else render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' || area === 'local') && changes[BATCH_KEY]) {
    batchState = /** @type {import('../features/batch.js').BatchState | null} */ (changes[BATCH_KEY].newValue || null);
    render();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  currentTabId = tabId;
  modeSel = null;
  scopeSel = 'page';
  await pull();
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  await pullBatch();
  await pull();
}

init();
