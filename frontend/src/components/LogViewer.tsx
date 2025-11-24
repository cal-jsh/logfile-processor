import { useEffect, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { colorMap } from "../lib/colorMap";
import { Spinner } from "./ui/spinner";

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
    const [isConnecting, setIsConnecting] = useState(false);

    // Mark connecting when URL changes; keep existing lines visible until new data arrives
    useEffect(() => {
        if (prevUrlRef.current !== url) {
            linesRef.current = [];
            bufferRef.current = [];
            prevUrlRef.current = url;
            setIsConnecting(true);
            forceRender(r => r + 1);
        }
    }, [url]);

    // SSE + buffer
    useEffect(() => {
        // close any previously-open EventSource to avoid duplicates
        if (evtRef.current) {
            try { evtRef.current.close(); } catch (_) {}
            evtRef.current = null;
        }

        const es = new EventSource(url);
        evtRef.current = es;

        es.onopen = () => {
            console.log("SSE opened");
            setIsConnecting(false);
        };

        es.onmessage = (event) => {
            if (isConnecting) {
                setIsConnecting(false);
            }

            bufferRef.current.push(event.data);
        };


        const flushInterval = setInterval(() => {
            // once we have flushed new lines, stop showing the connecting spinner
            if (isConnecting && linesRef.current.length > 0) {
                setIsConnecting(false);
            }

            if (bufferRef.current.length === 0) return;

            linesRef.current = [...linesRef.current, ...bufferRef.current];
            bufferRef.current = [];

            if (linesRef.current.length > maxLines) {
                linesRef.current = linesRef.current.slice(linesRef.current.length - maxLines);
            }


            forceRender(r => r + 1);
        }, 50);

        es.onerror = (err) => {
            console.error("SSE error:", err);
            // stop showing connecting spinner on error
            setIsConnecting(false);
            try { es.close(); } catch (_) {}
            if (evtRef.current === es) evtRef.current = null;
            clearInterval(flushInterval);
        };

        return () => {
            try { es.close(); } catch (_) {}
            if (evtRef.current === es) evtRef.current = null;
            clearInterval(flushInterval);
        };
    }, [url, maxLines]);

    let prevTimestamp = 0;

    return (
        <div style={{ height: 750, border: "1px solid #ccc", borderRadius: 4, overflow: "hidden", position: "relative" }}>
            {isConnecting ? (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)", zIndex: 50 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                        <Spinner className="h-8 w-8 text-white" />
                        <div style={{ color: "#fff", fontSize: 12 }}>Reconnecting...</div>
                    </div>
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
