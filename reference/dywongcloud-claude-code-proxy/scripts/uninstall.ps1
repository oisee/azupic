$ErrorActionPreference = "Stop"
$Prefix = if ($env:PREFIX) { $env:PREFIX } else { Join-Path $HOME ".local" }
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "bin\claude-code-proxy.cmd")
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "lib\claude-code-proxy")
Write-Host "Removed executable and installed source. Credentials/config were preserved."

