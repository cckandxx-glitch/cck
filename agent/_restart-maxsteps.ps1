$wd = $PSScriptRoot
Start-Sleep -Seconds 6
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js --no-open*' -and $_.CommandLine -notlike '*CRM*' }
if ($p) { Stop-Process -Id $p.ProcessId -Force; Start-Sleep -Seconds 2 }
Start-Process -FilePath 'node' -ArgumentList 'server.js --no-open' -WorkingDirectory $wd -WindowStyle Hidden
Add-Content (Join-Path $wd 'logs\restart-note.txt') ("restarted " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
