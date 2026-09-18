#!/bin/bash
#
# release-notes.sh - Print GitHub release notes for a version
#
# Usage: release-notes.sh <version>
# Prints release-notes/<version>.md, written by hand for each release (see
# release-notes/README.md for the layout), followed by the standard install
# and downloads section. Fails if that file or the version's <CHANGES>
# section in unraidclaw.plg is missing, so a release cannot go out without
# notes for GitHub or a changelog for the Unraid WebGUI.
#
set -euo pipefail

VERSION="${1:?usage: release-notes.sh <version>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PLG="$ROOT_DIR/packages/unraid-plugin/unraidclaw.plg"
NOTES="$ROOT_DIR/release-notes/${VERSION}.md"

if ! grep -qxF "### ${VERSION}" "$PLG"; then
  echo "Error: no '### ${VERSION}' section in <CHANGES> of ${PLG}" >&2
  exit 1
fi
if [ ! -s "$NOTES" ]; then
  echo "Error: ${NOTES} is missing or empty. Write it using the layout in release-notes/README.md." >&2
  exit 1
fi
if grep -q '^## Install and downloads' "$NOTES"; then
  echo "Error: ${NOTES} has its own 'Install and downloads' section; this script adds it." >&2
  exit 1
fi

cat "$NOTES"
cat <<SECTION

## Install and downloads

- **Unraid plugin**: update from the Unraid WebGUI (Plugins > Check for Updates) or install through Community Applications. \`unraidclaw-${VERSION}-x86_64-1.txz\` is the package the WebGUI downloads; you do not need to fetch it by hand.
- **CLI**: \`npm install -g unraidclaw-cli\`, or download \`unraidclaw-cli-${VERSION}.tar.gz\` for machines without npm. Verify it with the \`.sha256\` file, extract it, and make sure Node.js 22 or newer is on \`PATH\`. Runs on Linux, macOS and Windows; see the [CLI guide](https://github.com/emaspa/unraidclaw/blob/main/packages/cli/README.md).
- **OpenClaw plugin**: see [OpenClaw plugin](https://github.com/emaspa/unraidclaw#openclaw-plugin) in the README for install and update commands.
- **Checksums**: the \`.md5\` file covers the \`.txz\` package and the \`.sha256\` file covers the CLI archive.
SECTION
