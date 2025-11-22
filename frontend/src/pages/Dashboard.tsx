import { useEffect, useState } from "react";
import { LogViewer } from "../components/LogViewer";
import type { LogSummary } from "../../openapi/client/models/LogSummary";
import SearchableMultiSelect from "../components/ui/searchablemultiselect";
import LogSummaryCard from "../components/LogSummaryCard";
import { Label } from "../components/ui/label";
import { Checkbox } from "../components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "../components/ui/collapsible";
import { Ellipsis } from "lucide-react"
import { Button } from "@/components/ui/button"

interface DashboardProps {
    sessionId: string;
    baseUrl: string; // e.g. "http://localhost:8080"
    summary: LogSummary;
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl, summary }) => {
    const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
    const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
    const [debouncedLevels, setDebouncedLevels] = useState<string>("");
    const [debouncedDomains, setDebouncedDomains] = useState<string>("");

    const [showDelta, setShowDelta] = useState(false); // controls delta display

    // Initialize selected arrays from summary (all selected by default)
    useEffect(() => {
        if (!summary) return;
        setSelectedLevels(Object.keys(summary.levels || {}));
        setSelectedDomains(summary.unique_domains || []);
    }, [summary]);

    // Debounce changes to selected arrays before updating query params
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(selectedLevels.join(","));
            setDebouncedDomains(selectedDomains.join(","));
        }, 300);
        return () => clearTimeout(timer);
    }, [selectedLevels, selectedDomains]);

    const levelOptions = Object.keys(summary.levels || {});
    const domainOptions = summary.unique_domains || [];

    const selectAllLevels = () => setSelectedLevels(levelOptions.slice());
    const deselectAllLevels = () => setSelectedLevels([]);
    const selectAllDomains = () => setSelectedDomains(domainOptions.slice());
    const deselectAllDomains = () => setSelectedDomains([]);

    const levelsParam = debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : "";
    const domainsParam = debouncedDomains ? `&domains=${encodeURIComponent(debouncedDomains)}` : "";
    const keywordsParam = ""
    const logUrl = `${baseUrl}/stream_logs?session_id=${sessionId}${levelsParam}${domainsParam}${keywordsParam}`;

    useEffect(() => {
        const cleanupSession = () => {
            const url = `${baseUrl}/close_session?session_id=${encodeURIComponent(sessionId)}`;
            navigator.sendBeacon(url);
        };

        window.addEventListener("beforeunload", cleanupSession);
        window.addEventListener("unload", cleanupSession);

        return () => {
            window.removeEventListener("beforeunload", cleanupSession);
            window.removeEventListener("unload", cleanupSession);
        };
    }, [sessionId, baseUrl]);

    return (
        <div style={{ padding: "20px" }}>
            <div style={{ marginBottom: 12 }}>
                <LogSummaryCard summary={summary} />
            </div>

            {/* Show delta checkbox (shadcn UI) */}
            <Card className="p-2 mb-4">
                <Collapsible defaultOpen={true} className="flex flex-wrap justify-between w-full">
                    <CardHeader className="p-0">
                        <div className="flex items-center justify-around">
                            <CardTitle className="text-sm m-0 mr-2">Display Options</CardTitle>
                            <CollapsibleTrigger asChild>
                                <Button variant="ghost" size="icon" className="size-8">
                                    <Ellipsis />
                                    <span className="sr-only">Toggle</span>
                                </Button>
                            </CollapsibleTrigger>
                        </div>
                    </CardHeader>
                    <CardContent className="p-0">
                        <CollapsibleContent>
                            <div className="mt-0">
                                <Label htmlFor="toggle-show-delta" className="flex items-start gap-3">
                                    <Checkbox
                                        id="toggle-show-delta"
                                        checked={showDelta}
                                        onCheckedChange={(checked: boolean | "indeterminate") => setShowDelta(!!checked)}
                                        className="data-[state=checked]:border-blue-600 data-[state=checked]:bg-blue-600 data-[state=checked]:text-white dark:data-[state=checked]:border-blue-700 dark:data-[state=checked]:bg-blue-700"
                                    />
                                    <div className="grid gap-1.5 font-normal">
                                        <p className="text-sm leading-none font-medium">Show time delta</p>
                                        <p className="text-muted-foreground text-sm">You can enable or disable showing the time difference between log entries.</p>
                                    </div>
                                </Label>
                            </div>
                        </CollapsibleContent>
                    </CardContent>
                </Collapsible>
            </Card>

            {/* Filters - searchable multi-selects for Levels and Domains */}
            <div style={{ marginBottom: "10px", background: "#ffffffff", padding: 8, borderRadius: 4, display: 'flex', gap: 12, alignItems: 'center', borderColor: '#00000033', borderWidth: 1, borderStyle: 'solid' }}>
                <div>
                    <div style={{ color: '#000000ff', marginBottom: 6 }}>Levels ({selectedLevels.length} selected)</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <SearchableMultiSelect options={levelOptions} selected={selectedLevels} onChange={setSelectedLevels} />
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <button onClick={selectAllLevels} style={{ marginBottom: 6 }}>All</button>
                            <button onClick={deselectAllLevels}>None</button>
                        </div>
                    </div>
                </div>

                <div>
                    <div style={{ color: '#080808ff', marginBottom: 6 }}>Domains ({selectedDomains.length} selected)</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <SearchableMultiSelect options={domainOptions} selected={selectedDomains} onChange={setSelectedDomains} />
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <button onClick={selectAllDomains} style={{ marginBottom: 6 }}>All</button>
                            <button onClick={deselectAllDomains}>None</button>
                        </div>
                    </div>
                </div>
            </div>

            {/* LogViewer */}
            <LogViewer url={logUrl} maxLines={100000} showDelta={showDelta} />
        </div>
    );
};
