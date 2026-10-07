# 「打开文件夹」：这个文件夹已经有资源管理器窗口开着，就把它调到最前面（退出码 0）；没开着退出码 1，由 server.js 新开一个
# 路径从环境变量 FDIR 传进来，避免中文路径在命令行参数里被转码
$want = $env:FDIR.TrimEnd('\')
$hit = $null
foreach ($w in (New-Object -ComObject Shell.Application).Windows()) {
  try { if ($w.Document.Folder.Self.Path.TrimEnd('\') -ieq $want) { $hit = $w; break } } catch {}
}
if (-not $hit) { exit 1 }
Add-Type -Namespace R -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);
'@
$h = [System.IntPtr]$hit.HWND
if ([R.W]::IsIconic($h)) { [void][R.W]::ShowWindow($h, 9) }
# 后台进程不许直接抢前台；按一下 Alt 解开这个限制（只是按下再松开，不会触发菜单之外的任何东西）
[R.W]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)
[void][R.W]::SetForegroundWindow($h)
[R.W]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)
exit 0
