# 生成 native messaging host manifest 并写注册表（HKCU，无需管理员）
$ErrorActionPreference = 'Stop'
$d = $PSScriptRoot
$json = @{
  name            = 'com.rouvideo.media'
  description     = 'RouVideo Assistant local media server bootstrap'
  type            = 'stdio'
  path            = Join-Path $d 'native-host.cmd'
  allowed_origins = @('chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm/')
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $d 'com.rouvideo.media.json'), $json)
reg add 'HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rouvideo.media' /ve /t REG_SZ /d (Join-Path $d 'com.rouvideo.media.json') /f | Out-Null
Write-Host 'install ok: com.rouvideo.media ->' (Join-Path $d 'com.rouvideo.media.json')
