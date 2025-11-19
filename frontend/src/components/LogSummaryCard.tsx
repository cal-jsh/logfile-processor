import type { LogSummary } from "../openapi/client/models/LogSummary";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { colorMap, LEVEL_ORDER } from "../lib/colorMap";

interface Props {
    summary: LogSummary;
}

export default function LogSummaryCard({ summary }: Props) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>Logfile Summary</CardTitle>
            </CardHeader>
            <CardContent>
                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    {LEVEL_ORDER.map((level) => {
                        const count = (summary.levels as any)?.[level] ?? 0;
                        return (
                            <div key={level} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ color: "#0f0e0eff", minWidth: 48 }}>{level}</div>
                                <Badge
                                    className="h-5 min-w-5 rounded-full px-1 font-mono tabular-nums"
                                    style={{ color: colorMap[level] || undefined }}
                                    variant="outline"
                                >
                                    {count}
                                </Badge>
                            </div>
                        );
                    })}
                </div>
            </CardContent>
        </Card>
    );
}
