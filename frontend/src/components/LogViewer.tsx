import { useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";

interface LogViewerProps {
    url: string;
    maxLines?: number;
}

export const LogViewer: React.FC<LogViewerProps> = ({ url, maxLines = 2000 }) => {
    const linesRef = useRef<string[]>([]);          // Persistent log storage
    const bufferRef = useRef<string[]>([]);         // Incoming messages buffer
    const evtRef = useRef<EventSource | null>(null);
    const prevUrlRef = useRef<string | null>(null);
    const [, forceRender] = useState(0);           // Force Virtuoso re-render

    // Clear logs when URL changes (filter change)
    useEffect(() => {
        if (prevUrlRef.current !== url) {
            linesRef.current = [];
            bufferRef.current = [];
            prevUrlRef.current = url;
            forceRender(r => r + 1); // trigger re-render
        }
    }, [url]);

    // SSE + buffer + flush interval
    useEffect(() => {
        const es = new EventSource(url);
        evtRef.current = es;

        es.onmessage = (event) => {
            bufferRef.current.push(event.data);
        };

        const flushInterval = setInterval(() => {
            if (bufferRef.current.length === 0) return;

            // Append buffered messages to the persistent ref
            linesRef.current = [...linesRef.current, ...bufferRef.current];
            bufferRef.current = [];

            // Trim to maxLines
            if (linesRef.current.length > maxLines) {
                linesRef.current = linesRef.current.slice(linesRef.current.length - maxLines);
            }

            // Trigger re-render for Virtuoso
            forceRender(r => r + 1);
        }, 100); // flush 10x/sec

        es.onerror = (err) => {
            console.error("SSE error:", err);
            es.close();
        };

        return () => {
            es.close();
            clearInterval(flushInterval);
        };
    }, [url, maxLines]);

    return (
        <div style={{ height: 750, border: "1px solid #ccc", borderRadius: 4, overflow: "hidden" }}>
            {linesRef.current.length === 0 ? (
                <div
                    style={{
                        padding: 10,
                        background: "#1e1e1e",
                        color: "#fff",
                        fontFamily: "monospace"
                    }}
                >
                    No logs yet.
                </div>
            ) : (
                <Virtuoso
                    style={{ height: "100%", background: "#1e1e1e", color: "white" }}
                    data={linesRef.current}
                    followOutput="smooth"
                    itemContent={(index, line) => (
                        <div style={{ fontFamily: "monospace", paddingLeft: 10 }}>
                            <span style={{ color: "#888" }}>{index + 1}</span>: {line}
                        </div>
                    )}
                />
            )}
        </div>
    );
};
