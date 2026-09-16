#!/bin/bash
#
# package.sh - Build the standalone CLI release archive
#
# Usage: package.sh <version> [output-dir]
# Writes unraidclaw-cli-<version>.tar.gz and its .sha256 file. The archive
# holds one directory with the bundle, launchers for POSIX shells and Windows,
# the CLI README and the license.
#
set -euo pipefail

VERSION="${1:?usage: package.sh <version> [output-dir]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$CLI_DIR/../.." && pwd)"
OUT_DIR="$(mkdir -p "${2:-$CLI_DIR/build}" && cd "${2:-$CLI_DIR/build}" && pwd)"
NAME="unraidclaw-cli-${VERSION}"

cd "$ROOT_DIR"
pnpm --filter "unraidclaw-cli^..." build
UNRAIDCLAW_BUILD_VERSION="$VERSION" pnpm --filter unraidclaw-cli build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/$NAME"
cp "$CLI_DIR/dist/unraidclaw.cjs" "$STAGE/$NAME/unraidclaw.cjs"
cp "$CLI_DIR/README.md" "$STAGE/$NAME/README.md"
cp "$ROOT_DIR/LICENSE" "$STAGE/$NAME/LICENSE"

cat > "$STAGE/$NAME/unraidclaw" <<'EOF'
#!/bin/sh
# Resolve symlinks so a link in a PATH directory still finds the bundle.
self="$0"
while [ -L "$self" ]; do
  target="$(readlink "$self")"
  case "$target" in
    /*) self="$target" ;;
    *) self="$(dirname "$self")/$target" ;;
  esac
done
bundle="$(cd "$(dirname "$self")" && pwd)/unraidclaw.cjs"
if ! command -v node >/dev/null 2>&1; then
  echo "unraidclaw requires Node.js 22 or newer." >&2
  exit 1
fi
exec node "$bundle" "$@"
EOF

printf '@echo off\r\nnode "%%~dp0unraidclaw.cjs" %%*\r\n' > "$STAGE/$NAME/unraidclaw.cmd"

chmod 755 "$STAGE/$NAME" "$STAGE/$NAME/unraidclaw" "$STAGE/$NAME/unraidclaw.cjs"
chmod 644 "$STAGE/$NAME/unraidclaw.cmd" "$STAGE/$NAME/README.md" "$STAGE/$NAME/LICENSE"

ARCHIVE="$OUT_DIR/$NAME.tar.gz"
tar -C "$STAGE" --sort=name --owner=0 --group=0 --numeric-owner \
  --mtime="@${SOURCE_DATE_EPOCH:-$(git -C "$ROOT_DIR" log -1 --format=%ct)}" \
  -cf - "$NAME" | gzip -n -9 > "$ARCHIVE"
(cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")

# Smoke test the archive as a user would unpack it.
CHECK="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$CHECK"' EXIT
tar -C "$CHECK" -xzf "$ARCHIVE"
ln -s "$CHECK/$NAME/unraidclaw" "$CHECK/linked"
for launcher in "$CHECK/$NAME/unraidclaw" "$CHECK/linked"; do
  reported="$("$launcher" --version)"
  if [ "$reported" != "unraidclaw $VERSION" ]; then
    echo "Error: $launcher reported '$reported', expected 'unraidclaw $VERSION'" >&2
    exit 1
  fi
done

echo "$ARCHIVE"
