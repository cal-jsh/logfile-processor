import { useState } from "react";
import { OpenAPI } from "../openapi/client/core/OpenAPI";
import { request as __request } from "../openapi/client/core/request";
import type { LogSummary } from "../openapi/client/models/LogSummary";
import { Dashboard } from "./pages/Dashboard";

export default function App() {
    const [summary, setSummary] = useState<LogSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showDashboard, setShowDashboard] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null); // <-- new

    const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const formData = new FormData();
        formData.append("file", file);

        try {
            const response = await __request(OpenAPI, {
                method: "POST",
                url: "/upload",
                body: formData,
            });

            // The backend should return { session_id, summary }
            const { session_id, summary } = response as any;
            console.log("Upload response:", response);

            setSessionId(session_id);      // store session_id
            setSummary(summary);           // store log summary
            setError(null);
            setShowDashboard(true);        // switch to Dashboard
        } catch (err: any) {
            setError("Upload failed");
            console.error(err);
        }
    };

    if (showDashboard && summary && sessionId) {
        // Pass session_id to Dashboard so it can connect to SSE
        return (
            <Dashboard
                sessionId={sessionId}
                baseUrl="http://localhost:8080"
            />
        );
    }

    return (
        <div
            style={{
                height: "100vh",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
                textAlign: "center",
                gap: "20px",
            }}
        >
            <label
                style={{
                    display: "inline-block",
                    padding: "12px 24px",
                    backgroundColor: "#1976d2",
                    color: "white",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "16px",
                }}
            >
                Upload Log File
                <input
                    type="file"
                    accept=".txt"
                    onChange={handleUpload}
                    style={{ display: "none" }}
                />
            </label>

            {summary && (
                <div
                    style={{
                        marginTop: "20px",
                        padding: "20px",
                        background: "#f5f5f5",
                        borderRadius: "8px",
                        width: "400px",
                        textAlign: "left",
                    }}
                >
                    <h3>Log Summary</h3>

                    <h4>Levels</h4>
                    <ul>
                        {Object.entries(summary.levels).map(([level, count]) => (
                            <li key={level}>
                                {level}: {count}
                            </li>
                        ))}
                    </ul>

                    <h4>Total Lines</h4>
                    <p>{summary.total_lines}</p>

                    <h4>Unique Domains</h4>
                    <ul>
                        {summary.unique_domains.map((domain) => (
                            <li key={domain}>{domain}</li>
                        ))}
                    </ul>
                </div>
            )}

            {error && <p style={{ color: "red" }}>{error}</p>}
        </div>
    );
}
