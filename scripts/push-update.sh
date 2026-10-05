#!/usr/bin/env bash
set -euo pipefail

azupic_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
gh auth status
azupic_stage="$(mktemp -d "${TMPDIR:-/tmp}/azupic-update.XXXXXXXX")"
python3 "$azupic_root/scripts/prepare-publication.py" "$azupic_stage/snapshot"
git_https() { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
git_https clone --branch main --single-branch https://github.com/oisee/azupic.git "$azupic_stage/repository"
cd "$azupic_stage/repository"
# Update our files; retain the upstream reference and unrelated remote files.
cp "$azupic_stage/snapshot/"README*.md .
cp "$azupic_stage/snapshot/.gitignore" .
cp "$azupic_stage/snapshot/go.mod" .
for azupic_directory in cmd internal scripts .github; do
    cp -R "$azupic_stage/snapshot/$azupic_directory/." "$azupic_directory/"
done
cp "$azupic_stage/snapshot/docs/release-notes.md" docs/
python3 scripts/prepare-publication.py "$azupic_stage/final"
cp "$azupic_stage/final/PUBLICATION-MANIFEST.json" .
go test -race ./...
go vet ./...
git config --local user.name 'Alice Vinogradova'
git config --local user.email 'ooisee@gmail.com'
git add -- README*.md .gitignore go.mod cmd internal scripts .github docs/release-notes.md PUBLICATION-MANIFEST.json
git diff --cached --check
if git diff --cached --quiet; then echo 'No changes to push.'; exit 0; fi
git commit -m 'Fix Go toolchain version and verify minimum Go in CI'
git_https push origin main
echo 'Updated https://github.com/oisee/azupic — existing release unchanged.'
echo "Checkout: $azupic_stage/repository"
