import { BATCH_KEY, RATES } from '../core/constants.js';
import { escapeHtml, formatBytes, formatDuration, formatEta } from '../core/utils.js';
import { clearDirHandle, loadDirHandle, probeWritable, saveDirHandle } from '../net/fsdir.js';
import { ICONS } from '../ui/icons.js';

// Side panel workspace. Video state lives in the content script of the active
// rou.video tab (pulled via rv-get-state, pushed via rv-state, commanded via
// rv-cmd); batch state lives in chrome.storage and is subscribed to directly.

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
/** @type {{ name: string | null, path: string | null, granted: boolean | null }} */
let dirState = { name: null, path: null, granted: null }; // 自定义下载目录状态
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

async function pullDir() {
  const h = await loadDirHandle();
  if (!h) { dirState = { name: null, path: null, granted: null }; return; }
  // 用真实写探针判定（queryPermission 对扩展句柄不可靠，两个方向都会虚报）
  /** @type {string | null} */
  let path = null;
  try {
    const flag = (/** @type {Record<string, any>} */ (await chrome.storage.local.get('rv-hud:fsdir')))['rv-hud:fsdir'];
    path = flag?.path || null;
  } catch {}
  dirState = { name: h.name, path, granted: await probeWritable() };
}

async function syncDirFlag() {
  // 供 SW 快速判断是否走自定义目录直查（避免无谓唤醒 offscreen）；
  // path 仅用于面板显示完整路径
  try {
    if (dirState.name) await chrome.storage.local.set({ 'rv-hud:fsdir': { name: dirState.name, path: dirState.path || '' } });
    else await chrome.storage.local.remove('rv-hud:fsdir');
  } catch {}
}

// 浏览器不向页面暴露目录句柄的绝对路径；借一次系统"另存为"对话框
// （保存 2 字节占位到所选文件夹）从下载记录读取绝对路径，随后删除文件。
async function recordDirPath() {
  toast('请在对话框中进入所选文件夹并保存（文件会自动删除）');
  /** @type {number} */
  let id;
  try {
    id = await chrome.downloads.download({
      url: 'data:text/plain;base64,AA==',
      filename: 'rv-path.tmp',
      saveAs: true,
    });
  } catch {
    toast('已取消，路径未记录');
    return;
  }
  const item = await new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.downloads.onChanged.removeListener(listener); resolve(null); }, 5 * 60 * 1000);
    const listener = (/** @type {chrome.downloads.DownloadDelta} */ delta) => {
      if (delta.id !== id || !delta.state) return;
      const st = delta.state.current;
      if (st !== 'complete' && st !== 'interrupted') return;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      chrome.downloads.search({ id }).then(([it]) => resolve(it || null)).catch(() => resolve(null));
    };
    chrome.downloads.onChanged.addListener(listener);
  });
  try { await chrome.downloads.removeFile(id); } catch {}
  try { await chrome.downloads.erase({ id }); } catch {}
  if (!item || !item.filename) { toast('路径记录失败', 4000); return; }
  const abs = item.filename;
  const dir = abs.slice(0, Math.max(abs.lastIndexOf('\\'), abs.lastIndexOf('/')));
  if (dir.split(/[\\/]/).pop() !== dirState.name) {
    toast(`保存位置「${dir.split(/[\\/]/).pop()}」与所选文件夹不一致，未记录`);
    return;
  }
  dirState.path = dir;
  await syncDirFlag();
  toast('完整路径已记录');
  render();
}

function dirHtml() {
  if (!dirState.name) {
    return `
      <div class="dirrow">
        <span class="dirname">浏览器默认下载目录</span>
        <button class="ghost mini" data-bact="pickdir">选择目录…</button>
      </div>`;
  }
  const label = dirState.path || dirState.name;
  const mark = dirState.granted ? '' : '（待重新授权）';
  const authBtn = dirState.granted ? '' : '<button class="ghost mini" data-bact="reauth">重新授权</button>';
  const recBtn = dirState.path ? '' : '<button class="ghost mini" data-bact="recordpath">记录路径</button>';
  return `
    <div class="dirrow">
      <span class="dirname ${dirState.granted ? 'ok' : 'warn'}" title="${escapeHtml(label)}">${escapeHtml(label + mark)}</span>
      ${recBtn}
      ${authBtn}
      <button class="ghost mini" data-bact="pickdir">更换</button>
      <button class="ghost mini" data-bact="cleardir">默认</button>
    </div>`;
}

