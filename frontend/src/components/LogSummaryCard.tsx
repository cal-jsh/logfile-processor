import type { LogSummary } from "../openapi/client/models/LogSummary";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

export default function LogSummaryCard({ summary }: Props) {
  const duration = calculateDuration(summary.start_timestamp, summary.stop_timestamp);
  
  return (
    <Card className="p-2">
      <div className="flex items-center justify-around">
        {/* Header with title */}
        <div className="">
          <h3 className="text-lg font-semibold">Logfile Summary</h3>
        </div>

        <div>
          <span className="text-sm text-muted-foreground">
            {summary.total_lines.toLocaleString()} lines
          </span>
        </div>
        {/* Time range and duration */}
        <div className="flex gap-4 text-sm">
          {summary.start_timestamp && (
            <div className="gap-2">
              <span className="text-muted-foreground">Start:</span>
              <span className="font-mono text-xs px-2 rounded">
                {summary.start_timestamp}
              </span>
            </div>
          )}
          {summary.stop_timestamp && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Stop:</span>
              <span className="font-mono text-xs px-2 rounded">
                {summary.stop_timestamp}
              </span>
            </div>
          )}
          {duration && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Duration:</span>
              <span className="font-mono text-xs px-2 rounded font-semibold">
                {duration}
              </span>
            </div>
          )}
        </div>

        {/* Level badges */}
        <div className="flex flex-wrap items-center gap-4">
          {LEVEL_ORDER.map((level) => {
            const count = summary.levels?.[level] ?? 0;

            return (
              <div
                key={level}
                className="flex items-center gap-2"
              >
                <span className="text-muted-foreground text-sm w-12 font-medium">
                  {level}
                </span>

                <Badge
                  className="h-5 min-w-5 rounded-full px-2 font-mono tabular-nums"
                  style={{ color: colorMap[level] }}
                  variant="outline"
                >
                  {count}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
