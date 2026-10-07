# Prints one JSON line every few seconds: GPU busy %, dedicated VRAM used / total (GB) of the busiest adapter.
# WMI counters only (works for AMD / NVIDIA / Intel, any Windows language).
param([int]$Interval = 2)
$ErrorActionPreference = 'SilentlyContinue'
$total = 0
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  $q = (Get-ItemProperty $_.PSPath).'HardwareInformation.qwMemorySize'
  if ($q -and [double]$q -gt $total) { $total = [double]$q }
}
$name = (Get-CimInstance Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1).Name
while ($true) {
  $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Sort-Object DedicatedUsage -Descending | Select-Object -First 1
  $util = 0
  if ($mem -and $mem.Name -match '(luid_\w+_\w+)_phys') {
    $luid = $Matches[1]; $by = @{}
    Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object {
      if ($_.Name -like "*$luid*" -and $_.Name -match 'engtype_(\w+)') {
        $k = $Matches[1]; if (-not $by.ContainsKey($k)) { $by[$k] = 0 }; $by[$k] += [int]$_.UtilizationPercentage
      }
    }
    foreach ($v in $by.Values) { if ($v -gt $util) { $util = $v } }
  }
  if ($util -gt 100) { $util = 100 }
  $used = if ($mem) { [math]::Round($mem.DedicatedUsage / 1GB, 1) } else { 0 }
  $tot = if ($total -gt 0) { [math]::Round($total / 1GB, 0) } else { 0 }
  Write-Output ('{"util":' + $util + ',"used":' + $used.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"total":' + $tot + ',"name":"' + $name + '"}')
  [Console]::Out.Flush()
  Start-Sleep -Seconds $Interval
}
