import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { colorMap } from "../lib/colorMap";
import { Spinner } from "./ui/spinner";
import { Download } from "lucide-react";
import { exportView, isDesktop } from "../lib/platform";

/*
 * Viewport-based log viewer.
 *
 * The backend keeps the filter result as line numbers and expands context lines on
 * request, so the viewer never holds the result set. It only knows the row count and
 * fetches the rows it shows, in pages, from /view/rows.
 *
 * Scrolling is custom (fixed row height, own scrollbar) instead of a DOM-height based
 * virtual list: browsers cap element height at roughly 33 million pixels, which is
 * about 1.5 million rows, and logs can have hundreds of millions.
 */

const ROW_HEIGHT = 22; // px, must match the row style below
const PAGE_SIZE = 256; // rows per /view/rows request
const OVERSCAN_PAGES = 1; // pages fetched above and below the visible ones
const MAX_CACHED_PAGES = 64;
const SEARCH_MIN = 2;

/* ---------------- Types ---------------- */
type Row = {
  row: number;
  line_number: number; // 1-based line in the file
  text: string;
  context: boolean;
  truncated: boolean;
};

type ViewInfo = {
  row_count: number;
  match_count: number;
  context: number;
  line_count: number;
  scan_ms: number;
  cached: boolean;
};

type SearchHit = { row: number; line_number: number; text: string };

type ParsedLine = {
  timestamp?: string;
  level?: string;
  domain?: string;
  message: string;
};

/* ---------------- Helpers ---------------- */
// Same format as the backend's LOG_REGEX: [ts] [LEVEL] [domain] message
const LINE_RE = /^\[([^\]]+)\]\s\[([^\]]+)\]\s\[([^\]]+)\]\s*(.*)$/s;

function parseLine(text: string): ParsedLine {
  const m = LINE_RE.exec(text);
  if (!m) return { message: text };
  return { timestamp: m[1], level: m[2], domain: m[3], message: m[4] };
}

function parseTime(ts: string | undefined): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}

