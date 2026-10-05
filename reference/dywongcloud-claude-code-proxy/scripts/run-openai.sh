#!/usr/bin/env sh
set -eu
command -v claude >/dev/null 2>&1 || {
  echo "error: Claude Code (claude) is not installed or not in PATH" >&2
  exit 1
}
export ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-http://127.0.0.1:18765}
export ANTHROPIC_AUTH_TOKEN=${CCP_PROXY_AUTH_TOKEN:-unused}
export ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-openai/gpt-5.6-sol[1m]}
export ANTHROPIC_SMALL_FAST_MODEL=${ANTHROPIC_SMALL_FAST_MODEL:-openai/gpt-5.6-luna[1m]}
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
exec claude "$@"

