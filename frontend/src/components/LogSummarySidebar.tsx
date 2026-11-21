import type { LogSummary } from "../lib/logSummary";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarSeparator,
  SidebarTrigger,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { canonicalLevel, colorMap, LEVEL_ORDER } from "../lib/colorMap";
import type { MinimapAxis } from "./Minimap";
import { cn } from "@/lib/utils";
import {
  Bug,
  CircleArrowUp,
  FileText,
  Settings,
  SquareTerminal,
  FolderOpen,
  Minus,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useEffect, useState } from "react";
import BugReportDialog from "./BugReportDialog";
import CliHelpDialog from "./CliHelpDialog";
import UpdateDialog from "./UpdateDialog";
import { backgroundCheck, currentVersion, type Update } from "../lib/updater";
import SettingsDialog, { formatNeedsAttention, type SettingsPage } from "./SettingsDialog";
import { IndexingSweep } from "./IndexingSweep";

interface Props {
  summary: LogSummary;
  /** The in-process API and the session, for the format preview */
  baseUrl: string;
  sessionId: string;
  /** Reopen the file with another line format (null: detect it) */
  onChangeFormat: (pattern: string | null) => Promise<void>;
  /** Names of the fields not shown as columns */
  hiddenColumns: string[];
  setHiddenColumns: (v: string[]) => void;
  /** Path (desktop) or name (web) of the open file */
  fileName?: string;
  /** Close this file and pick another one */
  onOpenAnother?: () => void;
  searchOpen: boolean;
  onToggleSearch: () => void;
  showDelta: boolean;
  setShowDelta: (v: boolean) => void;
  showMinimap: boolean;
  setShowMinimap: (v: boolean) => void;
  minimapAxis: MinimapAxis;
  setMinimapAxis: (v: MinimapAxis) => void;
  /** "level", or the name of a text field (e.g. "domain") */
  minimapColor: string;
  setMinimapColor: (v: string) => void;
  showLanes: boolean;
  setShowLanes: (v: boolean) => void;
  /** The field the lanes are made of; null when the format has no text field */
  lanesField: string | null;
  setLanesField: (v: string) => void;
  contextLines: number;
  setContextLines: (v: number) => void;
}

/** "1d 4h 6m", "6m 25s", "850 ms" */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** From the times the backend read with the file's format (ms, log clock) */
function duration(a?: number | null, b?: number | null): string | null {
  if (a == null || b == null || b < a) return null;
  return formatDuration(b - a);
}

/** Show timestamps to the millisecond; the full value is in the tooltip */
function shortTs(ts: string): string {
  return ts.replace(/(\.\d{3})\d+/, "$1");
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function Stat({ label, value, title, pending }: { label: string; value: string; title?: string; pending?: boolean }) {
  return (
    <div className="rounded-lg border bg-background px-2.5 py-1.5" title={title}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`truncate font-mono text-sm font-semibold tabular-nums ${pending ? "text-muted-foreground/60" : ""}`}>{value}</div>
    </div>
  );
}

