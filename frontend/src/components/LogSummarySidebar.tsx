import type { LogSummary } from "../../openapi/client/models/LogSummary";
import {
  Sidebar,
  SidebarContent,
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
import { colorMap, LEVEL_ORDER } from "../lib/colorMap";
import type { MinimapAxis } from "./Minimap";
import { cn } from "@/lib/utils";
import { FileText, FolderOpen, Minus, Plus, Search } from "lucide-react";

interface Props {
  summary: LogSummary;
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

function duration(start?: string | null, stop?: string | null): string | null {
  if (!start || !stop) return null;
  const a = new Date(start).getTime();
  const b = new Date(stop).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
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
  contextLines,
  setContextLines,
}: Props) {
  const dur = duration(summary.start_timestamp, summary.stop_timestamp);
  const levelCounts = LEVEL_ORDER.map((l) => ({ level: l, count: summary.levels?.[l] ?? 0 }));
  const levelTotal = levelCounts.reduce((a, b) => a + b.count, 0);
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
                <span className="text-xs text-muted-foreground">Log levels across the file, click to jump</span>
              </div>
            </label>

            {showMinimap && (
              <div className="-mt-1 flex items-center gap-2 pl-6.5">
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
      <SidebarRail />
    </Sidebar>
  );
}
