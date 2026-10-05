# Source this file from ~/.bashrc. BASH_SOURCE locates the checkout while sourced.
_azupic_shell_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

claude-z() (
    if [[ -z "${ZAI_API_KEY:-}" ]]; then
        echo 'ZAI_API_KEY is not set' >&2
        return 1
    fi
    unset ANTHROPIC_API_KEY ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL
    unset ENABLE_TOOL_SEARCH CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
    export ANTHROPIC_AUTH_TOKEN="$ZAI_API_KEY"
    export ANTHROPIC_DEFAULT_HAIKU_MODEL='glm-5.3-flash[1m]'
    export ANTHROPIC_DEFAULT_SONNET_MODEL='glm-5.3[1m]'
    export ANTHROPIC_DEFAULT_OPUS_MODEL='glm-5.3[1m]'
    echo 'Claude Code -> Z.ai / GLM'
    command claude "$@"
)

claude-a() (
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
    unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL
    unset ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
    unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_FABLE_MODEL
    unset ENABLE_TOOL_SEARCH CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    echo 'Claude Code -> Anthropic'
    command claude "$@"
)

claude-az() (
    # Subshell keeps provider selection out of the parent terminal.
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
    unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL
    unset ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
    unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_FABLE_MODEL
    unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
    bash "$_azupic_shell_root/scripts/run-claude.sh" "$@"
)
