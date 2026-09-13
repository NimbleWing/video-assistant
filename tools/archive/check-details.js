// 对比指定 mp4 的"详细信息"属性（复刻资源管理器属性页）
const { execSync } = require('child_process');
const path = require('path');

const file = process.argv[2];
const folder = path.dirname(file);
const name = path.basename(file);

const ps = `
$shell = New-Object -ComObject Shell.Application
$ns = $shell.Namespace('${folder.replace(/'/g, "''")}')
$item = $ns.ParseName('${name.replace(/'/g, "''")}')
$map = @{}
for ($i = 0; $i -lt 400; $i++) {
  $h = $ns.GetDetailsOf($null, $i)
  if ($h) { $map[$h] = $i }
}
foreach ($w in @('长度','时长','帧宽度','帧高度','数据速率','帧速率')) {
  if ($map.ContainsKey($w)) {
    Write-Output ($w + ' = [' + $ns.GetDetailsOf($item, $map[$w]) + ']')
  }
}
`;
const b64 = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, { encoding: 'utf8' });
console.log('文件:', name);
console.log(out.trim());