function formatDelta(ms: number): string {
  if (ms < 0.001) return `${Math.round(ms * 1_000_000)} µs`;
  else if (ms < 1000) return `${Math.round(ms)} ms`;
  else return `${(ms / 1000).toFixed(2)} s`;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

/* ---------------- Component ---------------- */
export const LogViewer = ({
  baseUrl,
  sessionId,
  filterParams,
  context,
  showDelta,
}: {
  baseUrl: string;
  sessionId: string;
  /** Encoded filter query parameters, e.g. "&levels=ERROR&keywords=foo" */
  filterParams: string;
  context: number;
  showDelta: boolean;
}) => {
  const viewParams = `session_id=${encodeURIComponent(sessionId)}${filterParams}&context=${context}`;

  const [info, setInfo] = useState<ViewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // first visible row; fractional for smooth scrolling
  const [top, setTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [highlightRow, setHighlightRow] = useState<number | null>(null);

  const pagesRef = useRef<Map<number, Row[]>>(new Map());
  const inflightRef = useRef<Map<number, AbortController>>(new Map());
  const [, setPagesVersion] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const visibleRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT));
  const rowCount = info?.row_count ?? 0;
  const maxTop = Math.max(0, rowCount - visibleRows);

  const scrollTo = useCallback(
    (row: number) => setTop(clamp(row, 0, maxTop)),
    [maxTop]
  );

  /* ---------------- Load the view (row count) ----------------
     Re-runs when the filter or the context changes. Changing only the context reuses
     the backend's cached scan, and we keep the same file line at the top. */
  const prevFilterRef = useRef<string | null>(null);
  const topLineRef = useRef<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const anchorLine = prevFilterRef.current === filterParams ? topLineRef.current : null;
    prevFilterRef.current = filterParams;

    // drop rows of the previous view
    inflightRef.current.forEach((c) => c.abort());
    inflightRef.current.clear();
    pagesRef.current = new Map();
    setLoading(true);
    setError(null);
    setHighlightRow(null);

    (async () => {
      try {
        const res = await fetch(`${baseUrl}/view?${viewParams}`, { signal: ctrl.signal });
        if (res.status === 409) return; // superseded by a newer filter
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const v: ViewInfo = await res.json();
        let start = 0;
        if (anchorLine != null) {
          const r = await fetch(`${baseUrl}/view/row_of_line?${viewParams}&line=${anchorLine}`, {
            signal: ctrl.signal,
          });
          if (r.ok) start = (await r.json()).row;
        }
        setInfo(v);
        setTop(clamp(start, 0, Math.max(0, v.row_count - visibleRows)));
        setLoading(false);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setError(String(e?.message ?? e));
        setLoading(false);
      }
    })();
    return () => ctrl.abort();
    // visibleRows is read once for the initial clamp only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, viewParams, filterParams]);

  /* ---------------- Fetch visible pages ---------------- */
  useEffect(() => {
    if (!info || loading || rowCount === 0) return;
    const firstPage = Math.max(0, Math.floor(top / PAGE_SIZE) - OVERSCAN_PAGES);
    const lastPage = Math.min(
      Math.floor((rowCount - 1) / PAGE_SIZE),
      Math.floor((top + visibleRows) / PAGE_SIZE) + OVERSCAN_PAGES
    );

    // abort requests for pages that scrolled far away
    inflightRef.current.forEach((c, p) => {
      if (p < firstPage - 2 || p > lastPage + 2) {
        c.abort();
        inflightRef.current.delete(p);
      }
    });

    const pages = pagesRef.current;
    for (let p = firstPage; p <= lastPage; p++) {
      if (pages.has(p) || inflightRef.current.has(p)) continue;
      const ctrl = new AbortController();
      inflightRef.current.set(p, ctrl);
      const myPages = pages;
      fetch(`${baseUrl}/view/rows?${viewParams}&first_row=${p * PAGE_SIZE}&count=${PAGE_SIZE}`, {
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data: { rows: Row[] }) => {
          if (pagesRef.current !== myPages) return; // view changed meanwhile
          myPages.set(p, data.rows);
          // keep the cache bounded: evict pages farthest from the current one
          if (myPages.size > MAX_CACHED_PAGES) {
            const center = Math.floor(top / PAGE_SIZE);
            const far = [...myPages.keys()].sort(
              (a, b) => Math.abs(b - center) - Math.abs(a - center)
            );
            for (const k of far.slice(0, myPages.size - MAX_CACHED_PAGES)) myPages.delete(k);
          }
          setPagesVersion((v) => v + 1);
        })
        .catch(() => { })
        .finally(() => {
          if (inflightRef.current.get(p) === ctrl) inflightRef.current.delete(p);
        });
    }
  }, [info, loading, top, visibleRows, rowCount, baseUrl, viewParams]);

  const getRow = (r: number): Row | undefined =>
    pagesRef.current.get(Math.floor(r / PAGE_SIZE))?.[r % PAGE_SIZE];

  /* ---------------- Viewport size ---------------- */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  /* ---------------- Wheel (vertical only; horizontal stays native) ---------------- */
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      const rows =
        e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * visibleRows : e.deltaY / ROW_HEIGHT;
      setTop((t) => clamp(t + rows, 0, maxTop));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [maxTop, visibleRows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: visibleRows - 1,
      PageUp: -(visibleRows - 1),
    };
    if (e.key in step) {
      e.preventDefault();
      setTop((t) => clamp(Math.round(t) + step[e.key], 0, maxTop));
    } else if (e.key === "Home") {
      e.preventDefault();
      setTop(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setTop(maxTop);
    }
  };

  /* ---------------- Scrollbar ---------------- */
  const trackHeight = viewportHeight;
  const thumbHeight =
    rowCount > 0 ? clamp((trackHeight * visibleRows) / rowCount, 24, trackHeight) : trackHeight;
  const thumbTop = maxTop > 0 ? (top / maxTop) * (trackHeight - thumbHeight) : 0;
  const dragRef = useRef<{ y: number; top: number } | null>(null);

  const onThumbDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, top };
  };
  const onThumbMove = (e: React.PointerEvent) => {
    if (!dragRef.current || trackHeight <= thumbHeight) return;
    const dy = e.clientY - dragRef.current.y;
    setTop(clamp(dragRef.current.top + (dy / (trackHeight - thumbHeight)) * maxTop, 0, maxTop));
  };
  const onThumbUp = () => {
    dragRef.current = null;
  };
  const onTrackDown = (e: React.PointerEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || trackHeight <= thumbHeight) return;
    const y = e.clientY - rect.top - thumbHeight / 2;
    setTop(clamp((y / (trackHeight - thumbHeight)) * maxTop, 0, maxTop));
  };

  /* ---------------- Search inside the results (backend) ---------------- */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchComplete, setSearchComplete] = useState(true);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setSearchResults([]);
    if (!search || search.length < SEARCH_MIN || loading) {
      setIsSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setIsSearching(true);
    fetch(`${baseUrl}/view/search?${viewParams}&q=${encodeURIComponent(search)}`, {
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { hits: SearchHit[]; complete: boolean }) => {
        setSearchResults(data.hits);
        setSearchComplete(data.complete);
        setIsSearching(false);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setIsSearching(false);
      });
    return () => ctrl.abort();
  }, [search, viewParams, baseUrl, loading]);

  const jumpToRow = (row: number) => {
    scrollTo(row - Math.floor(visibleRows / 2));
    setHighlightRow(row);
    viewportRef.current?.focus();
  };

  /* ---------------- Go to line ---------------- */
  const [gotoInput, setGotoInput] = useState("");
  const goToLine = async () => {
    const line = parseInt(gotoInput, 10);
    if (!Number.isFinite(line) || line < 1) return;
    const r = await fetch(`${baseUrl}/view/row_of_line?${viewParams}&line=${line}`);
    if (!r.ok) return;
    const { row } = await r.json();
    if (row < rowCount) jumpToRow(row);
  };

  /* ---------------- Downloads (streamed by the backend) ---------------- */
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const download = async (format: "txt" | "csv") => {
    if (isDesktop) {
      // The webview can't download from the API: save through a native dialog.
      const p = new URLSearchParams(filterParams);
      setExportMsg("Exporting…");
      try {
        const saved = await exportView({
          sessionId,
          levels: p.get("levels"),
          domains: p.get("domains"),
          keywords: p.get("keywords"),
          context,
          format,
        });
        setExportMsg(saved ? `Saved to ${saved}` : null);
      } catch (e) {
        setExportMsg(`Export failed: ${e}`);
      }
      return;
    }
    const a = document.createElement("a");
    a.href = `${baseUrl}/view/export?${viewParams}&format=${format}`;
    a.click();
  };

  /* ---------------- Render ---------------- */
  const firstRow = Math.floor(top);
  const offsetPx = (top - firstRow) * ROW_HEIGHT;
  const renderCount = Math.min(visibleRows + 2, Math.max(0, rowCount - firstRow));

  // remember the line at the top, to keep the position when the context changes
  const topRowData = getRow(firstRow);
  topLineRef.current = topRowData ? topRowData.line_number : topLineRef.current;

  const rows: JSX.Element[] = [];
  for (let i = 0; i < renderCount; i++) {
    const r = firstRow + i;
    const row = getRow(r);
    if (!row) {
      rows.push(
        <div key={r} className="font-mono px-3 text-gray-600" style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}>
          …
        </div>
      );
      continue;
    }
    const parsed = parseLine(row.text);

    // time delta to the previous row of the view (not the previously rendered one)
    let delta = "";
    if (showDelta && r > 0) {
      const prev = getRow(r - 1);
      const t = parseTime(parsed.timestamp);
      const pt = prev ? parseTime(parseLine(prev.text).timestamp) : null;
      if (t != null && pt != null) delta = formatDelta(t - pt);
    }

    rows.push(
      <div
        key={r}
        className={`font-mono px-3 whitespace-pre ${row.context ? "opacity-60" : ""} ${r === highlightRow ? "bg-yellow-500/30" : ""}`}
        style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
      >
        <span className="text-gray-500">{row.line_number}</span>:{" "}
        {parsed.timestamp && `[${parsed.timestamp}]`}{" "}
        {delta && <span className="text-gray-500 italic ml-1">(+{delta})</span>}{" "}
        {parsed.level && (
          <span style={{ color: colorMap[parsed.level] || "white", fontWeight: "bold" }}>
            [{parsed.level}]
          </span>
        )}{" "}
        {parsed.domain && <span className="text-blue-400">[{parsed.domain}]</span>}{" "}
        <span>{parsed.message}</span>
        {row.truncated && <span className="text-gray-500 italic"> … (line cut for display)</span>}
      </div>
    );
  }

  return (
    <div className="flex h-[750px] w-full border rounded overflow-hidden">
      {/* LEFT PANEL */}
      <div className="w-80 border-r bg-muted/10 p-2 flex flex-col">
        {/* Downloads */}
        <div className="flex gap-2 mb-2">
          <Button size="sm" variant="outline" disabled={!rowCount} onClick={() => download("txt")}>
            <Download className="w-4 h-4 mr-1" />
            Text
          </Button>

          <Button size="sm" variant="outline" disabled={!rowCount} onClick={() => download("csv")}>
            <Download className="w-4 h-4 mr-1" />
            CSV
          </Button>
        </div>
        {exportMsg && (
          <div className="text-xs text-muted-foreground mb-2 break-all">{exportMsg}</div>
        )}

        <div className="flex gap-2 mb-2">
          <Input
            placeholder="Go to line…"
            inputMode="numeric"
            value={gotoInput}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGotoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToLine();
            }}
          />
          <Button size="sm" variant="outline" onClick={goToLine} disabled={!rowCount}>
            Go
          </Button>
        </div>

        <Input
          placeholder="Search…"
          className="mb-2"
          value={searchInput}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchInput(e.target.value)}
        />

        {/* Results */}
        <div className="flex-1 overflow-auto border rounded p-1">
          {isSearching && (
            <div className="text-sm text-muted-foreground px-1 py-1">Searching…</div>
          )}

          {!isSearching && search.length >= SEARCH_MIN && searchResults.length === 0 && (
            <div className="text-sm text-muted-foreground px-1 py-1">No matches found</div>
          )}

          {searchResults.length > 0 && (
            <div className="text-xs text-muted-foreground px-1 pb-1">
              {searchComplete
                ? `Showing ${searchResults.length} results`
                : `Showing the first ${searchResults.length} results`}
            </div>
          )}

          {searchResults.map((r) => (
            <div
              key={r.row}
              className="px-2 py-1 text-sm font-mono cursor-pointer rounded hover:bg-accent"
              onClick={() => jumpToRow(r.row)}
            >
              <span className="font-bold text-primary mr-2">#{r.line_number}</span>
              {r.text}
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 relative flex flex-col min-w-0">
        {loading && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50">
            <Spinner className="w-8 h-8 text-white" />
          </div>
        )}

        <div role="status" className="text-xs px-3 py-1 border-b bg-muted/30 text-muted-foreground">
          {error
            ? `Error: ${error}`
            : info
              ? `${info.match_count.toLocaleString()} matching lines` +
              (info.context > 0 ? `, ${info.row_count.toLocaleString()} rows with ±${info.context} context` : "") +
              ` · ${info.line_count.toLocaleString()} lines ` +
              (info.cached ? "(cached result, no rescan)" : `scanned in ${Math.round(info.scan_ms).toLocaleString()} ms`) +
              (rowCount > 0 ? ` · rows ${(firstRow + 1).toLocaleString()}–${Math.min(rowCount, firstRow + visibleRows).toLocaleString()}` : "")
              : "Loading…"}
        </div>

        <div className="flex flex-1 min-h-0" style={{ background: "#1e1e1e", color: "white" }}>
          <div
            ref={viewportRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden outline-none text-sm"
          >
            <div style={{ transform: `translateY(${-offsetPx}px)`, minWidth: "max-content" }}>{rows}</div>
          </div>

          {/* Scrollbar */}
          <div
            ref={trackRef}
            className="w-3 relative bg-white/5 cursor-pointer"
            onPointerDown={onTrackDown}
          >
            {rowCount > visibleRows && (
              <div
                className="absolute left-0.5 right-0.5 rounded bg-white/40 hover:bg-white/60"
                style={{ top: thumbTop, height: thumbHeight }}
                onPointerDown={onThumbDown}
                onPointerMove={onThumbMove}
                onPointerUp={onThumbUp}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
