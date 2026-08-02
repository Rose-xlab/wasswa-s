# PocketVision desktop alerts — polls the Supabase `alerts` table and shows a
# Windows toast (with sound) for every new alert the VPS scanner records.
# Independent of Telegram; needs only this PC, the repo's .env, and internet.
#
# Run manually:  powershell -ExecutionPolicy Bypass -File deploy\desktop-alerts.ps1
# One-off test:  powershell -ExecutionPolicy Bypass -File deploy\desktop-alerts.ps1 -Test
#                (toasts the most recent alert already in Supabase, then exits)
param(
  [int]$PollSec = 5,
  [switch]$Test
)
$ErrorActionPreference = 'Stop'

# ── Credentials from the repo's .env (same keys the scanner uses) ──
$root = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $root '.env'
if (-not (Test-Path $envPath)) { throw ".env not found at $envPath" }
$vars = @{}
foreach ($line in Get-Content $envPath) {
  if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$') {
    $vars[$Matches[1]] = ($Matches[2] -split '\s+#')[0].Trim()
  }
}
$base = $vars['SUPABASE_URL']
$key  = $vars['SUPABASE_SERVICE_ROLE_KEY']
if (-not $base -or -not $key) { throw 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env' }
$headers = @{ apikey = $key; authorization = "Bearer $key" }
$select = 'select=at,symbol,label,payout,streak,colour'

# ── Toast plumbing (built into Windows, no modules) ──
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

function Show-Toast([string]$title, [string]$body) {
  $t = [Security.SecurityElement]::Escape($title)
  $b = [Security.SecurityElement]::Escape($body)
  $xml = "<toast duration=`"long`"><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual><audio src=`"ms-winsoundevent:Notification.Looping.Alarm2`" loop=`"false`"/></toast>"
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
    (New-Object Windows.UI.Notifications.ToastNotification $doc))
}

function Format-Alert([object]$row) {
  $name = if ($row.label) { $row.label } else { $row.symbol }
  $payout = if ($null -ne $row.payout) { " | payout $($row.payout)%" } else { '' }
  @{
    title = "$(([string]$row.colour).ToUpper()) x$($row.streak)  $name"
    body  = "PocketVision streak alert$payout | $($row.at)"
  }
}

if ($Test) {
  $rows = Invoke-RestMethod -Uri "$base/rest/v1/alerts?$select&order=at.desc&limit=1" -Headers $headers
  if (-not $rows) { Write-Host 'Connected, but no alerts in Supabase yet.'; exit 0 }
  $p = Format-Alert $rows[0]
  Show-Toast $p.title $p.body
  Write-Host "Test toast shown: $($p.title)"
  exit 0
}

# Only alert on rows newer than startup — old history stays quiet.
$lastAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
Write-Host "Watching Supabase for new alerts (poll every ${PollSec}s). Ctrl+C to stop."
while ($true) {
  try {
    $cursor = [uri]::EscapeDataString($lastAt)
    $rows = Invoke-RestMethod -Uri "$base/rest/v1/alerts?$select&at=gt.$cursor&order=at.asc" -Headers $headers
    foreach ($row in @($rows)) {
      $p = Format-Alert $row
      Show-Toast $p.title $p.body
      Write-Host "$($row.at)  $($p.title)"
      $lastAt = [string]$row.at
    }
  } catch {
    Write-Host "poll failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $PollSec
}
