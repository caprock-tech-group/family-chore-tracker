param(
    [ValidateSet('Setup', 'Check', 'Apply', 'Run')]
    [string]$Mode = 'Check'
)

$ErrorActionPreference = 'Stop'
$folder = Join-Path $env:LOCALAPPDATA 'FamilyChores'
$settings = Join-Path $folder 'OliverWifi.xml'
$log = Join-Path $folder 'OliverWifi.log'
$tracker = 'https://stevens-family-chores.netlify.app/api/chores?wifi=1'
$controller = 'c37d018594d4162c98c1ae7cc9a85a52'
$site = '6a066e8d8874c364b1a8036b'
$aclId = '6af8a3fc8d65db5bb1f017c5'
$acl = "https://localhost/openapi/v1/$controller/sites/$site/acls/osg-acls"
$route = @('--noproxy', '*', '--connect-to', 'localhost:443:192.168.0.11:443')
$curlOptions = @('--silent', '--show-error', '--fail', '--max-time', '15')

function Invoke-JsonCurl {
    param([string[]]$Options, [string]$InputText, [string]$Url)
    $reply = $InputText | & curl.exe @curlOptions @Options $Url
    if ($LASTEXITCODE -ne 0) { throw "HTTPS request failed (curl exit $LASTEXITCODE)." }
    $reply -join "`n" | ConvertFrom-Json -ErrorAction Stop
}

function ConvertTo-PlainText([securestring]$Value) {
    [System.Net.NetworkCredential]::new('', $Value).Password
}

function Read-Omada($Reply) {
    if ($null -eq $Reply.errorCode -or $Reply.errorCode -ne 0) {
        throw "Omada rejected the request (code $($Reply.errorCode))."
    }
    $Reply.result
}

