#!/usr/bin/env node
// Sets the app version in every file that carries it, so a release tag (v1.2.3)
// and the version the app reports cannot drift apart. The CI release job refuses
// a tag that differs from tauri.conf.json, and the updater compares that version
// with the installed one.
//
//   npm run set-version 1.2.3     set it everywhere
//   npm run set-version           only show the current versions
//
// Files are edited as text (no reformatting) and nothing is committed or tagged.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Semantic version 2.0.0 (no leading "v"; one is stripped from the argument).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// The `version` line right after a `[[package]] name = "<crate>"` in Cargo.lock.
const lockEntry = (crate) =>
  new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${crate}"\\r?\\nversion = ")([^"]+)(")`);

// Each target: file, label, regex whose 2nd group is the version (all matches are set).
const targets = [
  ["frontend/src-tauri/tauri.conf.json", "app version", /^(\s*"version":\s*")([^"]+)(")/m],
  ["frontend/package.json", "package version", /^(\s{2}"version":\s*")([^"]+)(")/m],
  ["frontend/package-lock.json", "lockfile root", /^(\s{2}"version":\s*")([^"]+)(")/m],
  ["frontend/package-lock.json", 'lockfile packages[""]', /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]*",\s*"version":\s*")([^"]+)(")/],
  ["backend/Cargo.toml", "logfile_processor", /^(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/m],
  ["frontend/src-tauri/Cargo.toml", "logfile_processor_desktop", /^(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/m],
  ["backend/Cargo.lock", "logfile_processor", lockEntry("logfile_processor")],
  ["frontend/src-tauri/Cargo.lock", "logfile_processor", lockEntry("logfile_processor")],
  ["frontend/src-tauri/Cargo.lock", "logfile_processor_desktop", lockEntry("logfile_processor_desktop")],
];

const arg = process.argv[2];
if (arg === "-h" || arg === "--help") {
  console.log("Usage: npm run set-version [<x.y.z>]   (no argument: show current versions)");
  process.exit(0);
}
const next = arg?.replace(/^v/, "");
if (arg !== undefined && !SEMVER.test(next)) {
  console.error(`"${arg}" is not a semantic version like 1.2.3 or 1.2.3-rc.1`);
  process.exit(2);
}

// Read and check everything first, so a missing entry leaves every file untouched.
const files = new Map();
const found = [];
for (const [file, label, re] of targets) {
  if (!files.has(file)) files.set(file, readFileSync(join(repo, file), "utf8"));
  const m = files.get(file).match(re);
  if (!m) {
    console.error(`Could not find the ${label} version in ${file}; nothing was changed.`);
    process.exit(1);
  }
  found.push({ file, label, re, current: m[2] });
}

const width = Math.max(...found.map((f) => `${f.file} (${f.label})`.length));
const line = (f, text) => console.log(`  ${`${f.file} (${f.label})`.padEnd(width)}  ${text}`);

if (next === undefined) {
  console.log("Current versions:");
  for (const f of found) line(f, f.current);
  const distinct = new Set(found.map((f) => f.current));
  if (distinct.size > 1) {
    console.log("\nThe versions differ; run `npm run set-version <x.y.z>` to align them.");
    process.exit(1);
  }
  process.exit(0);
}

console.log(`Setting version ${next}:`);
let changed = 0;
for (const f of found) {
  if (f.current === next) {
    line(f, `${next} (unchanged)`);
    continue;
  }
  files.set(f.file, files.get(f.file).replace(f.re, `$1${next}$3`));
  line(f, `${f.current} -> ${next}`);
  changed++;
}
for (const [file, text] of files) writeFileSync(join(repo, file), text);

if (/-/.test(next) && !/^[^-]+-\d+$/.test(next)) {
  console.warn(
    `\nNote: the MSI bundler only accepts a numeric pre-release (like ${next.split("-")[0]}-1); ` +
      "`tauri build` may fail for this version.",
  );
}

console.log(`\n${changed} entr${changed === 1 ? "y" : "ies"} changed. Next steps:
  1. Review the diff and commit it, e.g. "Release v${next}".
  2. Merge it to main and push.
  3. Tag that commit v${next} and push the tag. CI builds the installers and
     creates a draft release, which you then publish on GitHub so the in-app
     updater offers it.`);
