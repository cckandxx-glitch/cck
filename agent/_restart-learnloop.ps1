# 2026-10-06 学习循环上线后的一次性重启脚本（用完可删）
Start-Sleep -Seconds 25
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js --no-open*' }
foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }
Start-Sleep -Seconds 3
Start-Process -FilePath 'node' -ArgumentList 'server.js --no-open' -WorkingDirectory 'D:\ai网站\本地AI\agent' -WindowStyle Hidden
