param([Parameter(Mandatory=$true)][int]$ProcId)
# List every top-level window of a process with its visibility.
# Process.MainWindowHandle returns 0 once a window is hidden, so it can't answer
# "was it re-shown?" - this enumerates windows directly.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WinList {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder sb, int max);
  public static List<string> List(uint target) {
    var r = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) {
        var sb = new System.Text.StringBuilder(256);
        GetClassName(h, sb, 256);
        r.Add((IsWindowVisible(h) ? "VISIBLE" : "hidden") + " class=" + sb.ToString() + " titleLen=" + GetWindowTextLength(h));
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@
$all = [WinList]::List([uint32]$ProcId)
$vis = @($all | Where-Object { $_ -like 'VISIBLE*' })
Write-Output "windows=$($all.Count) visible=$($vis.Count)"
foreach ($w in $all) { Write-Output "  $w" }
