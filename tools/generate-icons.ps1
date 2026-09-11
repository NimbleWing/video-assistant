Add-Type -AssemblyName System.Drawing

$outDir = 'D:\NimbleWing\VideoAssistant\icons'

function New-RvIcon([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  $r = [int]($size * 0.22)
  $d = $r * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $p.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $p.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $p.CloseFigure()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $c1 = [System.Drawing.Color]::FromArgb(255, 255, 90, 147)
  $c2 = [System.Drawing.Color]::FromArgb(255, 225, 29, 90)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 45)
  $g.FillPath($brush, $p)

  $w = [float]([Math]::Max(1.5, $size * 0.09))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $w)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

  $cx = [float]($size / 2)
  $top = [float]($size * 0.22)
  $bottom = [float]($size * 0.60)
  $g.DrawLine($pen, $cx, $top, $cx, $bottom)
  $g.DrawLine($pen, $cx, $bottom, [float]($size * 0.33), [float]($size * 0.44))
  $g.DrawLine($pen, $cx, $bottom, [float]($size * 0.67), [float]($size * 0.44))
  $g.DrawLine($pen, [float]($size * 0.24), [float]($size * 0.78), [float]($size * 0.76), [float]($size * 0.78))

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $brush.Dispose(); $p.Dispose(); $g.Dispose(); $bmp.Dispose()

  $check = [System.Drawing.Image]::FromFile($path)
  Write-Output "$path => $($check.Width)x$($check.Height)"
  $check.Dispose()
}

New-RvIcon 16 (Join-Path $outDir 'icon-16.png')
New-RvIcon 48 (Join-Path $outDir 'icon-48.png')
New-RvIcon 128 (Join-Path $outDir 'icon-128.png')