/** @param {string} act */
async function onDirAction(act) {
  if (act === 'pickdir') {
    try {
      const h = await (/** @type {any} */ (window)).showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' });
      // 重选同一文件夹（同名）时保留已记录的完整路径
      const keepPath = dirState.name === h.name ? dirState.path : null;
      await saveDirHandle(h);
      dirState = { name: h.name, path: keepPath, granted: await probeWritable() };
      await syncDirFlag();
      toast(`下载目录已设为「${h.name}」`);
    } catch (e) {
      if ((/** @type {any} */ (e))?.name !== 'AbortError') toast('选择目录失败: ' + ((/** @type {any} */ (e))?.message || e), 4000);
      await pullDir();
      await syncDirFlag();
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
      const p = await (/** @type {any} */ (h)).requestPermission({ mode: 'readwrite' });
      await pullDir();
      await syncDirFlag();
      toast(p === 'granted' ? '已重新授权' : '未授权');
    } catch (e) {
      toast('授权失败: ' + ((/** @type {any} */ (e))?.message || e), 4000);
    }
    render();
  }
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

// 历史批次报告：暂停原因（note）+ 失败明细 + 针对性修复/重试/继续/清除
function reportHtml() {
  const b = batchState;
  if (!b || b.active) return '';
  const failedN = b.failed?.length || 0;
  const remaining = (b.videoQueue?.length || 0) + (b.seriesQueue?.length || 0) + (b.listingPages?.length || 0);
  if (!b.finishedAt && !b.stoppedAt) return '';
  const head = b.finishedAt
    ? `上次完成：成功 ${b.done} · 失败 ${failedN}`
    : `已暂停：成功 ${b.done} · 失败 ${failedN} · 剩余 ${remaining}`;
  // 暂停原因必须可见（授权失效/未选目录等——否则表现为"没反应"）
  const noteLine = (b.stoppedAt && b.note && b.note !== '已停止（可继续或重试失败项）')
    ? `<div class="batch-s" style="color:var(--warn,#e6a23c)">${escapeHtml(b.note)}</div>`
    : '';
  const failedList = failedN
    ? `<div class="batch-failed">${b.failed.slice(0, 8).map((f) => `<div title="${escapeHtml(f.error || '')}">${escapeHtml((f.name || '').slice(0, 26))} — ${escapeHtml((f.error || '').slice(0, 34))}</div>`).join('')}${failedN > 8 ? `<div>…共 ${failedN} 项</div>` : ''}</div>`
    : '';
  const btns = [];
  // 兼容旧状态（无 stoppedReason）：按 note 文本推断
  const isReauth = b.stoppedReason === 'REAUTH' || (!b.stoppedReason && /授权/.test(b.note || ''));
  const isNoHandle = b.stoppedReason === 'NOHANDLE' || (!b.stoppedReason && /选择下载目录|未选择下载目录/.test(b.note || ''));
  if (isReauth) btns.push('<button class="ghost mini" data-bact="reauth-resume">重新授权并继续</button>');
  if (isNoHandle) btns.push('<button class="ghost mini" data-bact="pickdir">选择下载目录</button>');
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
      <div class="empty">在 rou.video 的页面打开本侧边栏即可使用。<br><br>视频播放页可直接下载；列表根页（剧集库 / 视频库 / 首页 / 搜索页）可连续下载。<br><br>快捷键 <kbd>Alt</kbd>+<kbd>D</kbd></div>`;
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
      <div class="dirbox">${dirHtml()}</div>
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
  const barPct = d?.saving ? Math.max(0, Math.min(100, d.savePct || 0)) : pct; // 保存阶段进度条复用
  const segInfo = stream?.segments ? `<span>·</span><span>${stream.segments} 段</span>` : '';

  const dlLabel = d?.running
    ? (d.saving ? `保存到磁盘 ${Math.round(d.savePct || 0)}% · 点按取消`
      : ((d.pct || 0) >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`))
    : (stream ? '下载视频' : (snap.booting ? '解析中…' : '解析并下载'));
  const holdRate = snap.holdRate;

  app.innerHTML = `
    <div class="head">
      <div class="who">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta"><i class="dot ${st.dot}"></i><span>${st.text}</span>${dur ? `<span>·</span><span>${formatDuration(dur)}</span>` : ''}${segInfo}<span>·</span><span class="ver">v${EXT_VERSION}</span></div>
      </div>
    </div>
    <div class="dirbox">${dirHtml()}</div>
    <button class="dl" data-act="${d?.running ? 'abort' : 'download'}" ${!d?.running && !stream && snap.booting ? 'disabled' : ''}>
      <i class="dl-fill" style="width:${d?.running ? barPct : 0}%"></i>
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
    ${d?.running ? `<div class="stats"><span>${d.done}/${d.total} · ${formatBytes(d.bytes || 0)}</span><span>${d.saving ? '正在写入磁盘…' : `${formatBytes(d.speed || 0)}/s · ${formatEta(d.eta || 0)}`}</span></div>` : ''}
    ${d?.finished && !d.running ? `<div class="ok">${d.skipped ? '本地已存在，已跳过下载' : (dirState.name ? `已保存到「${escapeHtml(dirState.name)}」` : '已保存到浏览器下载目录')}</div>` : ''}
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
  if (fill) fill.style.width = `${d.saving ? Math.max(0, Math.min(100, d.savePct || 0)) : pct}%`;
  if (label) {
    label.textContent = d.saving
      ? `保存到磁盘 ${Math.round(d.savePct || 0)}% · 点按取消`
      : ((d.pct || 0) >= 99 ? '正在封装 MP4…' : `下载中 ${pct.toFixed(0)}% · 点按取消`);
  }
  if (stats) {
    stats.innerHTML = d.saving
      ? `<span>${formatBytes(d.bytes || 0)}</span><span>正在写入磁盘…</span>`
      : `<span>${d.done}/${d.total} · ${formatBytes(d.bytes || 0)}</span><span>${formatBytes(d.speed || 0)}/s · ${formatEta(d.eta || 0)}</span>`;
  } else {
    render();
  }
}

// ------------------------------------------------------------------ 事件

// 请求目录写权限（必须在用户手势内调用；requestPermission 会弹系统授权框）
/** @returns {Promise<boolean>} 是否获得授权 */
async function tryReauth() {
  const h = await loadDirHandle();
  if (!h) return false;
  try {
    const p = await (/** @type {any} */ (h)).requestPermission({ mode: 'readwrite' });
    await pullDir();
    await syncDirFlag();
    if (p !== 'granted') toast('未授权');
    return p === 'granted';
  } catch (e) {
    toast('授权失败: ' + ((/** @type {any} */ (e))?.message || e), 4000);
    return false;
  }
}

// 下载前置：目录可用性检查——没选过则弹选择器；选过但授权失效（浏览器重启会吊销）
// 则借本次点击的手势直接弹重授权，绝大多数场景用户不会再看到 REAUTH 失败
/** @returns {Promise<boolean>} 有可用目录 */
async function ensureDir() {
  if (!dirState.name) {
    toast('请先选择下载目录');
    await onDirAction('pickdir');
    return !!dirState.name;
  }
  if (!dirState.granted) {
    toast('下载目录需要重新授权…');
    if (!(await tryReauth())) {
      toast('未授权，无法下载', 4000);
      return false;
    }
    toast('已重新授权');
    render();
  }
  return true;
}

app.addEventListener('click', async (ev) => {
  const act = (/** @type {HTMLElement | null} */ (ev.target))?.closest('[data-act],[data-bact]');
  if (!act) return;
  const kind = (/** @type {HTMLElement} */ (act)).dataset.act;
  const bkind = (/** @type {HTMLElement} */ (act)).dataset.bact;
  if (kind === 'download') { if (await ensureDir()) cmd('download'); }
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
    if (!(await ensureDir())) return;
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
  } else if (bkind === 'reauth-resume') {
    // 授权失效暂停的一键修复：借点击手势重授权 → 自动继续批次
    toast('请求目录授权…');
    if (await tryReauth()) {
      cmd('batch-resume');
      toast('已重新授权，继续批次');
    }
  } else if (bkind === 'retry') {
    toast('开始重试失败项…');
    cmd('batch-retry');
  } else if (bkind === 'resume') {
    toast('继续剩余项…');
    cmd('batch-resume');
  } else if (bkind === 'clear') {
    cmd('batch-clear');
  } else if (bkind === 'recordpath') {
    recordDirPath();
  } else if (bkind === 'pickdir' || bkind === 'cleardir' || bkind === 'reauth') {
    onDirAction(bkind);
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
