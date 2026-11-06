param(
  [Parameter(Mandatory=$true)][int]$ProcId,
  [int]$TimeoutMs = 6000
)
# Hide the main window of a GUI process (mpv.net opens one even with --no-video).
# Exits as soon as the window is hidden or already hidden; only waits while no window exists yet.
# Pure ASCII on purpose: no encoding pitfalls.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
  if (-not $p) { Write-Output "gone pid=$ProcId"; exit 1 }
  $p.Refresh()
  $h = $p.MainWindowHandle
  if ($h -ne [IntPtr]::Zero) {
    if ([WinHide]::IsWindowVisible($h)) {
      [void][WinHide]::ShowWindow($h, 0)   # SW_HIDE
      Start-Sleep -Milliseconds 100
      if ([WinHide]::IsWindowVisible($h)) { Write-Output "failed pid=$ProcId"; exit 1 }
      Write-Output "hidden pid=$ProcId"
      exit 0
    }
    Write-Output "already-hidden pid=$ProcId"
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
Write-Output "no-window pid=$ProcId"
exit 0
