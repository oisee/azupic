#!/usr/bin/env bash
set -euo pipefail

azupic_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
azupic_tag="${1:-v0.1.0}"
[[ "$azupic_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || { echo 'Invalid release tag.' >&2; exit 1; }
gh auth status
azupic_stage="$(mktemp -d "${TMPDIR:-/tmp}/azupic-release.XXXXXXXX")"
python3 "$azupic_root/scripts/prepare-publication.py" "$azupic_stage/snapshot"
git_https() { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }
git_https clone --branch main --single-branch https://github.com/oisee/azupic.git "$azupic_stage/repository"
cd "$azupic_stage/repository"
if git_https ls-remote --exit-code --tags origin "refs/tags/$azupic_tag" >/dev/null 2>&1; then
    echo 'Tag already exists; refusing to replace a release.' >&2
    exit 1
fi
azupic_paths=(README.md README.RU.md .gitignore cmd/azupic/main.go
    .github/workflows/ci.yml .github/workflows/release.yml
    scripts/prepare-publication.py scripts/build-release.py scripts/publish-release.sh
    docs/release-notes.md)
for azupic_path in "${azupic_paths[@]}"; do
    mkdir -p "$(dirname -- "$azupic_path")"
    cp "$azupic_stage/snapshot/$azupic_path" "$azupic_path"
done
# Regenerate the manifest from the final checkout, preserving any remote changes.
python3 scripts/prepare-publication.py "$azupic_stage/final"
cp "$azupic_stage/final/PUBLICATION-MANIFEST.json" .
go test -race ./...
go vet ./...
python3 scripts/build-release.py "$azupic_tag"
(cd dist && sha256sum --check checksums.txt)
git config --local user.name 'Alice Vinogradova'
git config --local user.email 'ooisee@gmail.com'
git add -- "${azupic_paths[@]}" PUBLICATION-MANIFEST.json
git diff --cached --check
git commit -m 'Add English README and six-platform release CI'
git_https push origin main
git tag "$azupic_tag"
git_https push origin "$azupic_tag"
echo "Release workflow started: https://github.com/oisee/azupic/actions"
echo "Release appears after CI succeeds: https://github.com/oisee/azupic/releases/tag/$azupic_tag"
echo "Checkout and local archives: $azupic_stage/repository"
