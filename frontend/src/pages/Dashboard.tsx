import { useEffect, useState } from "react";
import { LogViewer } from "../components/LogViewer";
import type { LogSummary } from "../../openapi/client/models/LogSummary";

interface DashboardProps {
    sessionId: string;
    baseUrl: string; // e.g. "http://localhost:8080"
    summary: LogSummary;
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl, summary }) => {
    const [selectedLevels, setSelectedLevels] = useState<Set<string>>(new Set());
    const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
    const [debouncedLevels, setDebouncedLevels] = useState<string>("");
    const [debouncedDomains, setDebouncedDomains] = useState<string>("");

    const [showDelta, setShowDelta] = useState(false); // controls delta display

    // Initialize selected sets from summary (all selected by default)
    useEffect(() => {
        if (!summary) return;
        setSelectedLevels(new Set(Object.keys(summary.levels || {})));
        setSelectedDomains(new Set(summary.unique_domains || []));
    }, [summary]);

    // Debounce changes to selected sets before updating query params
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(Array.from(selectedLevels).join(","));
            setDebouncedDomains(Array.from(selectedDomains).join(","));
        }, 300);
        return () => clearTimeout(timer);
    }, [selectedLevels, selectedDomains]);

    const toggleLevel = (level: string) => {
        setSelectedLevels((prev) => {
            const next = new Set(prev);
            if (next.has(level)) next.delete(level);
            else next.add(level);
            return next;
        });
    };

    const toggleDomain = (domain: string) => {
        setSelectedDomains((prev) => {
            const next = new Set(prev);
            if (next.has(domain)) next.delete(domain);
            else next.add(domain);
            return next;
        });
    };

    const selectAllLevels = () => setSelectedLevels(new Set(Object.keys(summary.levels || {})));
    const deselectAllLevels = () => setSelectedLevels(new Set());
    const selectAllDomains = () => setSelectedDomains(new Set(summary.unique_domains || []));
    const deselectAllDomains = () => setSelectedDomains(new Set());

    const levelsParam = debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : "";
    const domainsParam = debouncedDomains ? `&domains=${encodeURIComponent(debouncedDomains)}` : "";
    const logUrl = `${baseUrl}/stream_logs?session_id=${sessionId}${levelsParam}${domainsParam}`;

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
            <h1>Logfile Processor</h1>

            {/* Filters - collapsible checkbox lists for Levels and Domains */}
            <div style={{ marginBottom: "10px", background: "#353333ff", padding: 8, borderRadius: 4 }}>
                <details style={{ display: "inline-block", marginRight: 16 }} open>
                    <summary style={{ color: "#fff", cursor: "pointer" }}>
                        Levels ({selectedLevels.size} selected)
                    </summary>
                    <div style={{ padding: 8, background: "#fff", color: "#000", borderRadius: 4 }}>
                        <div style={{ marginBottom: 8 }}>
                            <button onClick={selectAllLevels} style={{ marginRight: 8 }}>Select All</button>
                            <button onClick={deselectAllLevels}>Deselect All</button>
                        </div>
                        <div style={{ maxHeight: 200, overflow: "auto" }}>
                            {Object.keys(summary.levels || {}).map((level) => (
                                <label key={level} style={{ display: "block", marginBottom: 4 }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedLevels.has(level)}
                                        onChange={() => toggleLevel(level)}
                                        style={{ marginRight: 8 }}
                                    />
                                    {level} ({(summary.levels as any)[level]})
                                </label>
                            ))}
                        </div>
                    </div>
                </details>

                <details style={{ display: "inline-block", marginRight: 16 }} open>
                    <summary style={{ color: "#fff", cursor: "pointer" }}>
                        Domains ({selectedDomains.size} selected)
                    </summary>
                    <div style={{ padding: 8, background: "#fff", color: "#000", borderRadius: 4 }}>
                        <div style={{ marginBottom: 8 }}>
                            <button onClick={selectAllDomains} style={{ marginRight: 8 }}>Select All</button>
                            <button onClick={deselectAllDomains}>Deselect All</button>
                        </div>
                        <div style={{ maxHeight: 200, overflow: "auto" }}>
                            {(summary.unique_domains || []).map((domain) => (
                                <label key={domain} style={{ display: "block", marginBottom: 4 }}>
                                    <input
                                        type="checkbox"
                                        checked={selectedDomains.has(domain)}
                                        onChange={() => toggleDomain(domain)}
                                        style={{ marginRight: 8 }}
                                    />
                                    {domain}
                                </label>
                            ))}
                        </div>
                    </div>
                </details>

                {/* Show delta checkbox */}
                <label style={{ marginLeft: "20px", color: "#fff"}}>
                    <input
                        type="checkbox"
                        checked={showDelta}
                        onChange={(e) => setShowDelta(e.target.checked)}
                        style={{ marginRight: 4 }}
                    />
                    Show time delta
                </label>
            </div>

            {/* LogViewer */}
            <LogViewer url={logUrl} maxLines={100000} showDelta={showDelta} />
        </div>
    );
};
