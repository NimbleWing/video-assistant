// 验证剧集子目录文件名拼装逻辑（与 main.js startDownload 保持一致）
import { sanitizeName } from '../src/core/utils.js';

function buildFilename(page) {
  const seriesDir = page?.seriesName ? sanitizeName(page.seriesName) + '/' : '';
  return seriesDir + sanitizeName(page?.name || 'rouvideo') + '.mp4';
}

const cases = [
  {
    page: { name: '暗黑白雪 · 第1集 暗黑白雪：全員惡人無童話 第1集', seriesName: '暗黑白雪' },
    expect: '暗黑白雪/暗黑白雪 · 第1集 暗黑白雪：全員惡人無童話 第1集.mp4',
  },
  {
    page: { name: '女僕咖啡廳的女孩做愛時高潮絕頂像靈魂出竅般沒有反應 [Part2] ', seriesName: '' },
    expect: '女僕咖啡廳的女孩做愛時高潮絕頂像靈魂出竅般沒有反應 [Part2].mp4',
  },
  { page: { name: '普通单片视频' }, expect: '普通单片视频.mp4' },
  {
    page: { name: '剧名带非法字符/第1集', seriesName: '剧:名?带*非法"字符' },
    expect: '剧 名 带 非法 字符/剧名带非法字符 第1集.mp4',
  },
  { page: null, expect: 'rouvideo.mp4' },
];

let pass = 0;
for (const c of cases) {
  const got = buildFilename(c.page);
  const ok = got === c.expect;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(got));
  if (!ok) console.log('  期望: ' + JSON.stringify(c.expect));
  if (ok) pass += 1;
}
console.log(pass + '/' + cases.length + ' 通过');
