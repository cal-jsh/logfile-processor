import { useEffect, useRef, useState, useCallback } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { colorMap } from "../lib/colorMap";
import { Spinner } from "./ui/spinner";
import { Download } from "lucide-react";

/* ---------------- debounce helper ---------------- */
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number) {
  let timer: number;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

function formatDelta(ms: number): string {
  if (ms < 0.001) return `${Math.round(ms * 1_000_000)} µs`;
  else if (ms < 1000) return `${Math.round(ms)} ms`;
  else return `${(ms / 1000).toFixed(2)} s`;
}

/* ---------- Downloads ---------- */
function downloadAsText(lines: NormalizedLog[]) {
  const content = lines.map((l) => l.line).join("\n");
  const blob = new Blob([content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `logs_${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function downloadAsCSV(lines: NormalizedLog[]) {
  const header = "Timestamp,Level,Domain,Matched,Context,Message";
  const rows = lines.map((l) =>
    [
      l.timestamp ?? "",
      l.level ?? "",
      l.domain ?? "",
      l.matched ? "true" : "false",
      l.context ? "true" : "false",
      `"${(l.line || "").replace(/"/g, '\\"')}"`
    ].join(",")
  );
  const content = [header, ...rows].join("\n");
  const blob = new Blob([content], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `logs_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- Types ---------------- */
type IncomingEvent = any; // whatever the backend sends (be permissive)

type NormalizedLog = {
  line: string; // rendered line text
  idx: number; // absolute index (server-provided or local)
  context: boolean;
  matched: boolean;
  timestamp?: string;
  level?: string;
  domain?: string;
};

/* ---------------- Component ---------------- */
export const LogViewer = ({
  url,
  maxLines = 2000,
  showDelta,
}: {
  url: string;
  maxLines?: number;
  showDelta: boolean;
}) => {
  const linesRef = useRef<NormalizedLog[]>([]);
  const bufferRef = useRef<NormalizedLog[]>([]);
  const evtRef = useRef<EventSource | null>(null);
  const nextIdxRef = useRef<number>(0); // used when server doesn't provide idx

  const [, forceRender] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);

  /* ---------------- Search ---------------- */
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<{ idx: number; text: string }[]>(
    []
  );
  const [isSearching, setIsSearching] = useState(false);

  const debouncedSetSearch = useCallback(debounce((v) => setSearch(v), 150), []);

  const yieldControl = () =>
    new Promise((resolve) =>
      "requestIdleCallback" in window
        ? (window as any).requestIdleCallback(resolve)
        : setTimeout(resolve, 0)
    );

  /* ---------------- Normalize helper ----------------
     Turn arbitrary incoming JSON (or string) into NormalizedLog.
     - If backend provides fields, use them.
     - If not, parse fields from the `line` string.
  --------------------------------------------------*/
  function normalizeIncoming(objOrStr: IncomingEvent): NormalizedLog | null {
    // Accept either string payload or JSON object
    let obj: any;
    if (typeof objOrStr === "string") {
      // try to parse as JSON; if that fails, treat it as raw line
      try {
        obj = JSON.parse(objOrStr);
      } catch {
        obj = { line: objOrStr };
      }
    } else {
      obj = objOrStr ?? {};
    }

    // `line` final text: prefer obj.line, fallback to obj.data or the raw string
    const rawLine: string = (obj.line ?? obj.data ?? "").toString();

    if (!rawLine) {
      // nothing usable
      return null;
    }

    // idx: prefer provided, otherwise assign monotonic local index
    let idx: number;
    if (typeof obj.idx === "number" && Number.isFinite(obj.idx)) {
      idx = obj.idx;
      // Also keep nextIdxRef ahead of server idx to avoid collisions
      if (idx >= nextIdxRef.current) nextIdxRef.current = idx + 1;
    } else {
      idx = nextIdxRef.current++;
    }

    // context and matched logic:
    const contextProvided = typeof obj.context === "boolean";
    const matchedProvided = typeof obj.matched === "boolean";
    const context = contextProvided ? obj.context : false;
    // If matched is provided, trust it. If not provided but context is provided, matched = !context.
    // If neither provided, default matched=false (safe).
    const matched = matchedProvided ? obj.matched : (contextProvided ? !context : false);

    // timestamp: prefer obj.timestamp, otherwise parse from line beginning like "[2025-..]"
    let timestamp: string | undefined = undefined;
    if (typeof obj.timestamp === "string" && obj.timestamp.trim() !== "") {
      timestamp = obj.timestamp;
    } else {
      const tsMatch = rawLine.match(/^\[([^\]]+)\]/);
      if (tsMatch) timestamp = tsMatch[1];
    }

    // level: prefer obj.level, otherwise parse bracketed level like [INFO]
    let level: string | undefined = undefined;
    if (typeof obj.level === "string" && obj.level.trim() !== "") {
      level = obj.level;
    } else {
      const levelMatch = rawLine.match(/\[(TRACE|DEBUG|INFO|WARN|ERROR)\]/);
      if (levelMatch) level = levelMatch[1];
    }

    // domain: prefer obj.domain, otherwise parse the next bracketed token after level/timestamp
    let domain: string | undefined = undefined;
    if (typeof obj.domain === "string" && obj.domain.trim() !== "") {
      domain = obj.domain;
    } else {
      // try to find the first bracket after the timestamp and level
      // remove timestamp and level from the start then look for [domain] or bare token
      const afterTs = rawLine.replace(/^\[[^\]]+\]\s*/, "");
      const afterLevel = afterTs.replace(/\[(TRACE|DEBUG|INFO|WARN|ERROR)\]\s*/, "");
      const domainMatch = afterLevel.match(/^\[([^\]]+)\]|^(\S+)\s/);
      if (domainMatch) {
        domain = (domainMatch[1] ?? domainMatch[2]) as string;
      }
    }

    const normalized: NormalizedLog = {
      line: rawLine,
      idx,
      context,
      matched,
      timestamp,
      level,
      domain,
    };

    return normalized;
  }

  /* ---------------- Async Search ---------------- */
  useEffect(() => {
    const MIN = 2,
      CHUNK = 400,
      LIMIT = 1000;

    if (!search || search.length < MIN) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    setSearchResults([]);

    const needle = search.toLowerCase();

    const run = async () => {
      const arr = linesRef.current;
      const out: { idx: number; text: string }[] = [];

      for (let i = 0; i < arr.length; i += CHUNK) {
        if (cancelled) return;

        const batch = arr.slice(i, i + CHUNK);
        for (let j = 0; j < batch.length; j++) {
          if (cancelled) return;
          const obj = batch[j];
          if ((obj.line || "").toLowerCase().includes(needle)) {
            out.push({ idx: obj.idx, text: obj.line });
            if (out.length >= LIMIT) break;
          }
        }

        await yieldControl();
        if (out.length >= LIMIT) break;
      }

      if (!cancelled) {
        setSearchResults(out);
        setIsSearching(false);
      }
    };

    run();
    return () => {
      cancelled = true;
      setIsSearching(false);
    };
  }, [search]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const jumpToIndex = (absIdx: number) => {
    const i = linesRef.current.findIndex((l) => l.idx === absIdx);
    if (i >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: i,
        align: "center",
        behavior: "smooth",
      });
    }
  };

  /* ---------------- Reset on URL change ---------------- */
  const prevUrl = useRef<string | null>(null);
  useEffect(() => {
    if (prevUrl.current !== url) {
      prevUrl.current = url;
      linesRef.current = [];
      bufferRef.current = [];
      nextIdxRef.current = 0;
      setIsConnecting(true);
      forceRender((r) => r + 1);
    }
  }, [url]);

  /* ---------------- SSE ---------------- */
  useEffect(() => {
    // close previous
    if (evtRef.current) {
      try {
        evtRef.current.close();
      } catch {}
      evtRef.current = null;
    }

    const es = new EventSource(url);
    evtRef.current = es;

    es.onopen = () => setIsConnecting(false);

    es.onmessage = (e) => {
      // Try to parse JSON; if not JSON assume raw line string
      let parsed: any = null;
      try {
        parsed = JSON.parse(e.data);
      } catch {
        // not JSON — we will treat e.data as raw line
        parsed = e.data;
      }

      const normalized = normalizeIncoming(parsed);
      if (normalized) {
        bufferRef.current.push(normalized);
      }
    };

    const flush = setInterval(() => {
      if (bufferRef.current.length === 0) return;

      // append buffered normalized entries and cap
      linesRef.current = [...linesRef.current, ...bufferRef.current].slice(-maxLines);
      bufferRef.current = [];

      forceRender((r) => r + 1);
    }, 50);

    es.onerror = () => {
      setIsConnecting(false);
      clearInterval(flush);
      try {
        es.close();
      } catch {}
    };

    return () => {
      clearInterval(flush);
      try {
        es.close();
      } catch {}
    };
  }, [url, maxLines]);

  /* ---------------- Render ---------------- */
  let prevTs = 0;

  return (
    <div className="flex h-[750px] w-full border rounded overflow-hidden">
      {/* LEFT PANEL */}
      <div className="w-80 border-r bg-muted/10 p-2 flex flex-col">
        {/* Downloads */}
        <div className="flex gap-2 mb-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!linesRef.current.length}
            onClick={() => downloadAsText(linesRef.current)}
          >
            <Download className="w-4 h-4 mr-1" />
            Text
          </Button>

          <Button
            size="sm"
            variant="outline"
            disabled={!linesRef.current.length}
            onClick={() => downloadAsCSV(linesRef.current)}
          >
            <Download className="w-4 h-4 mr-1" />
            CSV
          </Button>
        </div>

        <Input
          placeholder="Search…"
          className="mb-2"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            debouncedSetSearch(e.target.value)
          }
        />

        {/* Results */}
        <div className="flex-1 overflow-auto border rounded p-1">
          {isSearching && (
            <div className="text-sm text-muted-foreground px-1 py-1">
              Searching…
            </div>
          )}

          {!isSearching && search.length >= 2 && searchResults.length === 0 && (
            <div className="text-sm text-muted-foreground px-1 py-1">
              No matches found
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="text-xs text-muted-foreground px-1 pb-1">
              Showing {searchResults.length} results
            </div>
          )}

          {searchResults.map((r) => (
            <div
              key={r.idx}
              className="px-2 py-1 text-sm font-mono cursor-pointer rounded hover:bg-accent"
              onClick={() => jumpToIndex(r.idx)}
            >
              <span className="font-bold text-primary mr-2">
                #{r.idx + 1}
              </span>
              {r.text}
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 relative">
        {isConnecting && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50">
            <Spinner className="w-8 h-8 text-white" />
          </div>
        )}

        <Virtuoso
          ref={virtuosoRef}
          style={{ height: "100%", background: "#1e1e1e", color: "white" }}
          data={linesRef.current}
          followOutput={isFollowing ? "smooth" : false}
          atBottomStateChange={(b) => setIsFollowing(b)}
          itemContent={(i, log: NormalizedLog) => {
            // compute delta safely
            let delta = "";
            if (showDelta && log.timestamp) {
              const tsNum = Number(new Date(log.timestamp).getTime());
              if (isFinite(tsNum) && prevTs !== 0) {
                delta = formatDelta(tsNum - prevTs);
              }
              if (isFinite(tsNum)) prevTs = tsNum;
            }

            // safe idx display (avoid NaN)
            const displayIdx = Number.isFinite(log.idx) ? log.idx : i;

            return (
              <div
                className={`font-mono px-3 py-1 whitespace-pre ${log.context ? "opacity-60" : ""}`}
              >
                <span className="text-gray-500">{displayIdx + 1}</span>:{" "}
                {log.timestamp && `[${log.timestamp}]`}{" "}
                {delta && (
                  <span className="text-gray-500 italic ml-1">(+{delta})</span>
                )}{" "}
                {log.level && (
                  <span style={{ color: colorMap[log.level] || "white", fontWeight: "bold" }}>
                    [{log.level}]
                  </span>
                )}{" "}
                {log.domain && <span className="text-blue-400">[{log.domain}]</span>}{" "}
                <span className={`${log.matched ? "" : ""}`}>{log.line}</span>
              </div>
            );
          }}
        />
      </div>
    </div>
  );
};
