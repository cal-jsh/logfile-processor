/* In-app update (tauri-plugin-updater): asks the latest.json of the newest *published*
   GitHub release (plugins.updater in tauri.conf.json), downloads the installer and checks
   its signature against the public key built into the app, then runs it. */
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

const RELEASES_URL = "https://github.com/cal-jsh/logfile-processor/releases";

export type { Update };

/** The version of the running app (tauri.conf.json). */
export function currentVersion(): Promise<string> {
  return getVersion();
}

/** The newer release, or null when this is the newest. Throws when GitHub cannot be asked
    or has no update information (see `describeUpdateError`). */
export function checkForUpdate(): Promise<Update | null> {
  return check({ timeout: 30_000 });
}

/** One check per window, started by the sidebar so its button can show that an update
    is waiting. Failures are quiet here; the dialog checks again and shows them. */
let background: Promise<Update | null> | null = null;
export function backgroundCheck(): Promise<Update | null> {
  background ??= checkForUpdate().catch(() => null);
  return background;
}
/** Remember the result of a check made in the dialog, for the sidebar button. */
export function rememberCheck(update: Update | null) {
  background = Promise.resolve(update);
}

/** A readable message for an updater error. */
export function describeUpdateError(e: unknown): string {
  const raw = String(e);
  if (/valid release JSON|404|Not Found/i.test(raw)) {
    return "GitHub has no update information yet: the newest published release has no latest.json. " +
      "Releases built with the signing key carry one once they are published (not while they are drafts).";
  }
  if (/signature/i.test(raw)) {
    return `The downloaded installer failed the signature check and was not installed (${raw}).`;
  }
  if (/invalid updater binary format/i.test(raw)) {
    return "The downloaded file is not a Windows installer, so nothing was installed.";
  }
  if (/error sending request|dns|connect|timed out|network/i.test(raw)) {
    return `Could not reach GitHub (${raw}).`;
  }
  return raw;
}

/** Download the installer (the plugin verifies its signature) and report progress in bytes. */
export async function downloadUpdate(
  update: Update,
  onProgress: (downloaded: number, total: number | null) => void
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.download((ev) => {
    if (ev.event === "Started") total = ev.data.contentLength ?? null;
    else if (ev.event === "Progress") downloaded += ev.data.chunkLength;
    else if (ev.event === "Finished" && total != null) downloaded = total;
    onProgress(downloaded, total);
  });
}

/** Run the downloaded installer. On Windows the app exits here and the installer starts
    the new version when it is done; elsewhere the app restarts itself. */
export async function installUpdate(update: Update): Promise<void> {
  await update.install();
  await relaunch();
}

/** The GitHub page of a release (its full notes). */
export function openReleasePage(version: string): Promise<void> {
  return openUrl(`${RELEASES_URL}/tag/v${version}`);
}
