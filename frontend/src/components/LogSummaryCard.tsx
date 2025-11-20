import type { LogSummary } from "../openapi/client/models/LogSummary";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { colorMap, LEVEL_ORDER } from "../lib/colorMap";

interface Props {
    summary: LogSummary;
}

export default function LogSummaryCard({ summary }: Props) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between w-full">
        <h3 className="text-lg font-semibold">Logfile Summary</h3>

        <div className="flex flex-wrap items-center gap-4">
          {LEVEL_ORDER.map((level) => {
            const count = summary.levels?.[level] ?? 0;

            return (
              <div
                key={level}
                className="flex items-center gap-2"
              >
                <span className="text-muted-foreground w-12 font-medium">
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
