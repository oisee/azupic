#!/usr/bin/env sh
set -eu
PREFIX=${PREFIX:-"$HOME/.local"}
rm -f "$PREFIX/bin/claude-code-proxy"
rm -rf "$PREFIX/lib/claude-code-proxy"
echo "Removed executable and installed source."
echo "Credentials/config were preserved under your claude-code-proxy config directory."

