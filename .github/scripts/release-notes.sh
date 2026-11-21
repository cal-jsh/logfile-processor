#!/usr/bin/env bash
# Release notes of a version tag, as Markdown on stdout. Used by the release jobs for
# the release page and for the "notes" of latest.json, which the in-app Update dialog
# shows as plain text, so the notes are kept to a short bullet list.
#
#   bash .github/scripts/release-notes.sh v1.2.3
#
# Source, first match wins:
#   1. docs/release-notes/<tag>.md, if it exists: written by hand, used as it is.
#   2. The changes merged since the previous version tag: one bullet per commit on the
#      first-parent line of the tag (for a merged pull request its title and number,
#      e.g. "- Add regex filtering (#38)"). Version bumps ("Bump to v1.2.3") and plain
#      branch merges are left out.
#
# Needs the full history and the tags (actions/checkout with fetch-depth: 0).
set -euo pipefail

tag="${1:?usage: release-notes.sh <tag>}"

override="docs/release-notes/${tag}.md"
if [ -f "$override" ]; then
  sed -e 's/\r$//' "$override"
  exit 0
fi

# The newest version tag before this one; without one, everything up to the tag.
prev=$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${tag}^" 2>/dev/null || true)
range="${prev:+${prev}..}${tag}"

# One record per commit (\x1e), subject and body separated by \x1f, oldest first.
git log --first-parent --reverse --format='%s%x1f%b%x1e' "$range" | awk '
  BEGIN { RS = "\036"; FS = "\037" }
  {
    subject = $1; body = $2
    sub(/^[\r\n]+/, "", subject)
    if (subject == "") next

    if (subject ~ /^Merge pull request #[0-9]+ /) {
      number = subject
      sub(/^Merge pull request #/, "", number)
      sub(/ .*/, "", number)
      # The pull request title is the first non-empty line of the merge commit body;
      # without one, fall back to the branch name.
      title = ""
      n = split(body, lines, "\n")
      for (i = 1; i <= n; i++) {
        line = lines[i]
        gsub(/\r/, "", line)
        gsub(/^[ \t]+|[ \t]+$/, "", line)
        if (line != "") { title = line; break }
      }
      if (title == "") {
        title = subject
        sub(/^Merge pull request #[0-9]+ from [^\/]*\//, "", title)
      }
      entry = title " (#" number ")"
    } else if (subject ~ /^Merge (branch|remote-tracking branch|tag) /) {
      next
    } else {
      entry = subject
    }

    if (entry ~ /^([Bb]ump|[Rr]elease|[Pp]repare release)( to| version)*( to)? v?[0-9]+\.[0-9]+/) next
    print "- " entry
  }
'
