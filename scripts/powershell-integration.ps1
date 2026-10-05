# Dot-source this file from your PowerShell profile.
$script:AzupicRoot = Split-Path -Parent $PSScriptRoot

function claude-z {
    if (-not $env:ZAI_API_KEY) { Write-Error 'ZAI_API_KEY is not set'; return }
    Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_MODEL, Env:ANTHROPIC_DEFAULT_MODEL, Env:ENABLE_TOOL_SEARCH, Env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT -ErrorAction SilentlyContinue
    $env:ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'
    $env:ANTHROPIC_AUTH_TOKEN = $env:ZAI_API_KEY
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-5.3-flash[1m]'
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-5.3[1m]'
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-5.3[1m]'
    Write-Host 'Claude Code -> Z.ai / GLM'
    claude @args
}

function claude-a {
    Remove-Item Env:ANTHROPIC_BASE_URL, Env:ANTHROPIC_AUTH_TOKEN, Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_MODEL, Env:ANTHROPIC_DEFAULT_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:ANTHROPIC_DEFAULT_*_MODEL, Env:ENABLE_TOOL_SEARCH, Env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT -ErrorAction SilentlyContinue
    Write-Host 'Claude Code -> Anthropic'
    claude @args
}

function claude-az {
    $env:LISTEN_ADDR = '127.0.0.1:8080'
    $bridge = $null
    $logDir = Join-Path $script:AzupicRoot '.local'
    $null = New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop
    $log = Join-Path $logDir 'azupic.log'
    try {
        $bridge = Start-Process "$script:AzupicRoot/bin/azupic.exe" -PassThru -WindowStyle Hidden -ErrorAction Stop `
            -RedirectStandardError $log -RedirectStandardOutput (Join-Path $logDir 'azupic.stdout.log')
        Start-Sleep -Milliseconds 300
        $bridge.Refresh()
        if ($bridge.HasExited) {
            Get-Content -LiteralPath $log | Out-Host
            throw "azupic failed to start. Log: $log"
        }

        Remove-Item Env:ANTHROPIC_API_KEY, Env:CLAUDE_CODE_EFFORT_LEVEL -ErrorAction SilentlyContinue
        Remove-Item Env:ANTHROPIC_MODEL, Env:ANTHROPIC_DEFAULT_MODEL -ErrorAction SilentlyContinue
        Remove-Item Env:ANTHROPIC_DEFAULT_*_MODEL -ErrorAction SilentlyContinue
        $env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8080'
        $env:ANTHROPIC_AUTH_TOKEN = if ($env:AZUPIC_TOKEN) { $env:AZUPIC_TOKEN } else { 'local-azupic' }
        $env:ENABLE_TOOL_SEARCH = 'false'
        $env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'

        Write-Host 'Claude Code -> azupic -> Azure'
        claude --model claude-opus-5-5 @args
    } finally {
        if ($null -ne $bridge -and $null -ne $bridge.Id) {
            $bridge.Refresh()
            if (-not $bridge.HasExited) { Stop-Process -Id $bridge.Id -ErrorAction SilentlyContinue }
            $bridge.Dispose()
        }
    }
}
