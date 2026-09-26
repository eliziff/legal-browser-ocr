$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'
Start-Process -FilePath (Join-Path $PSScriptRoot 'index.html') -WindowStyle Hidden
