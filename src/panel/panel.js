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
 * @property {import('../state.js').LocalHitState | null} downloaded
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

// ------------------------------------------------------------------ 本地库心跳
// 面板页面享有 host_permissions 豁免，可直连本地服务（内容脚本才需 SW 中转）。
// null = 探测中；{videos} = 在线；false = 离线。
/** @type {null | false | { videos: number }} */
let srv = null;

function srvInfo() {
  const off = srv === false;
  const cls = srv === null ? 'wait' : (srv ? '' : 'err');
  const txt = srv === null ? '本地库…' : (srv ? `本地库在线 · ${srv.videos}` : '本地库离线 · 点击启动');
  const tip = srv ? '本地媒体库运行中（127.0.0.1:17321）· 点击打开管理页' : (off ? '点击经 native messaging 启动本地服务；或手动运行 server/start.bat' : '探测中');
  return { cls, txt, tip, off };
}

function srvBadge() {
  const i = srvInfo();
  return `<span class="srv-s"${i.off ? ' data-act="srv-start" role="button"' : (srv ? ' data-act="srv-open" role="button"' : '')} title="${i.tip}"><i class="dot ${i.cls}"></i>${i.txt}</span>`;
}

// 重启按钮：仅在线可用（离线时点指示灯本身就是启动）；pingServer 轮询同步禁用态
function srvRestartBtn() {
  return `<button type="button" class="srv-r" data-act="srv-restart" title="重启本地服务"${srv ? '' : ' disabled'}>⟳</button>`;
}

/** 探测服务是否在线（不更新指示灯状态，重启编排用）。 */
async function pingOk() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('http://127.0.0.1:17321/api/ping', { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    return !!j?.ok;
  } catch {
    return false;
  }
}

async function pingServer() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch('http://127.0.0.1:17321/api/ping', { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    srv = j?.ok ? { videos: Number(j.videos) || 0 } : false;
  } catch {
    srv = false;
  }
  // 轮询结果只更新指示灯本身，避免整页重渲打断交互
  const i = srvInfo();
  for (const el of document.querySelectorAll('.srv-s')) {
    /** @type {HTMLElement} */ (el).title = i.tip;
    if (i.off) el.setAttribute('data-act', 'srv-start');
    else if (srv) el.setAttribute('data-act', 'srv-open');
    else el.removeAttribute('data-act');
    el.innerHTML = `<i class="dot ${i.cls}"></i>${i.txt}`;
  }
  for (const b of document.querySelectorAll('.srv-r')) {
    /** @type {HTMLButtonElement} */ (b).disabled = !srv;
  }
}

// 新标签页打开管理页（在线指示灯点击）
function openSrvPage() {
  chrome.tabs.create({ url: 'http://127.0.0.1:17321/' });
}

// native messaging 引导启动本地服务（需先运行 server/install-native.bat）
async function startSrvFromPanel() {
  toast('正在启动本地服务…', 5000);
  try {
    const r = await chrome.runtime.sendNativeMessage('com.rouvideo.media', { cmd: 'start' });
    if (!r?.ok) throw new Error(r?.error || 'native host 无应答');
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      await pingServer();
      if (srv) { toast('本地库服务已启动'); return; }
    }
    throw new Error('服务未在 10 秒内上线');
  } catch (e) {
    toast(`启动失败：${String(/** @type {Error} */ (e).message)}（可手动运行 server/start.bat）`, 6000);
  }
}

// 重启本地服务（分两段编排，避免双实例撞 17321 端口）：
// shutdown → 轮询确认离线（≤3s）→ 复用 native start 链路拉起（含上线轮询与提示）。
// shutdown 非成功必须中止——旧版本服务无此接口（404）时若继续走启动段，
// 新实例会撞端口静默退出、旧进程继续应答 ping，形成「假启动成功」。
/** @type {boolean} */
let restarting = false;
async function restartServer() {
  if (restarting) return;
  restarting = true;
  toast('正在重启本地服务…', 5000);
  try {
    try {
      const r = await fetch('http://127.0.0.1:17321/api/shutdown', { method: 'POST' });
      if (!r.ok) {
        toast(`重启失败：运行中的服务版本过旧（无重启接口，HTTP ${r.status}）——请手动结束旧服务进程后重新启动`, 8000);
        return;
      }
    } catch {
      toast('重启失败：无法连接本地服务——可点击指示灯直接启动', 6000);
      return;
    }
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 500));
      if (!(await pingOk())) break;
    }
    await startSrvFromPanel();
  } finally {
    restarting = false;
  }
}

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

// 失败项名 → 可点击跳转对应播放页
/** @param {import('../features/batch.js').BatchFailedItem} f */
function failedLink(f) {
  return `<a class="flink" href="https://rou.video/v/${encodeURIComponent(f.id)}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a>`;
}

// 待处理分类展示：三个队列单位不同（视频/集=个、剧集=部、翻页=页），直接求和无参考价值
/** @param {import('../features/batch.js').BatchState} b */
function pendingText(b) {
  const v = b.videoQueue?.length || 0;
  const s = b.seriesQueue?.length || 0;
  const p = b.listingPages?.length || 0;
  const parts = [];
  if (v) parts.push(`${b.mode === 'series' ? '集' : '视频'} ${v}`);
  if (s) parts.push(`剧集 ${s}`);
  if (p) parts.push(`翻页 ${p}`);
  return parts.length ? parts.join(' · ') : '0';
}

