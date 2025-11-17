import { useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";

interface LogViewerProps {
    url: string;
    maxLines?: number;
    showDelta: boolean; // controlled by parent
}

function formatDelta(ms: number): string {
    if (ms < 0.001) return `${Math.round(ms * 1_000_000)} µs`;
    else if (ms < 1000) return `${Math.round(ms)} ms`;
    else return `${(ms / 1000).toFixed(2)} s`;
}

export const LogViewer: React.FC<LogViewerProps> = ({ url, maxLines = 2000, showDelta }) => {
    const linesRef = useRef<string[]>([]);         
    const bufferRef = useRef<string[]>([]);        
    const evtRef = useRef<EventSource | null>(null);
    const prevUrlRef = useRef<string | null>(null);
    const [, forceRender] = useState(0);          

    // Clear logs when URL changes (filters)
    useEffect(() => {
        if (prevUrlRef.current !== url) {
            linesRef.current = [];
            bufferRef.current = [];
            prevUrlRef.current = url;
            forceRender(r => r + 1);
        }
    }, [url]);

    // SSE + buffer
    useEffect(() => {
        const es = new EventSource(url);
        evtRef.current = es;

        es.onmessage = (event) => {
            bufferRef.current.push(event.data);
        };

        const flushInterval = setInterval(() => {
            if (bufferRef.current.length === 0) return;

            linesRef.current = [...linesRef.current, ...bufferRef.current];
            bufferRef.current = [];

            if (linesRef.current.length > maxLines) {
                linesRef.current = linesRef.current.slice(linesRef.current.length - maxLines);
            }

            forceRender(r => r + 1);
        }, 100);

        es.onerror = (err) => {
            console.error("SSE error:", err);
            es.close();
        };

        return () => {
            es.close();
            clearInterval(flushInterval);
        };
    }, [url, maxLines]);

    let prevTimestamp = 0;

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
                    itemContent={(index, line) => {
                        // Timestamp
                        const tsMatch = line.match(/^\[(.*?)\]/);
                        let timestampStr = "";
                        let deltaStr = "";
                        if (tsMatch) {
                            timestampStr = tsMatch[0];
                            const currentTs = new Date(tsMatch[1]).getTime();
                            if (showDelta && prevTimestamp !== 0) {
                                const delta = currentTs - prevTimestamp;
                                deltaStr = formatDelta(delta);
                            }
                            prevTimestamp = currentTs;
                        }

                        // Log level coloring
                        const levelMatch = line.match(/\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/);
                        const level = levelMatch ? levelMatch[1] : null;

                        const colorMap: Record<string, string> = {
                            TRACE: "#888",
                            DEBUG: "#ADD8E6",
                            INFO: "#fff",
                            WARN: "orange",
                            ERROR: "red"
                        };

                        // Split line for display
                        let beforeLevel = line;
                        let afterLevel = "";
                        if (levelMatch) {
                            const idx = levelMatch.index!;
                            beforeLevel = line.slice(0, idx);
                            afterLevel = line.slice(idx + levelMatch[0].length);
                        }

                        return (
                            <div style={{ fontFamily: "monospace", paddingLeft: 10 }}>
                                <span style={{ color: "#888" }}>{index + 1}</span>:
                                {timestampStr}{" "}
                                {deltaStr && (
                                    <span style={{ color: "#888", fontStyle: "italic", marginLeft: 4 }}>
                                        (+{deltaStr})
                                    </span>
                                )}{" "}
                                {beforeLevel.replace(timestampStr, "")}
                                {level && (
                                    <span style={{ color: colorMap[level], fontWeight: "bold" }}>
                                        [{level}]
                                    </span>
                                )}
                                {afterLevel}
                            </div>
                        );
                    }}
                />
            )}
        </div>
    );
};
