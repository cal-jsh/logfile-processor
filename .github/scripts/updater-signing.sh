#!/usr/bin/env bash
# Updater signing for a release build, shared by the Windows and the Linux job.
#
# Needs the secret TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD) in $KEY / $KEY_PASSWORD.
# The public key and the latest.json endpoint are committed in tauri.conf.json
# (plugins.updater); the repository variable TAURI_UPDATER_PUBKEY ($PUBKEY) is only a
# fallback for a config without that section, and a warning shows if the two differ.
#
# Then, in the CI checkout only: turn on bundle.createUpdaterArtifacts (not committed,
# because a local `tauri build` without the private key would fail) and hand the key
# to the build, so tauri signs the bundles (.sig files) and tauri-action adds them to
# latest.json on the release.
#
# If anything is missing this changes nothing and the release simply has no updater
# files.
set -euo pipefail

if [ -z "${KEY:-}" ]; then
  echo "::notice::TAURI_SIGNING_PRIVATE_KEY is not set: release built without updater artifacts (no .sig, no latest.json)."
  exit 0
fi
conf=frontend/src-tauri/tauri.conf.json
has_updater=$(node -p "!!(require('./$conf').plugins || {}).updater")
if [ "$has_updater" != "true" ] && [ -z "${PUBKEY:-}" ]; then
  echo "::warning::TAURI_SIGNING_PRIVATE_KEY is set but the repository variable TAURI_UPDATER_PUBKEY is not (and tauri.conf.json has no plugins.updater): release built without updater artifacts."
  exit 0
fi
if [ "$has_updater" = "true" ] && [ -n "${PUBKEY:-}" ]; then
  conf_pubkey=$(node -p "require('./$conf').plugins.updater.pubkey")
  if [ "$conf_pubkey" != "$(echo "$PUBKEY" | tr -d '[:space:]')" ]; then
    echo "::warning::The repository variable TAURI_UPDATER_PUBKEY differs from plugins.updater.pubkey in tauri.conf.json. The committed one is used; installed apps reject updates signed with a key that does not match it."
  fi
fi
node -e "
  const fs = require('fs');
  const p = process.argv[1];
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  c.bundle.createUpdaterArtifacts = true;
  c.plugins = c.plugins || {};
  if (!c.plugins.updater) {
    c.plugins.updater = {
      pubkey: process.env.PUBKEY.trim(),
      endpoints: [process.env.ENDPOINT],
    };
  }
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
" "$conf"
{
  echo "TAURI_SIGNING_PRIVATE_KEY<<__KEY_EOF__"
  echo "$KEY"
  echo "__KEY_EOF__"
  # Empty when the key has no password; must still be set, or the build asks for one
  echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD<<__PW_EOF__"
  echo "${KEY_PASSWORD:-}"
  echo "__PW_EOF__"
} >> "$GITHUB_ENV"
echo "Updater signing key found: building signed updater artifacts."