// 历史批次报告：暂停原因（note）+ 失败明细 + 重试/继续/清除
function reportHtml() {
  const b = batchState;
  if (!b || b.active) return '';
  const failedN = b.failed?.length || 0;
  const remaining = (b.videoQueue?.length || 0) + (b.seriesQueue?.length || 0) + (b.listingPages?.length || 0);
  if (!b.finishedAt && !b.stoppedAt) return '';
  const skippedN = b.skipped || 0;
  const head = b.finishedAt
    ? `上次完成：新下 ${b.done - skippedN} · 跳过 ${skippedN} · 失败 ${failedN}`
    : `已暂停：新下 ${b.done - skippedN} · 跳过 ${skippedN} · 失败 ${failedN} · 剩余 ${pendingText(b)}`;
  // 暂停原因必须可见（否则表现为"没反应"）
  const noteLine = (b.stoppedAt && b.note && b.note !== '已停止（可继续或重试失败项）')
    ? `<div class="batch-s" style="color:var(--warn,#e6a23c)">${escapeHtml(b.note)}</div>`
    : '';
  const failedList = failedN
    ? `<div class="batch-failed">${b.failed.slice(0, 8).map((f) => `<div title="${escapeHtml(f.error || '')}">${failedLink(f)} — ${escapeHtml((f.error || '').slice(0, 34))}</div>`).join('')}${failedN > 8 ? `<div>…共 ${failedN} 项</div>` : ''}</div>`
    : '';
  const btns = [];
  if (failedN) btns.push(`<button class="ghost mini" data-bact="retry">重试失败 (${failedN})</button>`);
  if (b.stoppedAt && remaining) btns.push(`<button class="ghost mini" data-bact="resume">继续剩余 (${remaining})</button>`);
  btns.push('<button class="ghost mini" data-bact="clear">清除记录</button>');
  return `<div class="batch-report"><div class="batch-s">${head}</div>${noteLine}${failedList}<div class="batch-btns">${btns.join('')}</div></div>`;
}

// 本地媒体库账本失败项重试（跨会话持久，与批次记录无关）
const ledgerRetryBtn = '<button class="ghost mini" data-bact="retry-ledger" style="margin-top:6px">重试历史失败（本地库账本）</button>';

function batchHtml() {
  const b = batchState;
  if (b?.active) {
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
        <div class="batch-stats"><span>新下 ${b.done - (b.skipped || 0)}</span><span>跳过 ${b.skipped || 0}</span><span>失败 ${b.failed?.length || 0}</span><span>待处理 ${pendingText(b)}</span></div>
        <div class="batch-btns">
          <button class="ghost mini" data-bact="spawn">恢复后台下载</button>
          <button class="ghost mini" data-bact="stop">停止连续下载</button>
        </div>
        ${b.failed?.length ? `<div class="batch-failed">${b.failed.map((f) => `<div title="${escapeHtml(f.error || '')}">${failedLink(f)} — ${escapeHtml((f.error || '').slice(0, 34))}</div>`).join('')}</div>` : ''}
      </div>`;
  }

  const det = snap?.listing || null;
  if (!det) {
    return `
      <div class="batch">
        <div class="batch-k">连续下载</div>
        <div class="batch-s">到列表根页（剧集库 / 视频库 / 首页 / 搜索页）可批量收割并连续下载。</div>
        ${reportHtml()}
        ${ledgerRetryBtn}
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
      ${ledgerRetryBtn}
    </div>`;
}

// ------------------------------------------------------------------ 渲染

function render() {
  if (!snap) {
    app.innerHTML = `
      <div class="head">
        <div class="who">
          <div class="title">肉视频助手 <span class="ver">v${EXT_VERSION}</span></div>
          <div class="meta"><i class="dot wait"></i><span>未在视频页</span>${srvBadge()}${srvRestartBtn()}</div>
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
          <div class="meta"><i class="dot ${snap.listing ? '' : 'wait'}"></i><span>${snap.listing ? '列表页已就绪' : '打开视频页后可单独下载'}</span>${srvBadge()}${srvRestartBtn()}</div>
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
  // 已下载探测 chip：探测中/下载进行中不显示（避免闪现与口径混乱）
  const hit = snap.downloaded;
  const hitChip = hit && !hit.checking && !d?.running
    ? `<span>·</span><span class="hit${hit.exists ? ' ok' : ''}" title="${escapeHtml(hit.path || (hit.exists ? '本地媒体库已收录（路径未知，历史回退命中）' : '本地媒体库与下载历史均未命中'))}">${hit.exists ? '已下载' : '未下载'}</span>`
    : '';

  const dlLabel = d?.running
    ? ((d.pct || 0) >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`)
    : (stream ? '下载视频' : (snap.booting ? '解析中…' : '解析并下载'));
  const holdRate = snap.holdRate;

  app.innerHTML = `
    <div class="head">
      <div class="who">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta"><i class="dot ${st.dot}"></i><span>${st.text}</span>${dur ? `<span>·</span><span>${formatDuration(dur)}</span>` : ''}${segInfo}${hitChip}<span>·</span>${srvBadge()}${srvRestartBtn()}<span>·</span><span class="ver">v${EXT_VERSION}</span></div>
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
    ${d?.finished && !d.running && d.skipped ? '<button class="ghost" data-act="download-force" style="width:100%;margin-top:6px">仍然下载（忽略本地已存在判定）</button>' : ''}
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
  else if (kind === 'download-force') cmd('download-force');
  else if (kind === 'srv-start') startSrvFromPanel();
  else if (kind === 'srv-open') openSrvPage();
  else if (kind === 'srv-restart') restartServer();
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
  } else if (bkind === 'retry-ledger') {
    toast('查询本地库失败项…');
    cmd('batch-retry-ledger');
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
  // 本地库心跳：打开期间 30s 轮询（面板关闭即停，无后台占用）
  pingServer();
  setInterval(pingServer, 30 * 1000);
}

init();
