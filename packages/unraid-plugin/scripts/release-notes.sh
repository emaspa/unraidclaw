#!/bin/bash
#
# release-notes.sh - Print GitHub release notes for a version
#
# Usage: release-notes.sh <version>
# Takes the version's section from <CHANGES> in unraidclaw.plg, which is the
# user-facing changelog, and adds a short guide to the release assets.
#
set -euo pipefail

VERSION="${1:?usage: release-notes.sh <version>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLG="$SCRIPT_DIR/../unraidclaw.plg"

CHANGES="$(awk -v heading="### ${VERSION}" '
  $0 == heading { found = 1; next }
  found && (/^### / || /^<\/CHANGES>/) { exit }
  found { print }
' "$PLG" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"

if [ -z "$CHANGES" ]; then
  echo "Error: no '### ${VERSION}' section in <CHANGES> of ${PLG}" >&2
  exit 1
fi

cat <<NOTES
## Changes

${CHANGES}

## Downloads

- \`unraidclaw-${VERSION}-x86_64-1.txz\`: the Unraid plugin package. Install or update the plugin from the Unraid WebGUI rather than downloading this file.
- \`unraidclaw-cli-${VERSION}.tar.gz\`: the \`unraidclaw\` command-line client for managing Unraid from another machine. Needs Node.js 22 or newer on Linux, macOS or Windows. See the [CLI guide](https://github.com/emaspa/unraidclaw/blob/main/packages/cli/README.md).
- \`.md5\` and \`.sha256\` files hold checksums for the downloads above.
NOTES
