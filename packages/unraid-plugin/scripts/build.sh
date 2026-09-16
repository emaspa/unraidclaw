#!/bin/bash
#
# build.sh - Build the unraidclaw .txz package for Unraid
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$PLUGIN_DIR/../.." && pwd)"
BUILD_DIR="${PLUGIN_DIR}/build"
PKG_NAME="unraidclaw"
VERSION="${1:-0.1.0}"

echo "=== Building ${PKG_NAME} v${VERSION} ==="

# Clean
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# 1. Build the shared types and tool registry
echo "[1/4] Building server dependencies..."
cd "$ROOT_DIR"
pnpm --filter "@unraidclaw/server^..." build

# 2. Bundle the server into a single file
echo "[2/4] Bundling server..."
cd "$ROOT_DIR/packages/unraid-plugin/server"
pnpm bundle
BUNDLE_FILE="$ROOT_DIR/packages/unraid-plugin/server/dist/index.cjs"

if [ ! -f "$BUNDLE_FILE" ]; then
  echo "Error: Server bundle not found at ${BUNDLE_FILE}"
  exit 1
fi

# Build the standalone CLI after the shared registry.
cd "$ROOT_DIR"
pnpm --filter unraidclaw-cli build

# 3. Assemble package structure
echo "[3/4] Assembling package..."
STAGE="${BUILD_DIR}/staging"
mkdir -p "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/server"
mkdir -p "${STAGE}/etc/rc.d"
mkdir -p "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/cli"
mkdir -p "${STAGE}/usr/local/bin"
cp "$ROOT_DIR/packages/cli/dist/unraidclaw.cjs" "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/cli/unraidclaw.cjs"
cp "$PLUGIN_DIR/src/usr/local/bin/unraidclaw" "${STAGE}/usr/local/bin/unraidclaw"
chmod 755 "${STAGE}/usr/local/bin/unraidclaw"

# Copy server bundle
cp "$BUNDLE_FILE" "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/server/index.cjs"

# Copy emhttp plugin files (pages, php, js, css, etc.)
cp -r "$PLUGIN_DIR/src/usr/local/emhttp/plugins/${PKG_NAME}/"* \
  "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/"

# Record the version with the code it describes. The service reads this at
# start; the .plg on flash is only saved after the install script has already
# restarted the service, so it still names the previous version then.
printf '%s\n' "$VERSION" > "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/VERSION"

# Copy rc.d script
cp "$PLUGIN_DIR/rc.d/rc.${PKG_NAME}" "${STAGE}/etc/rc.d/rc.${PKG_NAME}"
chmod +x "${STAGE}/etc/rc.d/rc.${PKG_NAME}"

# Make event scripts executable
chmod +x "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/event/"* 2>/dev/null || true

# 4. Create .txz package
echo "[4/4] Creating .txz package..."
cd "$STAGE"
# Archive files and symlinks, not directory headers. A header for etc/rc.d
# can replace Unraid's symlink with a directory; shared parents must not have
# their permissions/ownership replaced either. Tar creates missing parents.
# Keep file ownership root:root regardless of the build runner (issue #13).
find . ! -type d -printf '%P\0' | tar --null --no-recursion \
  --owner=root --group=root --numeric-owner \
  -cJf "${BUILD_DIR}/${PKG_NAME}-${VERSION}-x86_64-1.txz" -T -

PKG_FILE="${BUILD_DIR}/${PKG_NAME}-${VERSION}-x86_64-1.txz"

# Generate MD5 checksum
MD5=$(md5sum "$PKG_FILE" | awk '{print $1}')
echo "$MD5" > "${PKG_FILE}.md5"

echo "=== Build complete ==="
echo "Package: ${PKG_FILE}"
echo "MD5:     ${MD5}"
ls -lh "${PKG_FILE}"
