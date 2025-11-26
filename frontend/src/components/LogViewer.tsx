import { useEffect, useRef, useState, useCallback } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
// NOTE: using a plain div for results scrolling; you can swap back to shadcn ScrollArea if you prefer
import { colorMap } from "../lib/colorMap";
import { Spinner } from "./ui/spinner";
import { Download } from "lucide-react";

/* ---------------- debounce helper (no dependency) ---------------- */
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number) {
    let timer: number;
    return (...args: Parameters<T>) => {
        clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), delay);
    };
}

/* --------- formatDelta --------- */
function formatDelta(ms: number): string {
    if (ms < 0.001) return `${Math.round(ms * 1_000_000)} µs`;
    else if (ms < 1000) return `${Math.round(ms)} ms`;
    else return `${(ms / 1000).toFixed(2)} s`;
}

/* --------- Download helpers --------- */
function downloadAsText(lines: string[]) {
    const content = lines.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function downloadAsCSV(lines: string[]) {
    const csvRows = ["Timestamp,Level,Domain,Message"];

    for (const line of lines) {
        // Pattern: [timestamp] [level] domain message
        // Or: [timestamp] [level] [domain] message
        const match = line.match(/^\[(.*?)\]\s+\[(.*?)\]\s+(.*)$/);

        let timestamp = "";
        let level = "";
        let domain = "";
        let message = "";

        if (match) {
            timestamp = match[1];
            level = match[2];
            const rest = match[3];

            // Try to extract domain from rest: either [domain] message or domain message
            const domainMatch = rest.match(/^(?:\[(.*?)\]|(\S+))\s+(.*)$/);
            if (domainMatch) {
                domain = domainMatch[1] || domainMatch[2] || "";
                message = domainMatch[3] || "";
            } else {
                message = rest;
            }
        } else {
            // Fallback: just use the whole line as message
            message = line;
        }

        // CSV escape: quote the message field
        const escapedMessage = `"${message.replace(/"/g, '\\"')}"`;
        csvRows.push(`${timestamp},${level},${domain},${escapedMessage}`);
    }

    const content = csvRows.join("\n");
    const blob = new Blob([content], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `logs_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

interface LogViewerProps {
    url: string;
    maxLines?: number;
    showDelta: boolean;
}

export const LogViewer: React.FC<LogViewerProps> = ({
    url,
    maxLines = 2000,
    showDelta,
}) => {
    const linesRef = useRef<string[]>([]);
    const bufferRef = useRef<string[]>([]);
    const evtRef = useRef<EventSource | null>(null);
    const prevUrlRef = useRef<string | null>(null);
    const virtuosoRef = useRef<VirtuosoHandle>(null);

    const [, forceRender] = useState(0);
    const [isConnecting, setIsConnecting] = useState(false);
    const [isFollowing, setIsFollowing] = useState(true);

    /* ---------------------- SEARCH STATE ----------------------- */
    const [search, setSearch] = useState("");
    const [searchResults, setSearchResults] = useState<
        { line: number; text: string }[]
    >([]);
    const [isSearching, setIsSearching] = useState(false);

    const debouncedSetSearch = useCallback(
        debounce((value: string) => setSearch(value), 150),
        []
    );

    /* utility: yield control (use idle callback if available) */
    const yieldControl = () =>
        new Promise<void>((resolve) => {
            if (typeof (window as any).requestIdleCallback === "function") {
                (window as any).requestIdleCallback(() => resolve());
            } else {
                setTimeout(() => resolve(), 0);
            }
        });

    /* ---------------------- ASYNC SEARCH -----------------------
       Important changes:
       - Effect depends only on `search` (so frequent lines updates won't restart it)
       - Limit number of rendered results to `RESULT_LIMIT`
       - Use yieldControl() between chunks
    ----------------------------------------------------------- */
    useEffect(() => {
        const MIN_CHARS = 2;
        const CHUNK_SIZE = 500;
        const RESULT_LIMIT = 1000; // max displayed results (tune as needed)

        if (!search || search.length < MIN_CHARS) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        let cancelled = false;
        setIsSearching(true);
        setSearchResults([]);

        const needle = search.toLowerCase();

        const run = async () => {
            const lines = linesRef.current; // capture current array reference
            const results: { line: number; text: string }[] = [];

            // iterate in chunks, yield to the browser between chunks
            for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
                if (cancelled) return;

                const batch = lines.slice(i, i + CHUNK_SIZE);
                for (let j = 0; j < batch.length; ++j) {
                    if (cancelled) return;
                    const text = batch[j];
                    // for slightly better perf avoid creating many lowercase copies:
                    if (text.toLowerCase().includes(needle)) {
                        results.push({ line: i + j, text });
                        if (results.length >= RESULT_LIMIT) break;
                    }
                }

                // yield to UI thread
                await yieldControl();

                if (results.length >= RESULT_LIMIT) break;
            }

            if (!cancelled) {
                setSearchResults(results);
                setIsSearching(false);
            }
        };

        run();

        return () => {
            cancelled = true;
            setIsSearching(false);
        };
    }, [search]); // <-- only depends on search now

    const jumpToLine = (line: number) => {
        virtuosoRef.current?.scrollToIndex({
            index: line,
            align: "center",
            behavior: "smooth",
        });
    };

    /* ---------------------- URL CHANGE RESET -------------------- */
    useEffect(() => {
        if (prevUrlRef.current !== url) {
            linesRef.current = [];
            bufferRef.current = [];
            prevUrlRef.current = url;
            setIsConnecting(true);
            forceRender((r) => r + 1);
        }
    }, [url]);

    /* ---------------------- SSE PIPELINE ------------------------ */
    useEffect(() => {
        if (evtRef.current) {
            try {
                evtRef.current.close();
            } catch { }
            evtRef.current = null;
        }

        const es = new EventSource(url);
        evtRef.current = es;

        es.onopen = () => {
            setIsConnecting(false);
        };

        es.onmessage = (event) => {
            bufferRef.current.push(event.data);
        };

        const flushInterval = setInterval(() => {
            if (bufferRef.current.length === 0) return;

            // create a new array (keeps previous ref intact until assignment)
            linesRef.current = [...linesRef.current, ...bufferRef.current];
            bufferRef.current = [];

            if (linesRef.current.length > maxLines) {
                linesRef.current = linesRef.current.slice(
                    linesRef.current.length - maxLines
                );
            }

            forceRender((r) => r + 1);
        }, 50);

        es.onerror = () => {
            setIsConnecting(false);
            try {
                es.close();
            } catch { }
            if (evtRef.current === es) evtRef.current = null;
            clearInterval(flushInterval);
        };

        return () => {
            try {
                es.close();
            } catch { }
            if (evtRef.current === es) evtRef.current = null;
            clearInterval(flushInterval);
        };
    }, [url, maxLines]);

    /* ------------------- RENDER ---------------------- */

    let prevTimestamp = 0;

    return (
        <div className="flex h-[750px] w-full border rounded overflow-hidden">


            {/* LEFT: SEARCH PANEL */}
            <div className="w-80 border-r bg-muted/10 flex flex-col p-2">
                {/* Download Buttons */}
                <div className="flex gap-2 mb-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => downloadAsText(linesRef.current)}
                        disabled={linesRef.current.length === 0}
                        title="Download filtered logs as text file"
                    >
                        <Download className="w-4 h-4 mr-1" />
                        Text
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => downloadAsCSV(linesRef.current)}
                        disabled={linesRef.current.length === 0}
                        title="Download filtered logs as CSV file"
                    >
                        <Download className="w-4 h-4 mr-1" />
                        CSV
                    </Button>
                </div>

                <Input
                    placeholder="Search (min 2 chars)…"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => debouncedSetSearch(e.target.value)}
                    className="mb-2"
                />

                {/* simple, reliable scroll container */}
                <div className="flex-1 overflow-auto rounded border bg-background p-1">
                    {search.length < 2 && (
                        <div className="text-sm text-muted-foreground px-2 py-1">
                        </div>
                    )}

                    {search.length >= 2 && isSearching && (
                        <div className="text-sm text-muted-foreground px-2 py-1">
                            Searching…
                        </div>
                    )}

                    {search.length >= 2 && !isSearching && searchResults.length === 0 && (
                        <div className="text-sm text-muted-foreground px-2 py-1">
                            No matches found
                        </div>
                    )}

                    {/* show truncated notice if we reached the hard limit */}
                    {searchResults.length > 0 && (
                        <div className="text-xs text-muted-foreground px-2 pb-2">
                            Showing {searchResults.length} result{searchResults.length > 1 ? "s" : ""}{/* if truncated you'd show " (first N shown)" */}
                        </div>
                    )}

                    {searchResults.map((entry) => (
                        <div
                            key={entry.line}
                            onClick={() => jumpToLine(entry.line)}
                            className="px-2 py-1 text-sm font-mono rounded cursor-pointer hover:bg-accent"
                        >
                            <span className="font-bold mr-2 text-primary">
                                #{entry.line + 1}
                            </span>
                            {entry.text}
                        </div>
                    ))}
                </div>
            </div>

            {/* RIGHT: MAIN LOG VIEWER */}
            <div className="flex-1 relative">
                {isConnecting && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-50">
                        <Spinner className="h-8 w-8 text-white" />
                    </div>
                )}

                <Virtuoso
                    ref={virtuosoRef}
                    style={{ height: "100%", background: "#1e1e1e", color: "white" }}
                    data={linesRef.current}
                    followOutput={isFollowing ? "smooth" : false}
                    atBottomStateChange={(atBottom) => setIsFollowing(atBottom)}
                    itemContent={(index, line) => {
                        // timestamp parsing
                        const tsMatch = line.match(/^\[(.*?)\]/);
                        let timestampStr = "";
                        let deltaStr = "";
                        if (tsMatch) {
                            timestampStr = tsMatch[0];
                            const currentTs = new Date(tsMatch[1]).getTime();
                            if (showDelta && prevTimestamp !== 0) {
                                deltaStr = formatDelta(currentTs - prevTimestamp);
                            }
                            prevTimestamp = currentTs;
                        }

                        // Log level
                        const levelMatch = line.match(
                            /\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/
                        );
                        const level = levelMatch ? levelMatch[1] : null;

                        let beforeLevel = line;
                        let afterLevel = "";
                        if (levelMatch) {
                            const idx = levelMatch.index!;
                            beforeLevel = line.slice(0, idx);
                            afterLevel = line.slice(idx + levelMatch[0].length);
                        }

                        return (
                            <div className="font-mono px-3 py-1 whitespace-pre">
                                <span className="text-gray-500">{index + 1}</span>:
                                {timestampStr}{" "}
                                {deltaStr && (
                                    <span className="text-gray-500 italic ml-1">
                                        (+{deltaStr})
                                    </span>
                                )}{" "}
                                {beforeLevel.replace(timestampStr, "")}
                                {level && (
                                    <span
                                        style={{
                                            color: colorMap[level],
                                            fontWeight: "bold",
                                        }}
                                    >
                                        [{level}]
                                    </span>
                                )}
                                {afterLevel}
                            </div>
                        );
                    }}
                />
            </div>
        </div>
    );
};