function Send-WifiCheckIn([bool]$Healthy, $DenyEnabled = $null) {
    $config = Import-Clixml -LiteralPath $settings
    $key = ConvertTo-PlainText $config.WifiKey
    $body = @{ healthy = $Healthy; denyEnabled = $DenyEnabled } | ConvertTo-Json -Compress
    $file = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($file, $body)
        $reply = Invoke-JsonCurl -Options @('--request', 'POST', '--header', '@-',
            '--header', 'Content-Type: application/json', '--data-binary', "@$file") `
            -InputText "Authorization: Bearer $key" -Url $tracker
        if (-not $reply.ok) { throw 'Could not report Wi-Fi status to the tracker.' }
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
}

function Sync-Wifi([bool]$Write) {
    $config = Import-Clixml -LiteralPath $settings
    $wifiKey = ConvertTo-PlainText $config.WifiKey
    $state = Invoke-JsonCurl -Options @('--header', '@-') -InputText "Authorization: Bearer $wifiKey" -Url $tracker
    $central = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, 'Central Standard Time').ToString('yyyy-MM-dd')
    if ($state.wifiUnlocked -isnot [bool] -or $state.period -cne $central) {
        throw 'Tracker did not return a current, valid Wi-Fi decision.'
    }
    $block = -not $state.wifiUnlocked
    $loginBody = @{
        omadacId = $controller
        client_id = $config.ClientId
        client_secret = ConvertTo-PlainText $config.ClientSecret
    } | ConvertTo-Json -Compress
    $token = Read-Omada (Invoke-JsonCurl -Options ($route + @('--header', 'Content-Type: application/json', '--data-binary', '@-')) -InputText $loginBody -Url 'https://localhost/openapi/authorize/token?grant_type=client_credentials')
    if (-not $token.accessToken) { throw 'Omada did not issue an access token.' }
    $header = "Authorization: AccessToken=$($token.accessToken)"
    $options = $route + @('--header', '@-')
    $listUrl = "${acl}?page=1&pageSize=100"
    $list = Read-Omada (Invoke-JsonCurl -Options $options -InputText $header -Url $listUrl)
    $found = @($list.data | Where-Object { $_.id -ceq $aclId })
    if ($found.Count -ne 1) { throw 'Could not identify the tested Oliver deny rule.' }
    $rule = $found[0]
    if ($rule.description -cne 'Test' -or $rule.status -isnot [bool] -or
        $rule.policy -ne 0 -or $rule.sourceType -ne 0 -or $rule.destinationType -ne 1 -or
        ($rule.sourceIds -join ',') -cne '6af8a14b8d65db5bb1f01768' -or
        ($rule.destinationIds -join ',') -cne '6a066e8f8874c364b1a80385' -or
        ($rule.protocols -join ',') -cne '256' -or
        $rule.direction.lanToWan -ne $true -or $rule.direction.lanToLan -ne $false -or
        $rule.direction.wanInIds.Count -or $rule.direction.vpnInIds.Count -or $rule.timeRangeId) {
        throw 'The live ACL differs from the tested Oliver LAN-to-WAN deny rule.'
    }
    if (-not $Write) {
        return "Dry run. Tracker unlocked: $($state.wifiUnlocked). Deny rule enabled now: $($rule.status). Would set deny rule to: $block."
    }
    if ($rule.status -eq $block) {
        Send-WifiCheckIn $true $rule.status
        return "Deny rule already correct: $block."
    }
    $payload = @{ status = $block }
    foreach ($field in @('description','policy','protocols','sourceIds','destinationIds','syslog',
        'sourceType','destinationType','direction','stateMode','states','timeRangeId')) {
        if ($null -ne $rule.PSObject.Properties[$field]) { $payload[$field] = $rule.$field }
    }
    $file = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($file, ($payload | ConvertTo-Json -Depth 10 -Compress))
        $update = $options + @('--request', 'PUT', '--header', 'Content-Type: application/json', '--data-binary', "@$file")
        $null = Read-Omada (Invoke-JsonCurl -Options $update -InputText $header -Url "$acl/$aclId")
    } finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    $confirmed = Read-Omada (Invoke-JsonCurl -Options $options -InputText $header -Url $listUrl)
    $updated = @($confirmed.data | Where-Object { $_.id -ceq $aclId })
    if ($updated.Count -ne 1 -or $updated[0].status -ne $block) { throw 'Could not verify the ACL change.' }
    Send-WifiCheckIn $true $updated[0].status
    return "Verified deny rule enabled: $block."
}

if ($Mode -eq 'Setup') {
    $newConfig = @{
        WifiKey = Read-Host 'Paste the tracker Wi-Fi setup key' -AsSecureString
        ClientId = (Read-Host 'Omada Client ID').Trim()
        ClientSecret = Read-Host 'Omada Client Secret' -AsSecureString
    }
    if ($newConfig.WifiKey.Length -ne 43 -or -not $newConfig.ClientId -or -not $newConfig.ClientSecret.Length) {
        throw 'One or more credentials are missing or malformed.'
    }
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $newConfig | Export-Clixml -LiteralPath $settings
    Write-Host 'Saved credentials for this Windows user on this PC.'
    Sync-Wifi $false
    return
}

if (-not (Test-Path -LiteralPath $settings -PathType Leaf)) { throw 'Run Setup first.' }
if ($Mode -eq 'Check') { Sync-Wifi $false; return }
if ($Mode -eq 'Apply') { Sync-Wifi $true; return }

$previous = ''
while ($true) {
    try { $message = Sync-Wifi $true }
    catch {
        $message = 'Sync error: ' + $_.Exception.Message
        try { Send-WifiCheckIn $false } catch {}
    }
    if ($message -cne $previous) {
        if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
            Move-Item -LiteralPath $log -Destination "$log.old" -Force
        }
        Add-Content -LiteralPath $log -Value "$(Get-Date -Format s) $message"
        $previous = $message
    }
    Start-Sleep -Seconds 60
}
