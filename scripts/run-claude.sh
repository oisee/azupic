#!/usr/bin/env bash
set -euo pipefail

azupic_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]; then
  echo 'Нужен AZURE_OPENAI_API_KEY в окружении.' >&2
  exit 1
fi
command -v claude >/dev/null || { echo 'Claude Code не найден в PATH.' >&2; exit 1; }
[[ -x "$azupic_root/bin/azupic" ]] || { echo 'Сначала собери: go build -buildvcs=false -o bin/azupic ./cmd/azupic' >&2; exit 1; }

export AZURE_OPENAI_DEPLOYMENT="${AZUPIC_DEPLOYMENT:-gpt-6.1-sol}"
export AZURE_DEPLOYMENT="$AZURE_OPENAI_DEPLOYMENT"
if [[ -z "${AZURE_RESPONSES_URL:-}" && -f "$azupic_root/.local/azure-responses-url" ]]; then
  AZURE_RESPONSES_URL="$(cat "$azupic_root/.local/azure-responses-url")"
fi
export AZURE_RESPONSES_URL="${AZURE_RESPONSES_URL:?Set the full Azure Responses URL}"
export LISTEN_ADDR=127.0.0.1:8080
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
unset ANTHROPIC_API_KEY
export ANTHROPIC_AUTH_TOKEN="${AZUPIC_TOKEN:-local-azupic}"
export ENABLE_TOOL_SEARCH=false
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1
# A fixed environment effort overrides /effort; keep this session interactive.
unset CLAUDE_CODE_EFFORT_LEVEL

mkdir -p "$azupic_root/.local"
azupic_log="$azupic_root/.local/azupic.log"
"$azupic_root/bin/azupic" >"$azupic_log" 2>&1 &
azupic_pid=$!
trap 'kill "$azupic_pid" 2>/dev/null || true; wait "$azupic_pid" 2>/dev/null || true' EXIT

# Check this process, so an occupied port cannot silently route to another service.
azupic_ready=false
for ((azupic_attempt=0; azupic_attempt<50; azupic_attempt++)); do
  if ! kill -0 "$azupic_pid" 2>/dev/null; then
    cat "$azupic_log" >&2
    exit 1
  fi
  if curl --noproxy 127.0.0.1 --silent --fail --max-time 1 "$ANTHROPIC_BASE_URL/healthz" >/dev/null; then
    sleep 0.1
    if kill -0 "$azupic_pid" 2>/dev/null; then azupic_ready=true; break; fi
  fi
  sleep 0.1
done
if [[ "$azupic_ready" != true ]]; then
  echo "azupic не запустился; лог: $azupic_log" >&2
  cat "$azupic_log" >&2
  exit 1
fi
echo "azupic → $AZURE_OPENAI_DEPLOYMENT; лог: $azupic_log" >&2
claude --model azupic "$@"
