#!/usr/bin/env bash
set -euo pipefail

# This script publishes only a newly prepared allowlisted snapshot.
azupic_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v gh >/dev/null || { echo 'GitHub CLI (gh) is required.' >&2; exit 1; }
gh auth status
azupic_login="$(gh api user --jq .login)"
azupic_owner="${1:-$azupic_login}"
if [[ ! "$azupic_owner" =~ ^[A-Za-z0-9][A-Za-z0-9-]*$ ]]; then echo 'Invalid GitHub owner.' >&2; exit 1; fi
azupic_stage="$(mktemp -d "${TMPDIR:-/tmp}/azupic-publish.XXXXXXXX")"
python3 "$azupic_source/scripts/prepare-publication.py" "$azupic_stage/source"
cd "$azupic_stage/source"
go test -race ./...
go vet ./...
go build -buildvcs=false -o bin/azupic ./cmd/azupic
git init -b main
git config --local user.name "Alice Vinogradova"
git config --local user.email "ooisee@gmail.com"
git add .
# Preserve the upstream research snapshot, including its original whitespace.
git diff --cached --check -- . ':!reference/dywongcloud-claude-code-proxy/**'
git commit -m 'Initial azupic bridge: Anthropic Messages to Azure Responses'
if ! gh api "repos/$azupic_owner/azupic" --silent; then
  gh repo create "$azupic_owner/azupic" --public \
    --description 'Small Go bridge from Claude Code Anthropic Messages to Azure OpenAI Responses'
fi
git remote add origin "https://github.com/$azupic_owner/azupic.git"
# Use gh's existing login over HTTPS, without changing global Git configuration.
# No force: an existing remote history must never be overwritten.
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin main
echo "Published: https://github.com/$azupic_owner/azupic"
echo "Clean Git checkout: $azupic_stage/source"
