Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""Get-CimInstance Win32_Process -Filter \""Name='node.exe'\"" | Where-Object { $_.CommandLine -like '*agent*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; curl.exe --noproxy '*' -s -m 5 -d '{\""model\"":\""reize-qwen\"",\""keep_alive\"":0}' http://127.0.0.1:11434/api/generate""", 0, True
sh.Run "taskkill /f /im ""ollama app.exe"" /im ollama.exe", 0, True
MsgBox "REIZE assistant stopped.", 64, "REIZE"
