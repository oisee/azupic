$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Prefix = if ($env:PREFIX) { $env:PREFIX } else { Join-Path $HOME ".local" }
$LibDir = Join-Path $Prefix "lib\claude-code-proxy"
$BinDir = Join-Path $Prefix "bin"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 20.12 or newer is required"
}
$parts = ((& node -p "process.versions.node").Trim() -split '\.')
$major = [int]$parts[0]
$minor = [int]$parts[1]
if (($major -lt 20) -or (($major -eq 20) -and ($minor -lt 12))) {
  throw "Node.js 20.12 or newer is required; found $(& node --version)"
}

New-Item -ItemType Directory -Force -Path $LibDir, $BinDir | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $LibDir "bin"), (Join-Path $LibDir "src")
Copy-Item (Join-Path $Root "package.json"), (Join-Path $Root "LICENSE"), (Join-Path $Root "README.md") -Destination $LibDir
Copy-Item -Recurse (Join-Path $Root "bin"), (Join-Path $Root "src") -Destination $LibDir

$Wrapper = Join-Path $BinDir "claude-code-proxy.cmd"
@"
@echo off
node "$LibDir\bin\claude-code-proxy.js" %*
"@ | Set-Content -Encoding ASCII $Wrapper

Write-Host "Installed $Wrapper"
if (-not (($env:Path -split ';') -contains $BinDir)) {
  Write-Host "Add this directory to your user PATH: $BinDir"
}
& $Wrapper --version

