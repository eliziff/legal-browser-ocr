$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
$port = 8799
$node = (Get-Command node -ErrorAction Stop).Source
$server = Join-Path $PSScriptRoot 'serve.mjs'
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw "Port $port is already in use. Open the existing reader or stop its server before launching another." }
$process = Start-Process -FilePath $node -ArgumentList ('"' + $server + '"'), $port -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
$process.PriorityClass = 'BelowNormal'
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($process.HasExited) { throw 'The reader server exited before it was ready.' }
    try { $null = Invoke-WebRequest "http://127.0.0.1:$port/serve.mjs" -UseBasicParsing -TimeoutSec 1; break } catch { Start-Sleep -Milliseconds 100 }
}
if ($attempt -eq 40) { throw 'The reader server did not become ready.' }
Start-Process -FilePath "http://127.0.0.1:$port/"