export default function LogSummarySidebar({
  summary,
  baseUrl,
  sessionId,
  onChangeFormat,
  hiddenColumns,
  setHiddenColumns,
  fileName,
  onOpenAnother,
  searchOpen,
  onToggleSearch,
  showDelta,
  setShowDelta,
  showMinimap,
  setShowMinimap,
  minimapAxis,
  setMinimapAxis,
  minimapColor,
  setMinimapColor,
  showLanes,
  setShowLanes,
  lanesField,
  setLanesField,
  contextLines,
  setContextLines,
}: Props) {
  const dur = duration(summary.start_ms, summary.stop_ms);
  // spdlog writes "info", "warning", ...: count them under the known levels
  const levelCounts = LEVEL_ORDER.map((l) => ({
    level: l,
    count: Object.entries(summary.levels ?? {})
      .filter(([name]) => canonicalLevel(name) === l)
      .reduce((a, [, n]) => a + n, 0),
  }));
  const format = summary.format;
  // fields that can be hidden: all but the message
  const optionalColumns = format.columns.filter((c) => c.kind !== "message");
  // lanes can be made of any text field (thread first)
  const laneOptions = format.columns
    .filter((c) => c.kind === "text")
    .sort((a, b) => Number(b.name === "thread") - Number(a.name === "thread"))
    .map((c) => ({ value: c.name, label: c.label, title: `One lane per ${c.label.toLowerCase()} (the 48 busiest, the rest together)` }));
  // the minimap can colour by level or by any text field (domain first)
  const colorOptions: { value: string; label: string; title: string }[] = [
    { value: "level", label: "Level", title: "Most severe log level of the lines in each column" },
    ...format.columns
      .filter((c) => c.kind === "text")
      .sort((a, b) => Number(b.name === "domain") - Number(a.name === "domain"))
      .map((c) => ({
        value: c.name,
        label: c.label,
        title: `${c.label} with the most lines in each column, grouped by the part before the first dot (core.algo and core.proc are both core)`,
      })),
  ];
  const levelTotal = levelCounts.reduce((a, b) => a + b.count, 0);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("format");
  const openSettings = (page?: SettingsPage) => {
    if (page) setSettingsPage(page);
    setSettingsOpen(true);
  };

  /* Ctrl+, opens the settings, as in most desktop apps */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [cliHelpOpen, setCliHelpOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  // A newer release found by the quiet check at start (or by the dialog), for the button
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    backgroundCheck().then((u) => !cancelled && setPendingUpdate(u));
    currentVersion().then(
      (v) => !cancelled && setAppVersion(v),
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const { state: sidebarState } = useSidebar();
  // Right after opening, the summary is that of the first 16 MB while the whole file is
  // counted: its counts are not shown (placeholders keep the layout, so nothing jumps)
  const pending = !!summary.pending;
  const otherLines =
    !pending && summary.line_count != null && summary.line_count !== summary.total_lines
      ? summary.line_count - summary.total_lines
      : 0;

  return (
    <Sidebar side="left" collapsible="icon" variant="sidebar">
      <SidebarHeader className="gap-1">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 group-data-[collapsible=icon]:hidden">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold" title={fileName}>
                {fileName ? baseName(fileName) : "Logfile"}
              </div>
              {fileName && baseName(fileName) !== fileName && (
                <div className="truncate text-[11px] text-muted-foreground" title={fileName}>
                  {fileName}
                </div>
              )}
            </div>
          </div>
          <SidebarTrigger
            className="shrink-0"
            title={sidebarState === "collapsed" ? "Show sidebar (Ctrl+→)" : "Hide sidebar (Ctrl+←)"}
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {/* Actions: stay visible as icons when the sidebar is collapsed */}
        <SidebarGroup className="py-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search & go to line (Ctrl+F)"
                isActive={searchOpen}
                onClick={onToggleSearch}
              >
                <Search />
                <span>Search &amp; go to line</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {onOpenAnother && (
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Open another logfile" onClick={onOpenAnother}>
                  <FolderOpen />
                  <span>Open another logfile</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarSeparator className="data-[orientation=horizontal]:w-auto group-data-[collapsible=icon]:hidden" />

        {/* Summary */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Summary</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-2 px-2">
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Lines"
                value={pending ? "…" : summary.total_lines.toLocaleString()}
                pending={pending}
                title={
                  otherLines > 0
                    ? `${summary.line_count!.toLocaleString()} lines in the file, ${otherLines.toLocaleString()} not in the log format`
                    : undefined
                }
              />
              <Stat label="Duration" value={pending ? "…" : dur ?? "–"} pending={pending} />
            </div>
            {pending && (
              <div className="text-[11px] text-muted-foreground" role="status">
                Indexing {summary.line_count.toLocaleString()} lines…
              </div>
            )}
            {otherLines > 0 && (
              <div className="text-[11px] text-muted-foreground">
                +{otherLines.toLocaleString()} lines not in the log format
              </div>
            )}

            {(summary.start_timestamp || summary.stop_timestamp) && (
              <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5 text-xs">
                {summary.start_timestamp && (
                  <>
                    <span className="text-muted-foreground">From</span>
                    <span className="truncate font-mono tabular-nums" title={summary.start_timestamp}>
                      {shortTs(summary.start_timestamp)}
                    </span>
                  </>
                )}
                {pending && (
                  <>
                    <span className="text-muted-foreground">To</span>
                    <span className="font-mono text-muted-foreground/60">…</span>
                  </>
                )}
                {summary.stop_timestamp && (
                  <>
                    <span className="text-muted-foreground">To</span>
                    <span className="truncate font-mono tabular-nums" title={summary.stop_timestamp}>
                      {shortTs(summary.stop_timestamp)}
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Level distribution (a neutral bar with a sweep while it is counted) */}
            {pending && (
              <div className="relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <IndexingSweep tone="dark" />
              </div>
            )}
            {!pending && levelTotal > 0 && (
              <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                {levelCounts.map(({ level, count }) =>
                  count > 0 ? (
                    <div
                      key={level}
                      style={{ width: `${(count / levelTotal) * 100}%`, background: colorMap[level] }}
                      title={`${level}: ${count.toLocaleString()}`}
                    />
                  ) : null
                )}
              </div>
            )}
            <div className="flex flex-col">
              {levelCounts.map(({ level, count }) => (
                <div key={level} className="flex items-center gap-2 py-0.5 text-xs">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: colorMap[level] }} />
                  <span className="w-16 font-medium">{level}</span>
                  <span className={`ml-auto font-mono tabular-nums ${pending ? "text-muted-foreground/60" : ""}`}>
                    {pending ? "–" : count.toLocaleString()}
                  </span>
                  <span className="w-10 text-right font-mono tabular-nums text-muted-foreground">
                    {!pending && levelTotal > 0 ? `${Math.round((count / levelTotal) * 100)}%` : ""}
                  </span>
                </div>
              ))}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="data-[orientation=horizontal]:w-auto group-data-[collapsible=icon]:hidden" />

        {/* The line format lives in Settings; here only a format that doesn't fit is called out */}
        {formatNeedsAttention(format) && (
          <>
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupContent className="px-2">
                <button
                  type="button"
                  onClick={() => openSettings("format")}
                  className="flex w-full items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-left text-xs hover:bg-amber-500/15"
                >
                  <SlidersHorizontal className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">
                      {format.raw
                        ? "No known log format found"
                        : `Log format fits ${format.sample_matched.toLocaleString()} of the first ${format.sample_lines.toLocaleString()} lines`}
                    </span>
                    <span className="text-muted-foreground">Set the log format…</span>
                  </span>
                </button>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator className="data-[orientation=horizontal]:w-auto group-data-[collapsible=icon]:hidden" />
          </>
        )}

        {/* Display options */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Display</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-3 px-2">
            <label htmlFor="toggle-show-delta" className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                id="toggle-show-delta"
                checked={showDelta}
                onCheckedChange={(checked: boolean | "indeterminate") => setShowDelta(!!checked)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <span className="text-sm leading-none font-medium">Show time delta</span>
                <span className="text-xs text-muted-foreground">Time since the previous row</span>
              </div>
            </label>

            <label htmlFor="toggle-show-minimap" className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                id="toggle-show-minimap"
                checked={showMinimap}
                onCheckedChange={(checked: boolean | "indeterminate") => setShowMinimap(!!checked)}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <span className="text-sm leading-none font-medium">Show minimap</span>
                <span className="text-xs text-muted-foreground">
                  {minimapColor === "level" ? "Log levels" : `${colorOptions.find((o) => o.value === minimapColor)?.label ?? "Groups"}s`} across the file, click to jump
                </span>
              </div>
            </label>

            {showMinimap && (
              <div className="-mt-1 flex flex-wrap items-center gap-2 pl-6.5">
                <div
                  role="radiogroup"
                  aria-label="Minimap axis"
                  className="inline-flex rounded-md border bg-background p-0.5 text-xs"
                >
                  {(
                    [
                      ["line", "By line", "Every column covers the same number of lines"],
                      ["time", "By time", "Every column covers the same time span: quiet periods show as gaps"],
                    ] as const
                  ).map(([value, label, title]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={minimapAxis === value}
                      title={title}
                      onClick={() => setMinimapAxis(value)}
                      className={cn(
                        "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
                        minimapAxis === value
                          ? "bg-secondary text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {colorOptions.length > 1 && (
                  <Segmented
                    label="Minimap colour"
                    options={colorOptions}
                    value={minimapColor}
                    onChange={setMinimapColor}
                  />
                )}
              </div>
            )}

            {lanesField && (
              <label htmlFor="toggle-show-lanes" className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  id="toggle-show-lanes"
                  checked={showLanes}
                  onCheckedChange={(checked: boolean | "indeterminate") => setShowLanes(!!checked)}
                  className="mt-0.5"
                />
                <div className="grid gap-0.5">
                  <span className="text-sm leading-none font-medium">Show {lanesField === "thread" ? "thread" : laneOptions.find((o) => o.value === lanesField)?.label.toLowerCase() ?? ""} lanes</span>
                  <span className="text-xs text-muted-foreground">One lane per {lanesField === "thread" ? "thread" : laneOptions.find((o) => o.value === lanesField)?.label.toLowerCase()} over time, Ctrl+wheel zooms</span>
                </div>
              </label>
            )}

            {lanesField && showLanes && laneOptions.length > 1 && (
              <div className="-mt-1 flex flex-wrap items-center gap-2 pl-6.5">
                <Segmented label="Lanes by" options={laneOptions} value={lanesField} onChange={setLanesField} />
              </div>
            )}

            {optionalColumns.length > 0 && (
              <div className="grid gap-1.5">
                <span className="text-sm leading-none font-medium">Columns</span>
                <div className="flex flex-wrap gap-1">
                  {optionalColumns.map((c) => {
                    const on = !hiddenColumns.includes(c.name);
                    return (
                      <button
                        key={c.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setHiddenColumns(on ? [...hiddenColumns, c.name] : hiddenColumns.filter((n) => n !== c.name))
                        }
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs transition-colors",
                          on
                            ? "border-transparent bg-secondary text-foreground"
                            : "text-muted-foreground line-through hover:text-foreground"
                        )}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <div className="grid flex-1 gap-0.5">
                <span className="text-sm leading-none font-medium">Context lines</span>
                <span className="text-xs text-muted-foreground">Shown around each match</span>
              </div>
              <div className="flex items-center rounded-md border bg-background">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-r-none"
                  aria-label="Fewer context lines"
                  disabled={contextLines <= 0}
                  onClick={() => setContextLines(Math.max(0, contextLines - 1))}
                >
                  <Minus className="size-3" />
                </Button>
                <input
                  type="number"
                  min={0}
                  aria-label="Context lines"
                  value={contextLines}
                  onChange={(e) => setContextLines(Math.max(0, parseInt(e.target.value) || 0))}
                  className="h-7 w-9 border-x bg-transparent text-center font-mono text-xs tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-l-none"
                  aria-label="More context lines"
                  onClick={() => setContextLines(contextLines + 1)}
                >
                  <Plus className="size-3" />
                </Button>
              </div>
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Pinned to the bottom, apart from the file's actions and options */}
      <SidebarSeparator className="data-[orientation=horizontal]:w-auto" />
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings (Ctrl+,)"
              onClick={() => openSettings()}
              className="text-muted-foreground"
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Command line options"
              onClick={() => setCliHelpOpen(true)}
              className="text-muted-foreground"
            >
              <SquareTerminal />
              <span>Command line</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Report a bug"
              onClick={() => setBugReportOpen(true)}
              className="text-muted-foreground"
            >
              <Bug />
              <span>Report a bug</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {pendingUpdate ? (
              <SidebarMenuButton
                aria-label={`Update available: version ${pendingUpdate.version}`}
                // Shown in both sidebar states (the default hides it while expanded)
                tooltip={{
                  hidden: false,
                  className: "max-w-60",
                  children: (
                    <div className="space-y-0.5 py-0.5">
                      <div className="font-medium">
                        Version <span className="font-mono">{pendingUpdate.version}</span> is available
                      </div>
                      <div className="opacity-70">
                        {appVersion ? (
                          <>
                            You have <span className="font-mono">{appVersion}</span>.{" "}
                          </>
                        ) : null}
                        Click to read what's new and install it.
                      </div>
                    </div>
                  ),
                }}
                onClick={() => setUpdateOpen(true)}
                className="bg-update/10 font-medium text-update hover:bg-update/15 hover:text-update active:bg-update/20 active:text-update"
              >
                <span className="relative grid shrink-0 place-items-center">
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-full bg-update motion-safe:animate-update-halo motion-reduce:hidden opacity-0"
                  />
                  <CircleArrowUp className="relative size-4" />
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-update ring-2 ring-sidebar"
                  />
                </span>
                <span>Update available</span>
                <span className="ml-auto rounded-full bg-update px-1.5 py-px font-mono text-[10px] leading-4 text-update-foreground">
                  {pendingUpdate.version}
                </span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                tooltip="Check for updates"
                onClick={() => setUpdateOpen(true)}
                className="text-muted-foreground"
              >
                <CircleArrowUp />
                <span>Update</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <CliHelpDialog open={cliHelpOpen} onOpenChange={setCliHelpOpen} />
      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        page={settingsPage}
        onPageChange={setSettingsPage}
        format={{ baseUrl, sessionId, format, onApply: onChangeFormat }}
      />
      <UpdateDialog open={updateOpen} onOpenChange={setUpdateOpen} onChecked={setPendingUpdate} />
      <SidebarRail />
    </Sidebar>
  );
}

/** A small segmented radio group, like the minimap's axis switch */
function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string; title: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} title={label} className="inline-flex rounded-md border bg-background p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
            value === o.value ? "bg-secondary text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
