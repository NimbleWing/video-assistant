// 对比 txt 原版 TsRemux 与移植版，找出所有差异行
const fs = require('fs');

const txtLines = fs.readFileSync('D:/NimbleWing/VideoAssistant/肉视频助手-1.1.0.txt', 'utf8').split(/\r?\n/);
const txtBody = txtLines.slice(474, 991).join('\n'); // TsRemux IIFE 部分
const mine = fs.readFileSync('D:/NimbleWing/VideoAssistant/src/hls/ts-remux.js', 'utf8');

const norm = (s) => s.split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length && !l.startsWith('//'))
  .join('\n');

const al = norm(txtBody).split('\n');
const bl = norm(mine).split('\n');

let diffs = 0;
const max = Math.max(al.length, bl.length);
for (let i = 0; i < max; i++) {
  const x = al[i] || '';
  const y = bl[i] || '';
  if (x !== y && diffs < 12) {
    diffs++;
    console.log('L' + (i + 1) + ':');
    console.log('  TXT : ' + x.slice(0, 120));
    console.log('  MINE: ' + y.slice(0, 120));
  }
}
console.log('total diff lines:', diffs, '| txt:', al.length, 'lines | mine:', bl.length, 'lines');
