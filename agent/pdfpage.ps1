# ??? PDF ????????????????????? PNG?????? Windows ????????? Windows.Data.Pdf????????????????????????????????????
# ??????????????????????????????AI_PDF ?????????AI_PAGE ??????(???1??????)???AI_OUT ??????png???AI_W ????????????
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTaskG = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskA = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function AwaitOp($op, $type) { $t = $asTaskG.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAct($op) { $t = $asTaskA.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }

$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:AI_PDF)) ([Windows.Storage.StorageFile])
$doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$n = [int]$doc.PageCount
$p = [int]$env:AI_PAGE
if ($p -lt 1 -or $p -gt $n) { Write-Output "PAGE_OUT_OF_RANGE pages=$n"; exit 2 }
$page = $doc.GetPage($p - 1)
$opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$opt.DestinationWidth = [uint32]$env:AI_W
$ms = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
AwaitAct ($page.RenderToStreamAsync($ms, $opt))
$ms.Seek(0)
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ms)
$fs = [System.IO.File]::Create($env:AI_OUT)
$stream.CopyTo($fs); $fs.Close(); $stream.Close()
Write-Output "OK pages=$n"
