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
} from "./ui/sidebar";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { canonicalLevel, colorMap, LEVEL_ORDER } from "../lib/colorMap";
import type { MinimapAxis } from "./Minimap";
import { cn } from "@/lib/utils";
import { Bug, FileText, FolderOpen, Minus, Plus, Search, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import BugReportDialog from "./BugReportDialog";
import FormatDialog from "./FormatDialog";

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

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-lg border bg-background px-2.5 py-1.5" title={title}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-sm font-semibold tabular-nums">{value}</div>
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
  const [formatOpen, setFormatOpen] = useState(false);
  const format = summary.format;
  const fit = format.sample_lines > 0 ? format.sample_matched / format.sample_lines : 1;
  // fields that can be hidden: all but the message
  const optionalColumns = format.columns.filter((c) => c.kind !== "message");
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
  const otherLines =
    summary.line_count != null && summary.line_count !== summary.total_lines
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
          <SidebarTrigger className="shrink-0" />
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
                value={summary.total_lines.toLocaleString()}
                title={
                  otherLines > 0
                    ? `${summary.line_count!.toLocaleString()} lines in the file, ${otherLines.toLocaleString()} not in the log format`
                    : undefined
                }
              />
              <Stat label="Duration" value={dur ?? "–"} />
            </div>
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

            {/* Level distribution */}
            {levelTotal > 0 && (
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
                  <span className="w-12 font-medium">{level}</span>
                  <span className="ml-auto font-mono tabular-nums">{count.toLocaleString()}</span>
                  <span className="w-10 text-right font-mono tabular-nums text-muted-foreground">
                    {levelTotal > 0 ? `${Math.round((count / levelTotal) * 100)}%` : ""}
                  </span>
                </div>
              ))}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="data-[orientation=horizontal]:w-auto group-data-[collapsible=icon]:hidden" />

        {/* Line format: detected or set by the user */}
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Log format</SidebarGroupLabel>
          <SidebarGroupContent className="flex flex-col gap-1.5 px-2">
            <button
              type="button"
              onClick={() => setFormatOpen(true)}
              title={`${format.pattern}\n\nClick to change`}
              className="group/format flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left hover:bg-accent"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs">{format.pattern}</code>
              <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground group-hover/format:text-foreground" />
            </button>
            <div className={cn("text-[11px]", fit < 0.5 || format.raw ? "text-amber-600" : "text-muted-foreground")}>
              {format.raw
                ? "No known format found: lines shown as they are"
                : `${format.detected ? "Detected" : "Set by you"} · fits ${format.sample_matched.toLocaleString()} of the first ${format.sample_lines.toLocaleString()} lines`}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="data-[orientation=horizontal]:w-auto group-data-[collapsible=icon]:hidden" />

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
              tooltip="Report a bug"
              onClick={() => setBugReportOpen(true)}
              className="text-muted-foreground"
            >
              <Bug />
              <span>Report a bug</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <BugReportDialog open={bugReportOpen} onOpenChange={setBugReportOpen} />
      <FormatDialog
        open={formatOpen}
        onOpenChange={setFormatOpen}
        baseUrl={baseUrl}
        sessionId={sessionId}
        format={format}
        onApply={onChangeFormat}
      />
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
