# 启动/守护 CDP 代理（断线自动重启）
$daemon = 'D:\NimbleWing\VideoAssistant\tools\cdp-daemon.js'
$log = 'C:\Users\ASUS\AppData\Local\Temp\opencode\cdp-daemon.log'

function Test-Daemon {
  try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9223/ping' -TimeoutSec 2; return $r.ok -eq $true } catch { return $false }
}

if (Test-Daemon) {
  Write-Output 'daemon 已在运行'
  exit 0
}

for ($i = 0; $i -lt 5; $i++) {
  $p = Start-Process -FilePath 'node' -ArgumentList $daemon -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
  $ok = $false
  for ($j = 0; $j -lt 24; $j++) {
    Start-Sleep -Milliseconds 500
    if (Test-Daemon) { $ok = $true; break }
    if ($p.HasExited) { break }
  }
  if ($ok) {
    Write-Output "daemon 已启动 (PID $($p.Id))，等待 Chrome 连接确认后即可用"
    exit 0
  }
  Write-Output "第 $($i+1) 次启动未就绪（可能在等确认或已退出，重试）"
}
Write-Output 'daemon 启动失败'; exit 1
