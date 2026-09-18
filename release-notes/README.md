# Release notes

Each release has a file here named after its version, such as `0.1.33.md`. The release workflow publishes it as the GitHub release notes and appends the standard "Install and downloads" section, so do not write that section yourself. A tag without a notes file, or without the matching `### <version>` changelog section in `packages/unraid-plugin/unraidclaw.plg`, stops the workflow before anything is built.

The `.plg` changelog stays the short list the Unraid WebGUI shows. The notes file is the longer version for GitHub. Every changelog item appears in the notes; nothing appears in the notes that the release does not contain.

Preview the result with `bash packages/unraid-plugin/scripts/release-notes.sh <version>`.

## Layout

Use these sections in this order, and leave out any that would be empty. See `0.1.33.md` for a complete example.

1. **Opening paragraph**, no heading. Two or three sentences on what the release is about.
2. `## Highlights`, with a `###` subsection per major feature. Bullets say what changed and link to the README or CLI guide for setup.
3. `## Security and reliability fixes`
4. `## Other changes`
5. `## Upgrade notes`: anything that changes behavior for existing installs, API scripts or clients, such as settings that are off after upgrading, certificates or keys that change, or input that is now rejected.

## Style

- Sentence-case headings, short bullets of one or two sentences.
- Code formatting for paths, commands, fields and settings; bold for WebGUI labels such as **Enable MCP**.
- Plain wording: no marketing adjectives, emojis or filler.
- No em dashes or en dashes; use commas, colons or separate sentences. Straight quotes only.
- No credentials or real IP addresses.
