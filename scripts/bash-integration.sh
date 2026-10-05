# Source this file from ~/.bashrc. BASH_SOURCE locates the checkout while sourced.
_azupic_shell_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

claude-az() (
    # Subshell keeps provider selection out of the parent terminal.
    unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY
    unset ANTHROPIC_MODEL ANTHROPIC_DEFAULT_MODEL
    unset ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL
    unset ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_FABLE_MODEL
    unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
    bash "$_azupic_shell_root/scripts/run-claude.sh" "$@"
)
