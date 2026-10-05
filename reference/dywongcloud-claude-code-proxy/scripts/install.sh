#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PREFIX=${PREFIX:-"$HOME/.local"}
LIBDIR="$PREFIX/lib/claude-code-proxy"
BINDIR="$PREFIX/bin"

command -v node >/dev/null 2>&1 || {
  echo "error: Node.js 20.12 or newer is required" >&2
  exit 1
}

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 12) ? 0 : 1)'; then
  echo "error: Node.js 20.12 or newer is required; found $(node --version)" >&2
  exit 1
fi

mkdir -p "$LIBDIR" "$BINDIR"
rm -rf "$LIBDIR/bin" "$LIBDIR/src"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$ROOT/README.md" "$LIBDIR/"
cp -R "$ROOT/bin" "$ROOT/src" "$LIBDIR/"
chmod +x "$LIBDIR/bin/claude-code-proxy.js"

cat > "$BINDIR/claude-code-proxy" <<WRAPPER
#!/usr/bin/env sh
exec node "$LIBDIR/bin/claude-code-proxy.js" "\$@"
WRAPPER
chmod +x "$BINDIR/claude-code-proxy"

printf 'Installed %s\n' "$BINDIR/claude-code-proxy"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) printf 'Add this to your shell profile: export PATH="%s:\$PATH"\n' "$BINDIR" ;;
esac
"$BINDIR/claude-code-proxy" --version

