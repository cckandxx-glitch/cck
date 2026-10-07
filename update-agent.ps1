# 一键更新 REIZE助手：从 GitHub 下载最新的 5 个程序文件替换进 agent 文件夹，旧文件先备份，然后重启助手。
# 用法（PowerShell 里粘贴一行）：
#   irm https://raw.githubusercontent.com/cckandxx-glitch/cck/claude/upbeat-dijkstra-weod9v/update-agent.ps1 | iex
# 不会动 config.json、state.json、记忆、对话、工作区。
$ErrorActionPreference = 'Stop'
$root  = 'D:\ai网站\本地AI'
$agent = Join-Path $root 'agent'
$base  = 'https://raw.githubusercontent.com/cckandxx-glitch/cck/claude/upbeat-dijkstra-weod9v/agent/'
$files = 'server.js', 'core.js', 'auto.js', 'power.js', 'ui.html'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path $agent)) { Write-Host "找不到 $agent，没有更新。" -ForegroundColor Red; return }

# 1. 先全部下载到临时文件夹，有一个失败就整体放弃，不会出现新旧混装
$tmp = Join-Path $env:TEMP ('reize-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  foreach ($f in $files) {
    Invoke-WebRequest -UseBasicParsing -Uri ($base + $f + '?t=' + [DateTime]::Now.Ticks) -OutFile (Join-Path $tmp $f)
    if ((Get-Item (Join-Path $tmp $f)).Length -lt 1000) { throw "$f 下载不完整" }
  }
} catch { Write-Host "下载失败，没有更新：$($_.Exception.Message)" -ForegroundColor Red; return }

# 2. 停掉助手
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 3

# 3. 备份旧文件，再替换
$bak = Join-Path $agent ('_bak-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $bak | Out-Null
foreach ($f in $files) {
  $old = Join-Path $agent $f
  if (Test-Path $old) { Copy-Item $old $bak }
  Copy-Item (Join-Path $tmp $f) $old -Force
}
Remove-Item $tmp -Recurse -Force

# 4. 重新打开助手
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $root '启动REIZE助手(独立窗口).vbs') + '"')
Write-Host "更新完成，助手正在重新打开。旧文件备份在：$bak" -ForegroundColor Green
