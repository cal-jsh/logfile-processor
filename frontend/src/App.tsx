import { useState } from "react";
import { OpenAPI } from "../openapi/client/core/OpenAPI";
import { request as __request } from "../openapi/client/core/request";
import type { LogSummary } from "../openapi/client/models/LogSummary";

export default function App() {
    const [result, setResult] = useState<LogSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

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

            setResult(response as LogSummary);
            setError(null);
        } catch (err: any) {
            setError("Upload failed");
            console.error(err);
        }
    };

    return (
        <div style={{
            height: "100vh",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
            gap: "20px"
        }}>
            <label
                style={{
                    display: "inline-block",
                    padding: "12px 24px",
                    backgroundColor: "#1976d2",
                    color: "white",
                    borderRadius: "8px",
                    cursor: "pointer",
                    fontSize: "16px"
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

            {result && (
                <div style={{
                    marginTop: "20px",
                    padding: "20px",
                    background: "#f5f5f5",
                    borderRadius: "8px",
                    width: "400px",
                    textAlign: "left"
                }}>
                    <h3>Log Summary</h3>

                    <h4>Levels</h4>
                    <ul>
                        {Object.entries(result.levels).map(([level, count]) => (
                            <li key={level}>
                                {level}: {count}
                            </li>
                        ))}
                    </ul>

                    <h4>Total Lines</h4>
                    <p>{result.total_lines}</p>

                    <h4>Unique Domains</h4>
                    <ul>
                        {result.unique_domains.map((domain) => (
                            <li key={domain}>{domain}</li>
                        ))}
                    </ul>
                </div>
            )}

            {error && <p style={{ color: "red" }}>{error}</p>}
        </div>
    );
}
