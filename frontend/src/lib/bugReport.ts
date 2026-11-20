/* Version and environment info for bug reports, gathered automatically. */
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getApiBase } from "./platform";

export const ISSUES_URL = "https://github.com/cal-jsh/logfile-processor/issues";

/** Chromium only (Edge, Chrome, WebView2) */
interface UADataValues {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
  fullVersionList?: { brand: string; version: string }[];
}
interface NavigatorUAData {
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<UADataValues>;
}

/** "x86_64", "aarch64", ... from Client Hints; empty if unknown */
function arch(v: UADataValues): string {
  if (!v.architecture) return "";
  if (v.architecture === "x86") return v.bitness === "64" ? "x86_64" : "x86";
  if (v.architecture === "arm") return v.bitness === "64" ? "aarch64" : "arm";
  return v.architecture;
}

/** e.g. "Windows 11 (x86_64)". Client Hints where available, else parsed from the user agent. */
async function osName(): Promise<string> {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  if (uaData?.getHighEntropyValues) {
    try {
      const v = await uaData.getHighEntropyValues(["platform", "platformVersion", "architecture", "bitness"]);
      const platform = v.platform || uaData.platform;
      const a = arch(v);
      let name = platform;
      if (platform === "Windows" && v.platformVersion) {
        // Client Hints platformVersion: 13+ is Windows 11, 1-10 Windows 10, 0 older
        const major = parseInt(v.platformVersion, 10);
        name = major >= 13 ? "Windows 11" : major > 0 ? "Windows 10" : "Windows (older than 10)";
      } else if (v.platformVersion) {
        name += ` ${v.platformVersion}`;
      }
      return a ? `${name} (${a})` : name;
    } catch {
      /* fall through to the user agent */
    }
  }
  const ua = navigator.userAgent;
  // The user agent cannot tell Windows 10 from 11
  if (/Windows NT 10/.test(ua)) return "Windows 10 or 11";
  const mac = ua.match(/Mac OS X ([\d_]+)/);
  if (mac) return `macOS ${mac[1].replace(/_/g, ".")}`;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return navigator.platform || "unknown";
}

/** e.g. "Microsoft Edge 142.0.3595.53", from Client Hints if available */
async function browserName(): Promise<string | null> {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData;
  if (!uaData?.getHighEntropyValues) return null;
  try {
    const v = await uaData.getHighEntropyValues(["fullVersionList"]);
    const brand = v.fullVersionList?.find(
      (b) => !/Not.?A.?Brand/i.test(b.brand) && b.brand !== "Chromium"
    ) ?? v.fullVersionList?.find((b) => b.brand === "Chromium");
    return brand ? `${brand.brand} ${brand.version}` : null;
  } catch {
    return null;
  }
}

async function backendVersion(): Promise<string> {
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}/version`);
    if (!res.ok) return `unknown (HTTP ${res.status})`;
    const body = (await res.json()) as { version?: string };
    return body.version ?? "unknown";
  } catch {
    return "not reachable";
  }
}

/** Plain-text block to paste into a GitHub issue. */
export async function gatherBugReportInfo(): Promise<string> {
  const [os, backend] = await Promise.all([osName(), backendVersion()]);
  const [version, tauri, engine] = await Promise.all([
    getVersion().catch(() => "unknown"),
    getTauriVersion().catch(() => "unknown"),
    browserName(),
  ]);
  const lines: string[] = [];
  lines.push(`Logfile Processor version: ${version}`);
  lines.push(`Backend version: ${backend}`);
  lines.push(`Runtime: Desktop app (Tauri ${tauri})`);
  lines.push(`OS: ${os}`);
  // e.g. "Microsoft Edge WebView2 142.0.3595.53" on Windows
  if (engine) lines.push(`WebView: ${engine}`);
  lines.push(`Language: ${navigator.language}`);
  lines.push(`Screen: ${window.screen.width}x${window.screen.height} @${Math.round(window.devicePixelRatio * 100) / 100}x`);
  return lines.join("\n");
}

/** Copy text; falls back to a hidden textarea + execCommand where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall back */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("Copy failed");
}

/** Open in the default browser (a plain link would navigate the webview). */
export async function openIssues(): Promise<void> {
  await openUrl(ISSUES_URL);
}
