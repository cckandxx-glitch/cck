$log = 'D:\ai网站\本地AI\logs\restart.log'
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -Encoding UTF8 }
# 1. 停旧后台（它的退出处理会顺手关掉 Ollama）
Stop-Process -Id 29516 -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Log 'old agent killed'
# 2. 起 Ollama 并等它就绪
$ollama = 'D:\ai网站\本地AI\Ollama\ollama.exe'
Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/version' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}
  Start-Sleep -Milliseconds 500
}
Log "ollama ready=$ready after $i"
# 3. 起新后台
Start-Process -FilePath 'node' -ArgumentList 'server.js','--no-open' -WorkingDirectory 'D:\ai网站\本地AI\agent' -WindowStyle Hidden
Log 'new agent started'
