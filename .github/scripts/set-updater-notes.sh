#!/usr/bin/env bash
# Writes release notes into the "notes" of the latest.json on a GitHub release, the
# text the in-app Update dialog shows under "Release notes".
#
#   bash .github/scripts/set-updater-notes.sh <tag> <notes.md>
#
# Why this exists: tauri-action fills "notes" from its releaseBody input when it writes
# latest.json, and when a second job adds its platforms to the same file it keeps only
# the existing "platforms" and replaces "notes" with its own releaseBody (empty if not
# given). Editing the release text on GitHub afterwards does not change latest.json
# either. So each release job runs this right after tauri-action, and whichever job
# finishes last leaves the same notes behind.
#
# Does nothing if the release has no latest.json (updater signing switched off).
# Needs gh (GH_TOKEN), node and GITHUB_REPOSITORY. Works on draft releases.
set -euo pipefail

tag="${1:?usage: set-updater-notes.sh <tag> <notes.md>}"
notes_file="${2:?usage: set-updater-notes.sh <tag> <notes.md>}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

if ! gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' | grep -qx 'latest.json'; then
  echo "Release ${tag} has no latest.json (updater signing off?): nothing to do."
  exit 0
fi

# Relative paths on purpose: on the Windows runner gh and node are native programs and
# would not understand a POSIX temp path.
dir=.updater-notes
rm -rf "$dir"
mkdir -p "$dir"
gh release download "$tag" --repo "$repo" --pattern latest.json --dir "$dir"

node -e '
  const fs = require("fs");
  const [file, notesFile] = process.argv.slice(1);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.notes = fs.readFileSync(notesFile, "utf8").replace(/\r\n/g, "\n").trim();
  if (!json.notes) console.log("::warning::Release notes are empty: the Update dialog will say \"No notes for this release.\"");
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
' "$dir/latest.json" "$notes_file"

gh release upload "$tag" "$dir/latest.json" --repo "$repo" --clobber
rm -rf "$dir"
echo "latest.json of ${tag} now carries the release notes."
