import { useEffect, useState } from "react";
import { LogViewer } from "../components/LogViewer";

interface DashboardProps {
    sessionId: string;
    baseUrl: string; // e.g. "http://localhost:8080"
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl }) => {
    const [levels, setLevels] = useState<string>(""); // e.g., "INFO,DEBUG"
    const [domains, setDomains] = useState<string>(""); // e.g., "auth,db"
    const [debouncedLevels, setDebouncedLevels] = useState(levels);
    const [debouncedDomains, setDebouncedDomains] = useState(domains);

    // Debounce filter changes
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(levels);
            setDebouncedDomains(domains);
        }, 300);
        return () => clearTimeout(timer);
    }, [levels, domains]);

    // SSE URL
    const logUrl = `${baseUrl}/stream_logs?session_id=${sessionId}${debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : ""
        }${debouncedDomains ? `&domains=${encodeURIComponent(debouncedDomains)}` : ""}`;

    useEffect(() => {
        const cleanupSession = () => {
            const url = `${baseUrl}/close_session?session_id=${encodeURIComponent(sessionId)}`;
            navigator.sendBeacon(url); // reliable during unload
        };

        window.addEventListener("beforeunload", cleanupSession);
        window.addEventListener("unload", cleanupSession);

        // Only cleanup the event listeners on unmount, do NOT call cleanupSession()
        return () => {
            window.removeEventListener("beforeunload", cleanupSession);
            window.removeEventListener("unload", cleanupSession);
        };
    }, [sessionId, baseUrl]);

    return (
        <div style={{ padding: "20px" }}>
            <h1>Dashboard</h1>

            {/* Optional filter inputs */}
            <div style={{ marginBottom: "10px" }}>
                <label>
                    Levels (comma-separated):
                    <input
                        type="text"
                        value={levels}
                        onChange={(e) => setLevels(e.target.value)}
                        style={{ marginLeft: "8px" }}
                    />
                </label>
                <label style={{ marginLeft: "20px" }}>
                    Domains (comma-separated):
                    <input
                        type="text"
                        value={domains}
                        onChange={(e) => setDomains(e.target.value)}
                        style={{ marginLeft: "8px" }}
                    />
                </label>
            </div>

            {/* LogViewer streaming logs from backend */}
            <LogViewer url={logUrl} maxLines={100000} />
        </div>
    );
};
