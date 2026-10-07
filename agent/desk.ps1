param([string]$Action, [string]$A1, [string]$A2, [string]$A3, [string]$A4, [string]$A5)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { keybd_event(0x0D, 0, 0, UIntPtr.Zero); keybd_event(0x0D, 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(15); continue; }
      INPUT[] a = new INPUT[2];
      a[0].type = 1; a[0].ki.wScan = c; a[0].ki.dwFlags = 4;
      a[1].type = 1; a[1].ki.wScan = c; a[1].ki.dwFlags = 6;
      SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(8);
    }
  }
}
"@
[void][W]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

function Title { $sb = New-Object System.Text.StringBuilder 512; [void][W]::GetWindowText([W]::GetForegroundWindow(), $sb, 512); $sb.ToString() }
function Out($o) { $o | ConvertTo-Json -Compress }
function Click($x, $y, $btn, $n) {
  [void][W]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 40
  if ($btn -eq 'right') { $d = 0x8; $u = 0x10 } else { $d = 0x2; $u = 0x4 }
  for ($i = 0; $i -lt $n; $i++) { [W]::mouse_event($d, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [W]::mouse_event($u, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
}
$VK = @{ enter = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; backspace = 0x08; delete = 0x2E; space = 0x20; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22 }
for ($i = 1; $i -le 12; $i++) { $VK["f$i"] = 0x6F + $i }

function Invoke-Act($Action, $A1, $A2, $A3, $A4, $A5) {
  switch ($Action) {
    'info' { $p = New-Object W+POINT; [void][W]::GetCursorPos([ref]$p); Out @{ w = $b.Width; h = $b.Height; cx = $p.X; cy = $p.Y; title = (Title) } }
    'title' { Out @{ title = (Title) } }
    'shot' {
      # A1=output file, A2=max width, A3=optional region "x,y,w,h" in physical pixels
      $maxw = [int]$A2; if ($maxw -le 0) { $maxw = 1280 }
      $rx = $b.X; $ry = $b.Y; $rw = $b.Width; $rh = $b.Height
      if ($A3) { $r = $A3.Split(',') | ForEach-Object { [int]$_ }; $rx = $b.X + $r[0]; $ry = $b.Y + $r[1]; $rw = $r[2]; $rh = $r[3] }
      $bmp = New-Object System.Drawing.Bitmap $rw, $rh
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($rx, $ry, 0, 0, $bmp.Size); $g.Dispose()
      $sw = [Math]::Min($maxw, $rw); $sh = [int][Math]::Round($rh * $sw / $rw)
      $sm = New-Object System.Drawing.Bitmap $sw, $sh
      $g2 = [System.Drawing.Graphics]::FromImage($sm); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $sw, $sh); $g2.Dispose()
      $sm.Save($A1, [System.Drawing.Imaging.ImageFormat]::Png); $sm.Dispose(); $bmp.Dispose()
      Out @{ w = $b.Width; h = $b.Height; sw = $sw; sh = $sh; title = (Title) }
    }
    'move' { [void][W]::SetCursorPos([int]$A1, [int]$A2); Out @{ ok = $true } }
    'click' { $n = 1; if ($A4) { $n = [int]$A4 }; Click $A1 $A2 $A3 $n; Out @{ ok = $true; title = (Title) } }
    'scroll' { [void][W]::SetCursorPos([int]$A1, [int]$A2); Start-Sleep -Milliseconds 40; [W]::mouse_event(0x800, 0, 0, [int]$A3, [UIntPtr]::Zero); Out @{ ok = $true } }
    'drag' {
      $x1 = [int]$A1; $y1 = [int]$A2; $x2 = [int]$A3; $y2 = [int]$A4
      [void][W]::SetCursorPos($x1, $y1); Start-Sleep -Milliseconds 60; [W]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
      for ($i = 1; $i -le 12; $i++) { [void][W]::SetCursorPos([int]($x1 + ($x2 - $x1) * $i / 12), [int]($y1 + ($y2 - $y1) * $i / 12)); Start-Sleep -Milliseconds 20 }
      Start-Sleep -Milliseconds 60; [W]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero); Out @{ ok = $true; title = (Title) }
    }
    'type' { $t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($A1)); [W]::TypeText($t); Out @{ ok = $true; chars = $t.Length; title = (Title) } }
    'key' {
      $parts = $A1.ToLower().Split('+'); $mods = @(); $main = $null
      foreach ($p in $parts) {
        switch ($p) { 'ctrl' { $mods += 0x11 } 'control' { $mods += 0x11 } 'alt' { $mods += 0x12 } 'shift' { $mods += 0x10 } 'win' { $mods += 0x5B } default { $main = $p } }
      }
      if ($null -eq $main) { throw 'no key' }
      if ($VK.ContainsKey($main)) { $code = $VK[$main] } elseif ($main.Length -eq 1) { $code = [int][char]$main.ToUpper() } else { throw ('unknown key ' + $main) }
      foreach ($m in $mods) { [W]::keybd_event([byte]$m, 0, 0, [UIntPtr]::Zero) }
      [W]::keybd_event([byte]$code, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W]::keybd_event([byte]$code, 0, 2, [UIntPtr]::Zero)
      [Array]::Reverse($mods); foreach ($m in $mods) { [W]::keybd_event([byte]$m, 0, 2, [UIntPtr]::Zero) }
      Out @{ ok = $true; title = (Title) }
    }
    default { throw ('unknown action ' + $Action) }
  }
}

if ($Action -eq 'serve') {
  # serve mode: one tab-separated command per line in, one JSON line out
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $p = $line.Split("`t")
    try { $res = Invoke-Act $p[0] $p[1] $p[2] $p[3] $p[4] $p[5] } catch { $res = (Out @{ error = $_.Exception.Message }) }
    [Console]::Out.WriteLine($res); [Console]::Out.Flush()
  }
} else { Invoke-Act $Action $A1 $A2 $A3 $A4 $A5 }
