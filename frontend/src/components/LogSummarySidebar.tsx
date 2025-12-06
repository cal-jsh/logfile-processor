import React from "react";
import type { LogSummary } from "../openapi/client/models/LogSummary";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarTrigger,
} from "./ui/sidebar";
import { Badge } from "./ui/badge";
import { colorMap, LEVEL_ORDER } from "../lib/colorMap";

interface Props {
  summary: LogSummary;
}

function calculateDuration(startStr: string | undefined | null, stopStr: string | undefined | null): string | null {
  if (!startStr || !stopStr) return null;
  try {
    const start = new Date(startStr);
    const stop = new Date(stopStr);
    if (isNaN(start.getTime()) || isNaN(stop.getTime())) return null;
    const diffMs = stop.getTime() - start.getTime();
    if (diffMs < 0) return null;
    const totalSeconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  } catch {
    return null;
  }
}

export default function LogSummarySidebar({ summary }: Props) {
  const duration = calculateDuration(summary.start_timestamp, summary.stop_timestamp);

  return (
    <Sidebar side="left" collapsible="icon" variant="sidebar">
      <SidebarHeader>
        <div className="flex items-center justify-between w-full">
          <div className="text-sm font-semibold">Logfile Summary</div>
          <SidebarTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Total lines</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="font-mono">{summary.total_lines.toLocaleString()}</div>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Time Range</SidebarGroupLabel>
          <SidebarGroupContent>
            {summary.start_timestamp && (
              <div className="mb-2">
                <div className="text-muted-foreground text-xs">Start</div>
                <div className="font-mono text-xs bg-muted px-2 py-1 rounded inline-block">{summary.start_timestamp}</div>
              </div>
            )}
            {summary.stop_timestamp && (
              <div className="mb-2">
                <div className="text-muted-foreground text-xs">Stop</div>
                <div className="font-mono text-xs bg-muted px-2 py-1 rounded inline-block">{summary.stop_timestamp}</div>
              </div>
            )}
            {duration && (
              <div>
                <div className="text-muted-foreground text-xs">Duration</div>
                <div className="font-mono text-xs bg-muted px-2 py-1 rounded inline-block font-semibold">{duration}</div>
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Levels</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="flex flex-col gap-2">
              {LEVEL_ORDER.map((level) => {
                const count = summary.levels?.[level] ?? 0;
                return (
                  <div key={level} className="flex items-center gap-2">
                    <span className="text-muted-foreground text-sm w-12 font-medium">{level}</span>
                    <Badge className="h-5 min-w-5 rounded-full px-2 font-mono tabular-nums" style={{ color: colorMap[level] }} variant="outline">
                      {count}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </SidebarGroupContent>
        </SidebarGroup>

        
      </SidebarContent>
    </Sidebar>
  );
}
