# Watchdog for desktop control. Only active while the desk.active file exists.
# Trigger: hold Ctrl+Alt+End, or throw the mouse into the top-left screen corner.
# Effect: creates the STOP file so the agent halts before its next step.
param([string]$ActiveFile, [string]$StopFile)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class K {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@
[void][K]::SetProcessDPIAware()
while ($true) {
  Start-Sleep -Milliseconds 80
  if (-not (Test-Path -LiteralPath $ActiveFile)) { continue }
  $hot = (([K]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) -and (([K]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0) -and (([K]::GetAsyncKeyState(0x23) -band 0x8000) -ne 0)
  $p = New-Object K+POINT; [void][K]::GetCursorPos([ref]$p)
  if ($hot -or ($p.X -le 3 -and $p.Y -le 3)) { New-Item -ItemType File -Force -Path $StopFile | Out-Null; Remove-Item -LiteralPath $ActiveFile -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800 }
}
