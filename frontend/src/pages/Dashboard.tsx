import { useEffect, useState } from "react";
import { LogViewer } from "../components/LogViewer";
import type { LogSummary } from "../../openapi/client/models/LogSummary";
import SearchableMultiSelect from "../components/SearchableMultiSelect";
import { Card, CardContent } from "../components/ui/card";
import LogSummaryCard from "../components/LogSummaryCard";
import LogViewerOptionsCard from "../components/LogViewerOptionsCard";

interface DashboardProps {
    sessionId: string;
    baseUrl: string; // e.g. "http://localhost:8080"
    summary: LogSummary;
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl, summary }) => {
    const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
    const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
    const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
    const [newKeyword, setNewKeyword] = useState<string>("");
    const [debouncedLevels, setDebouncedLevels] = useState<string>("");
    const [debouncedDomains, setDebouncedDomains] = useState<string>("");
    const [debouncedKeywords, setDebouncedKeywords] = useState<string>("");

    const [showDelta, setShowDelta] = useState(false); // controls delta display

    // Debounce changes to selected arrays before updating query params
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(selectedLevels.join(","));
            setDebouncedDomains(selectedDomains.join(","));
            setDebouncedKeywords(selectedKeywords.join(","));
        }, 300);
        return () => clearTimeout(timer);
    }, [selectedLevels, selectedDomains, selectedKeywords]);

    const levelOptions = Object.keys(summary.levels || {});
    const domainOptions = summary.unique_domains || [];

    const levelsParam = debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : "";
    const domainsParam = debouncedDomains ? `&domains=${encodeURIComponent(debouncedDomains)}` : "";
    const keywordsParam = debouncedKeywords ? `&keywords=${encodeURIComponent(debouncedKeywords)}` : "";
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

            {/* Show delta options card */}
            <LogViewerOptionsCard showDelta={showDelta} setShowDelta={setShowDelta} />

            {/* Filters - searchable multi-selects for Levels and Domains (single enclosing card, horizontal layout) */}
            <Card className="mb-3">
                <CardContent className="pl-2">
                    <div className="flex justify-between">
                        <div className="flex items-center">
                            <span className="text-sm font-medium mr-2">Levels</span>
                            <SearchableMultiSelect options={levelOptions} selected={selectedLevels} onChange={setSelectedLevels} />
                        </div>

                        <div className="flex items-center">
                            <span className="text-sm font-medium mr-2">Domains</span>
                            <SearchableMultiSelect options={domainOptions} selected={selectedDomains} onChange={setSelectedDomains} />
                        </div>

                        <div className="flex items-center">
                            <span className="text-sm font-medium mr-2">Keywords</span>  
                            <div className="flex gap-2">
                                <div className="flex items-center align-center justify-center gap-2">
                                    <input
                                        value={newKeyword}
                                        onChange={(e) => setNewKeyword(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                const val = newKeyword.trim();
                                                if (val) {
                                                    setSelectedKeywords((s) => [...s, val]);
                                                    setNewKeyword("");
                                                }
                                            }
                                        }}
                                        placeholder="Add keyword and press Enter"
                                        className="border rounded align-center px-2 py-1 w-48"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const val = newKeyword.trim();
                                            if (val) {
                                                setSelectedKeywords((s) => [...s, val]);
                                                setNewKeyword("");
                                            }
                                        }}
                                        className="px-2 py-1 align-center border rounded"
                                    >
                                        +
                                    </button>
                                </div>

                                <div className="flex gap-2 flex-wrap justify-center">
                                    {selectedKeywords.map((kw) => (
                                        <div key={kw} className="inline-flex align-center items-center gap-2 px-2 py-1 bg-gray-100 rounded text-sm">
                                            <span>{kw}</span>
                                            <button
                                                type="button"
                                                onClick={() => setSelectedKeywords((s) => s.filter((x) => x !== kw))}
                                                className="text-xs align-center px-1"
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </div>

                                <div className="border-t border-gray-200 my-2" />

                                <div>
                                    <button type="button" onClick={() => setSelectedKeywords([])} className="px-2 py-1 border rounded">Clear all</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* LogViewer */}
            <LogViewer url={logUrl} maxLines={100000} showDelta={showDelta} />
        </div>
    );
};
