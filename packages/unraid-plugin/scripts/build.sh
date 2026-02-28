#!/bin/bash
#
# build.sh - Build the openclaw-connect .txz package for Unraid
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$PLUGIN_DIR/../.." && pwd)"
BUILD_DIR="${PLUGIN_DIR}/build"
PKG_NAME="openclaw-connect"
VERSION="${1:-0.1.0}"

echo "=== Building ${PKG_NAME} v${VERSION} ==="

# Clean
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# 1. Build the shared package
echo "[1/4] Building shared package..."
cd "$ROOT_DIR/packages/shared"
pnpm build

# 2. Bundle the server into a single file
echo "[2/4] Bundling server..."
cd "$ROOT_DIR/packages/unraid-plugin/server"
pnpm bundle
BUNDLE_FILE="$ROOT_DIR/packages/unraid-plugin/server/dist/index.cjs"

if [ ! -f "$BUNDLE_FILE" ]; then
  echo "Error: Server bundle not found at ${BUNDLE_FILE}"
  exit 1
fi

# 3. Assemble package structure
echo "[3/4] Assembling package..."
STAGE="${BUILD_DIR}/staging"
mkdir -p "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/server"
mkdir -p "${STAGE}/etc/rc.d"

# Copy server bundle
cp "$BUNDLE_FILE" "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/server/index.cjs"

# Copy emhttp plugin files (pages, php, js, css, etc.)
cp -r "$PLUGIN_DIR/src/usr/local/emhttp/plugins/${PKG_NAME}/"* \
  "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/"

# Copy rc.d script
cp "$PLUGIN_DIR/rc.d/rc.${PKG_NAME}" "${STAGE}/etc/rc.d/rc.${PKG_NAME}"
chmod +x "${STAGE}/etc/rc.d/rc.${PKG_NAME}"

# Make event scripts executable
chmod +x "${STAGE}/usr/local/emhttp/plugins/${PKG_NAME}/event/"* 2>/dev/null || true

# 4. Create .txz package
echo "[4/4] Creating .txz package..."
cd "$STAGE"
tar cJf "${BUILD_DIR}/${PKG_NAME}-${VERSION}-x86_64-1.txz" .

PKG_FILE="${BUILD_DIR}/${PKG_NAME}-${VERSION}-x86_64-1.txz"

# Generate MD5 checksum
MD5=$(md5sum "$PKG_FILE" | awk '{print $1}')
echo "$MD5" > "${PKG_FILE}.md5"

echo "=== Build complete ==="
echo "Package: ${PKG_FILE}"
echo "MD5:     ${MD5}"
ls -lh "${PKG_FILE}"
