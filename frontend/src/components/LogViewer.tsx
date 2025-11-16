import { useEffect, useRef, useState } from "react";

interface LogViewerProps {
    url: string;           // SSE URL with session_id & optional filters
    maxLines?: number;     // maximum lines to keep in state
}

export const LogViewer: React.FC<LogViewerProps> = ({ url, maxLines = 2000 }) => {
    const [lines, setLines] = useState<string[]>([]);
    const evtSourceRef = useRef<EventSource | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Connect SSE whenever url changes
    useEffect(() => {
        setLines([]); // clear previous log lines

        const evtSource = new EventSource(url);
        evtSourceRef.current = evtSource;

        evtSource.onmessage = (event) => {
            setLines((prev) => {
                const newLines = [...prev, event.data];
                if (newLines.length > maxLines) {
                    newLines.splice(0, newLines.length - maxLines);
                }
                return newLines;
            });
        };

        evtSource.onerror = (err) => {
            console.error("SSE error:", err);
            evtSource.close();
        };

        return () => {
            evtSource.close();
        };
    }, [url, maxLines]);

    // Auto-scroll to bottom when new lines arrive
    useEffect(() => {
        if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [lines]);

    return (
        <div
            ref={containerRef}
            style={{
                height: "400px",
                overflowY: "auto",
                backgroundColor: "#1e1e1e",
                color: "#ffffff",
                padding: "10px",
                fontFamily: "monospace",
                borderRadius: "6px",
                whiteSpace: "pre",
            }}
        >
            {lines.length === 0 ? (
                <p>No logs yet.</p>
            ) : (
                lines.map((line, idx) => (
                    <div key={idx}>
                        <span style={{ color: "#888" }}>{idx + 1}</span>: {line}
                    </div>
                ))
            )}
        </div>
    );
};
