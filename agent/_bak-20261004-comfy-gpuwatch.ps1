# Prints one JSON line every few seconds: per-process GPU engine utilization, per-process dedicated VRAM,
# running processes, window titles of GPU-active processes, foreground window info (pid, title, fullscreen?).
# Uses WMI classes (English names on every Windows language), so it works on Chinese Windows and AMD cards.
param([int]$Interval = 4)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class F {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][F]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
while ($true) {
  $util = @{}; $vram = @{}
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object {
    if ($_.Name -match 'pid_(\d+)_.*engtype_(3D|Compute|Graphics|VR)') {
      $id = $Matches[1]; $v = [int]$_.UtilizationPercentage
      if (-not $util.ContainsKey($id) -or $util[$id] -lt $v) { $util[$id] = $v }
    }
  }
  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object {
    if ($_.Name -match 'pid_(\d+)_') { $id = $Matches[1]; $v = [double]$_.DedicatedUsage; if (-not $vram.ContainsKey($id) -or $vram[$id] -lt $v) { $vram[$id] = [math]::Round($v / 1MB) } }
  }
  $procs = @()
  Get-CimInstance Win32_Process | ForEach-Object { $procs += , @([int]$_.ProcessId, [string]$_.Name, [string]$_.ExecutablePath) }
  $titles = @{}
  foreach ($id in (@($util.Keys) + @($vram.Keys) | Select-Object -Unique)) {
    if (($util[$id] -ge 3) -or ($vram[$id] -ge 300)) { $t = (Get-Process -Id ([int]$id)).MainWindowTitle; if ($t) { $titles[$id] = $t } }
  }
  $h = [F]::GetForegroundWindow(); $fpid = 0; $full = $false; $ftitle = ''
  if ($h -ne [IntPtr]::Zero) {
    [void][F]::GetWindowThreadProcessId($h, [ref]$fpid)
    $sb = New-Object System.Text.StringBuilder 300; [void][F]::GetWindowText($h, $sb, 300); $ftitle = $sb.ToString()
    $r = New-Object F+RECT
    if ([F]::GetWindowRect($h, [ref]$r)) { $full = ($r.L -le $b.X) -and ($r.T -le $b.Y) -and ($r.R -ge ($b.X + $b.Width)) -and ($r.B -ge ($b.Y + $b.Height)) }
  }
  $o = @{ util = $util; vram = $vram; titles = $titles; procs = $procs; fg = @{ pid = [int]$fpid; full = $full; title = $ftitle } }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
  Start-Sleep -Seconds $Interval
}
