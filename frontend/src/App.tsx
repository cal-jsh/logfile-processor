import { useState } from "react";
import { OpenAPI } from "../openapi/client/core/OpenAPI";
import { request as __request } from "../openapi/client/core/request";
import type { LogSummary } from "../openapi/client/models/LogSummary";
import { Dashboard } from "./pages/Dashboard";

// shadcn/ui components
import { Input } from "@/components/ui/input"
import {
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemTitle,
} from "@/components/ui/item"

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
        // Pass session_id and summary to Dashboard so it can initialize filters and connect to SSE
        return (
            <Dashboard
                sessionId={sessionId}
                baseUrl="http://localhost:8080"
                summary={summary}
            />
        );
    }

    return (
        <div className="flex flex-col gap-6"
            style={{
                height: "100vh",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
            }}
        >
            <Item variant="outline">
                <ItemContent>
                    <ItemTitle>Logfile Upload</ItemTitle>
                    <ItemDescription>
                        Please select the logfile you wish to analyze.
                    </ItemDescription>
                </ItemContent>
                <ItemActions>
                    <Input id="logfile-upload" type="file" accept=".txt" onChange={handleUpload} className="cursor-pointer border hover:bg-gray-100 transition-colors" />
                </ItemActions>
            </Item>

            {error && <p style={{ color: "red" }}>{error}</p>}
        </div>
    );
}
