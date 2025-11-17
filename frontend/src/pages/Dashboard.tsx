import { useEffect, useState } from "react";
import { LogViewer } from "../components/LogViewer";

interface DashboardProps {
    sessionId: string;
    baseUrl: string; // e.g. "http://localhost:8080"
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl }) => {
    const [levels, setLevels] = useState<string>(""); 
    const [domains, setDomains] = useState<string>(""); 
    const [debouncedLevels, setDebouncedLevels] = useState(levels);
    const [debouncedDomains, setDebouncedDomains] = useState(domains);

    const [showDelta, setShowDelta] = useState(false); // NEW: controls delta display

    // Debounce filter changes
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(levels);
            setDebouncedDomains(domains);
        }, 300);
        return () => clearTimeout(timer);
    }, [levels, domains]);

    const logUrl = `${baseUrl}/stream_logs?session_id=${sessionId}${debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : ""
        }${debouncedDomains ? `&domains=${encodeURIComponent(debouncedDomains)}` : ""}`;

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

            {/* Filters */}
            <div style={{ marginBottom: "10px", background: "#353333ff", padding: 8, borderRadius: 4 }}>
                <label style={{ marginLeft: "20px", color: "#fff" }}>
                    Levels (comma-separated):
                    <input
                        type="text"
                        value={levels}
                        onChange={(e) => setLevels(e.target.value)}
                        style={{ marginLeft: "8px" }}
                    />
                </label>
                <label style={{ marginLeft: "20px", color: "#fff" }}>
                    Domains (comma-separated):
                    <input
                        type="text"
                        value={domains}
                        onChange={(e) => setDomains(e.target.value)}
                        style={{ marginLeft: "8px" }}
                    />
                </label>
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
