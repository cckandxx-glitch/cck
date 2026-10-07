# Shows one Windows toast notification (silent, no window, does not steal focus). Text is passed as base64 UTF-8.
# Optional action button: -ActionUrl (opened by protocol activation when clicked) and -ActionLabelB64 (button text, base64 UTF-8).
param([string]$B64, [string]$ActionUrl, [string]$ActionLabelB64)
$ErrorActionPreference = 'Stop'
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($B64))
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$esc = [System.Security.SecurityElement]::Escape($text)
$actions = ''
if ($ActionUrl -and $ActionLabelB64) {
  $label = [System.Security.SecurityElement]::Escape([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ActionLabelB64)))
  $url = [System.Security.SecurityElement]::Escape($ActionUrl)
  $actions = "<actions><action content=`"$label`" arguments=`"$url`" activationType=`"protocol`"/></actions>"
}
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$esc</text></binding></visual>$actions<audio silent=`"true`"/></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
Write-Output 'shown'
