# Takes the guide's screenshots (docs/guide/img) on Windows:
#   cargo build --release
#   node scripts/guide-shots/make-workspaces.mjs
#   powershell -NoProfile -File scripts/guide-shots/capture.ps1 [scene ...]
#
# Each scene starts its own copy of the app with --shot (fixed settings,
# nothing saved), captures only that window, then closes only that copy.
param([Parameter(ValueFromRemainingArguments = $true)][string[]] $Scenes)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$exe = Join-Path $root 'target\release\bitviewer.exe'
if (-not (Test-Path $exe)) { $exe = Join-Path $root 'target\debug\bitviewer.exe' }
$shots = Join-Path $root 'docs\guide\shots'
$img = Join-Path $root 'docs\guide\img'

# scene = workspace, window width, height (physical pixels; 1920 x 1290 is
# 1280 x 860 at 150 % scaling)
$plan = [ordered]@{
  'bits-selection' = @('uart.bitview', 1920, 1290)
  'fields'         = @('uart.bitview', 1920, 1290)
  'expr-bar'       = @('uart.bitview', 1920, 1290)
  'compare'        = @('compare.bitview', 1920, 1290)
  'template'       = @('float.bitview', 1920, 1290)
  'export-code'    = @('uart.bitview', 1920, 1290)
  'export-struct'  = @('timer.bitview', 1920, 1290)
  'export-editor'  = @('uart.bitview', 1920, 1290)
  'svd-import'     = @('demo.svd', 1920, 1290)
  'peripheral'     = @('peripheral.bitview', 1920, 1290)
  'search'         = @('uart.bitview', 1920, 1290)
  'locked-bits'    = @('uart.bitview', 1920, 1290)
  'settings'       = @('uart.bitview', 1920, 1290)
  'peripheral-diff' = @('uart.bitview', 1920, 1290)
  'dump-import'    = @('uart.bitview', 1920, 1290)
}
if ($Scenes) { @($plan.Keys) | Where-Object { $Scenes -notcontains $_ } | ForEach-Object { $plan.Remove($_) } }

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class ShotWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  // the visible frame, without the invisible resize border GetWindowRect includes
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out R r, int size);
  public struct R { public int L, T, Rr, B; }
}
'@
[ShotWin]::SetProcessDPIAware() | Out-Null

foreach ($scene in $plan.Keys) {
  $file, $width, $height = $plan[$scene]
  if (-not [IO.Path]::IsPathRooted($file)) { $file = Join-Path $shots $file }
  $p = Start-Process -FilePath $exe -ArgumentList @('--shot', $scene, "`"$file`"") -PassThru -WorkingDirectory $root
  try {
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $p.Refresh(); $h = $p.MainWindowHandle }
    if ($h -eq [IntPtr]::Zero) { Write-Warning "${scene}: no window"; continue }
    # on top, at the scene's size; then let it stage (shots.rs waits ~0.8 s)
    [ShotWin]::SetWindowPos($h, [IntPtr](-1), 40, 40, $width, $height, 0x0040) | Out-Null
    Start-Sleep -Milliseconds 2500
    $r = New-Object ShotWin+R
    if ([ShotWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [ShotWin]::GetWindowRect($h, [ref]$r) | Out-Null }
    $bmp = New-Object System.Drawing.Bitmap ($r.Rr - $r.L), ($r.B - $r.T)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
    $out = Join-Path $img "$scene.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    "{0,-15} {1} x {2}" -f $scene, ($r.Rr - $r.L), ($r.B - $r.T)
  } finally {
    # only the copy started here
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
}
