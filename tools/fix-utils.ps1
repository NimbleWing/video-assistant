$p = 'D:\NimbleWing\VideoAssistant\src\core\utils.js'
$text = [System.IO.File]::ReadAllText($p)
$ctrlRange = [char]0 + '-' + [char]31
$hasCtrl = $text.Contains($ctrlRange)
Write-Output "hasControlChars=$hasCtrl"
if ($hasCtrl) {
  $target = '[\\/:*?"<>|' + $ctrlRange + ']'
  $replacement = '[\\/:*?"<>|\u0000-\u001f]'
  $fixed = $text.Replace($target, $replacement)
  [System.IO.File]::WriteAllText($p, $fixed, [System.Text.UTF8Encoding]::new($false))
  $check = [System.IO.File]::ReadAllText($p).Contains($ctrlRange)
  Write-Output "afterFix_hasControlChars=$check"
  Write-Output "fixedLine:"
  ([System.IO.File]::ReadAllText($p) -split "`n") | Where-Object { $_ -match 'sanitizeName' -or $_ -match 'u0000' } | ForEach-Object { Write-Output $_ }
}
