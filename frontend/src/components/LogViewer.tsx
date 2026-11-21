import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { levelColor } from "../lib/colorMap";
import { Spinner } from "./ui/spinner";
import { Download, LocateFixed, Search } from "lucide-react";
import { exportView } from "../lib/platform";
import { FloatingPanel } from "./FloatingPanel";
import { formatFull, Minimap, type MinimapAxis, type VisibleRange } from "./Minimap";
import { ThreadLanes } from "./ThreadLanes";
import { formatRange, type TimeRange } from "./TimeRangeSelect";
import { isLineNumber, parseTimeInput, type ParsedTime } from "../lib/timeInput";
import type { FieldDef } from "../lib/logSummary";
import { IndexingSweep } from "./IndexingSweep";

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
  /** The line's fields in the order of the format's columns; null if not in the format */
  fields: string[] | null;
  /** Timestamp, ms since 1970 in the log's own clock */
  t: number | null;
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
  /** Only the start of the file is known yet (right after opening, while it is being
      indexed): row_count is an estimate, the rows shown are exact */
  partial?: boolean;
};

type SearchHit = { row: number; line_number: number; text: string; fields: string[] | null };

/* ---------------- Helpers ---------------- */
/** Colors of text fields in the rows; others are gray */
const FIELD_COLORS: Record<string, string> = {
  domain: "text-blue-400",
  thread: "text-violet-300",
  process: "text-teal-300",
};

function formatDelta(ms: number): string {
  if (ms < 0.001) return `${Math.round(ms * 1_000_000)} µs`;
  else if (ms < 1000) return `${Math.round(ms)} ms`;
  else return `${(ms / 1000).toFixed(2)} s`;
}

/** Mark the occurrences of `q` (case-insensitive) in a search result */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  for (let j = lower.indexOf(needle); j !== -1 && out.length < 40; j = lower.indexOf(needle, i)) {
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <mark key={j} className="rounded-sm bg-yellow-300/70 px-0.5 text-inherit">
        {text.slice(j, j + q.length)}
      </mark>
    );
    i = j + q.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/** A search hit, compact: time, level, other fields and the message, with the match marked */
function ResultText({ hit, q, columns }: { hit: SearchHit; q: string; columns: FieldDef[] }) {
  const { text, fields } = hit;
  if (!fields) {
    // not in the log format: start shortly before the match so it stays visible
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    const snippet = at > 40 ? "…" + text.slice(at - 20) : text;
    return <span className="truncate">{highlight(snippet, q)}</span>;
  }
  const of = (kind: FieldDef["kind"]) => {
    const i = columns.findIndex((c) => c.kind === kind);
    return i >= 0 ? fields[i] : undefined;
  };
  const ts = of("time");
  const time = ts?.match(/\d{2}:\d{2}:\d{2}(\.\d{1,3})?/)?.[0] ?? ts;
  const level = of("level");
  const others = columns.map((c, i) => (c.kind === "text" ? fields[i] : null)).filter((v): v is string => !!v);
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {time && <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span>}
      {level != null && (
        <span className="w-11 shrink-0 font-semibold" style={{ color: `color-mix(in oklab, ${levelColor(level) ?? "currentColor"} 70%, var(--foreground))` }}>
          {level}
        </span>
      )}
      <span className="truncate">
        {others.map((v, i) => (
          <span key={i} className="text-muted-foreground">{highlight(v, q)} </span>
        ))}
        {highlight(of("message") ?? text, q)}
      </span>
    </span>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}

/* ---------------- Component ---------------- */
export const LogViewer = ({
  baseUrl,
  sessionId,
  filterParams,
  columns,
  hiddenColumns,
  columnWidths,
  context,
  showDelta,
  showMinimap,
  minimapAxis,
  minimapColor,
  lanesField,
  searchOpen,
  onSearchOpenChange,
  statusStart,
  timeSpan,
  timeRange,
  onTimeRangeChange,
}: {
  baseUrl: string;
  sessionId: string;
  /** Encoded filter query parameters, e.g. "&levels=ERROR&keywords=foo" */
  filterParams: string;
  /** The fields of the file's format, in line order */
  columns: FieldDef[];
  /** Names of the fields not shown */
  hiddenColumns: string[];
  /** Width in characters per field name, to line the columns up */
  columnWidths: Record<string, number>;
  context: number;
  showDelta: boolean;
  /** The level minimap above the rows */
  showMinimap: boolean;
  /** Minimap columns by equal line counts or by equal time slices */
  minimapAxis: MinimapAxis;
  /** Minimap colours: "level", or the name of a text field (e.g. "domain") */
  minimapColor: string;
  /** Thread swimlanes by this field; null hides them */
  lanesField: FieldDef | null;
  /** The floating "Search & go to line" panel */
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  /** Shown at the start of the status bar (the active filters while the filter panel is hidden) */
  statusStart?: React.ReactNode;
  /** First and last timestamp of the file (ms, log clock); null without timestamps */
  timeSpan: { start: number; end: number } | null;
  /** The time range filter (already part of `filterParams`) */
  timeRange: TimeRange | null;
  onTimeRangeChange: (r: TimeRange | null) => void;
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
        // Right after opening, the unfiltered view answers at once from the start of the
        // file (`partial`) while the whole file is indexed: show those rows, then ask
        // again for the whole view, which waits for the index. The rows shown stay as
        // they are; only the row count (scrollbar) is corrected when it arrives.
        let shownPartial = false;
        if (anchorLine == null && !filterParams) {
          const res = await fetch(`${baseUrl}/view?${viewParams}&partial=true`, { signal: ctrl.signal });
          const v: ViewInfo | null = res.ok ? await res.json() : null;
          if (v?.partial) {
            setInfo(v);
            setTop(0);
            setLoading(false);
            shownPartial = true;
          }
        }
        const res = await fetch(`${baseUrl}/view?${viewParams}`, { signal: ctrl.signal });
        if (res.status === 409) return; // superseded by a newer filter
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const v: ViewInfo = await res.json();
        if (shownPartial) {
          // keep the position the reader may have scrolled to meanwhile
          setInfo(v);
          setTop((t) => clamp(t, 0, Math.max(0, v.row_count - visibleRows)));
          return;
        }
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
      fetch(`${baseUrl}/view/rows?${viewParams}&first_row=${p * PAGE_SIZE}&count=${PAGE_SIZE}${info.partial ? "&partial=true" : ""}`, {
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
    // Ctrl+arrows show and hide the panels (handled by the dashboard)
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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

  /* ---------------- Go to line or time ----------------
     Digits go to a line. Anything else is read as a time (see lib/timeInput): the view
     scrolls to the first row at or after it. Two times joined by "-" or ".." set the time
     range filter instead. A bare time of day means the day of the rows on screen. */
  const [gotoInput, setGotoInput] = useState("");
  const [gotoMsg, setGotoMsg] = useState<string | null>(null);
  // (a function: the rows on screen are only known further down)
  const parseGoto = (): ParsedTime | null =>
    gotoInput.trim() && !isLineNumber(gotoInput)
      ? timeSpan
        ? parseTimeInput(gotoInput, { ...timeSpan, ref: visibleRef.current?.tFirst ?? null })
        : { kind: "error", message: "This file has no timestamps" }
      : null;
  useEffect(() => setGotoMsg(null), [gotoInput]);
  const goTo = async () => {
    if (isLineNumber(gotoInput)) {
      const line = parseInt(gotoInput.replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(line) || line < 1) return;
      const r = await fetch(`${baseUrl}/view/row_of_line?${viewParams}&line=${line}`);
      if (!r.ok) return;
      const { row } = await r.json();
      if (row < rowCount) jumpToRow(row);
      setGotoMsg(row < rowCount ? null : "No rows at or after that line in this view");
      return;
    }
    const p = parseGoto();
    if (!p || p.kind === "error") return;
    if (p.kind === "range") {
      onTimeRangeChange({ from: p.from, to: p.to });
      setGotoMsg(`Filtered to ${formatRange(p)}`);
      return;
    }
    const r = await fetch(`${baseUrl}/view/row_of_time?${viewParams}&time_ms=${p.t}`);
    if (!r.ok) {
      setGotoMsg(`Error: ${await r.text()}`);
      return;
    }
    const d: { row: number; row_count: number; line: number | null; time_ms: number | null; row_line: number | null } = await r.json();
    const at = d.time_ms != null ? formatFull(d.time_ms) : "";
    if (d.line == null) {
      setGotoMsg(`No log line at or after ${formatFull(p.t)}`);
    } else if (d.row >= d.row_count) {
      setGotoMsg(`${at} (line ${d.line.toLocaleString()}) is filtered out, and so is everything after it`);
    } else {
      jumpToRow(d.row);
      setGotoMsg(
        d.row_line === d.line
          ? `Line ${d.line.toLocaleString()} · ${at}`
          : `${at} (line ${d.line.toLocaleString()}) is filtered out: went to the next row, line ${(d.row_line ?? 0).toLocaleString()}`
      );
    }
  };

  /* ---------------- Minimap: jump to a file line ----------------
     When every line of the file is a row (no filter, all lines in the log format),
     row = line - 1 and dragging needs no request. Otherwise the backend maps the line
     to the first row at or after it; only the latest request counts while dragging. */
  const minimapReqRef = useRef<AbortController | null>(null);
  const identityRows = !!info && info.row_count === info.line_count;
  const centerRow = (row: number) => scrollTo(Math.min(row, rowCount - 1) - Math.floor(visibleRows / 2));
  const jumpToLine = (line: number) => {
    if (!rowCount) return;
    if (identityRows) {
      centerRow(line - 1);
      return;
    }
    minimapReqRef.current?.abort();
    const ctrl = new AbortController();
    minimapReqRef.current = ctrl;
    fetch(`${baseUrl}/view/row_of_line?${viewParams}&line=${line}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { row: number } | null) => {
        if (d && minimapReqRef.current === ctrl) centerRow(d.row);
      })
      .catch(() => { });
  };

  /* ---------------- Keyboard: Ctrl+F search, Ctrl+G go to line ----------------
     The rows are virtualized, so the browser's own find can't see them anyway. */
  const searchInputRef = useRef<HTMLInputElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);
  const focusAfterOpen = useRef<"search" | "goto" | null>(null);

  const focusRequested = () => {
    const which = focusAfterOpen.current;
    focusAfterOpen.current = null;
    const el = which === "goto" ? gotoInputRef.current : which === "search" ? searchInputRef.current : null;
    el?.focus();
    el?.select();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k !== "f" && k !== "g") return;
      e.preventDefault();
      focusAfterOpen.current = k === "f" ? "search" : "goto";
      if (searchOpen) focusRequested();
      else onSearchOpenChange(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // opened from the sidebar or a shortcut: put the cursor in the search box
  useEffect(() => {
    if (!searchOpen) return;
    if (!focusAfterOpen.current) focusAfterOpen.current = "search";
    focusRequested();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  /* ---------------- Export (written by Rust after a native Save dialog) ---------------- */
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const download = async (format: "txt" | "csv") => {
    // An <a href> download would navigate the whole webview away
    const p = new URLSearchParams(filterParams);
    setExportMsg("Exporting…");
    try {
      const saved = await exportView({
        sessionId,
        levels: p.get("levels"),
        fields: p.get("fields"),
        keywords: p.get("keywords"),
        timeFrom: timeRange?.from ?? null,
        timeTo: timeRange?.to ?? null,
        context,
        format,
      });
      setExportMsg(saved ? `Saved to ${saved}` : null);
    } catch (e) {
      setExportMsg(`Export failed: ${e}`);
    }
  };

  /* ---------------- Render ---------------- */
  const firstRow = Math.floor(top);
  const offsetPx = (top - firstRow) * ROW_HEIGHT;
  const renderCount = Math.min(visibleRows + 2, Math.max(0, rowCount - firstRow));

  // remember the line at the top, to keep the position when the context changes
  const topRowData = getRow(firstRow);
  topLineRef.current = topRowData ? topRowData.line_number : topLineRef.current;

  // file lines (and their times) on screen, for the minimap's viewport box; while the
  // rows are loading, the last known range is kept
  const lastRow = Math.min(rowCount - 1, firstRow + visibleRows - 1);
  const visibleRef = useRef<VisibleRange | null>(null);
  if (rowCount > 0) {
    const ra = getRow(firstRow);
    const rb = getRow(lastRow);
    const a = identityRows ? firstRow + 1 : ra?.line_number;
    const b = identityRows ? lastRow + 1 : rb?.line_number;
    if (a != null && b != null) {
      const prev = visibleRef.current;
      const time = (r: Row | undefined) => (r ? r.t : null);
      visibleRef.current = {
        first: a,
        last: b,
        tFirst: ra ? time(ra) : prev?.tFirst ?? null,
        tLast: rb ? time(rb) : prev?.tLast ?? null,
      };
    }
  } else {
    visibleRef.current = null;
  }

  // line numbers right-aligned to the widest one, so the columns stay lined up
  const lineDigits = String(info?.line_count ?? 0).length;
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
    // time delta to the previous row of the view (not the previously rendered one)
    let delta = "";
    if (showDelta && r > 0) {
      const prev = getRow(r - 1);
      if (row.t != null && prev?.t != null) delta = formatDelta(row.t - prev.t);
    }
    const deltaEl = delta && <span className="text-gray-500 italic">(+{delta}) </span>;

    // the fields as columns: [value] padded to the widest value of the field, so
    // they line up; lines not in the format are shown as they are
    const cells: React.ReactNode[] = [];
    let deltaShown = false;
    if (row.fields) {
      columns.forEach((c, i) => {
        const v = row.fields![i] ?? "";
        if (c.kind === "message") {
          cells.push(<span key={i}>{v}</span>);
          return;
        }
        if (hiddenColumns.includes(c.name)) return;
        const width = columnWidths[c.name];
        const style: React.CSSProperties = width ? { display: "inline-block", minWidth: `${width + 3}ch` } : {};
        if (c.kind === "level") {
          style.color = levelColor(v) ?? "white";
          style.fontWeight = "bold";
        }
        cells.push(
          <span key={i} className={c.kind === "text" ? FIELD_COLORS[c.name] ?? "text-gray-400" : undefined} style={style}>
            [{v}]{" "}
          </span>
        );
        if (c.kind === "time" && deltaEl) {
          cells.push(<span key="delta">{deltaEl}</span>);
          deltaShown = true;
        }
      });
    } else {
      cells.push(<span key="text">{row.text}</span>);
    }

    rows.push(
      <div
        key={r}
        className={`font-mono px-3 whitespace-pre ${row.context ? "opacity-60" : ""} ${r === highlightRow ? "bg-yellow-500/30" : ""}`}
        style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
      >
        <span className="inline-block text-right text-gray-500" style={{ minWidth: `${lineDigits}ch` }}>
          {row.line_number}
        </span>
        :{" "}
        {!deltaShown && deltaEl}
        {cells}
        {row.truncated && <span className="text-gray-500 italic"> … (line cut for display)</span>}
      </div>
    );
  }

  const parsedGoto = parseGoto();
  const panelStatus = isSearching
    ? "Searching…"
    : search.length >= SEARCH_MIN
      ? searchResults.length === 0
        ? "No matches"
        : searchComplete
          ? `${searchResults.length.toLocaleString()} ${searchResults.length === 1 ? "match" : "matches"}`
          : `First ${searchResults.length.toLocaleString()} matches`
      : searchInput.length > 0
        ? `Type at least ${SEARCH_MIN} characters`
        : "Searches the rows of the current view";

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border">
      {loading && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-30">
          <Spinner className="w-8 h-8 text-white" />
        </div>
      )}

      {/* Status bar + exports */}
      <div className="relative flex items-center gap-2 border-b bg-muted/30 px-3 py-1">
        {/* a thin sweep along the bottom edge while the file is still being indexed */}
        {info?.partial && (
          <div className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
            <IndexingSweep tone="dark" />
          </div>
        )}
        {statusStart}
        <div role="status" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {error
            ? `Error: ${error}`
            : info?.partial
              ? `Indexing ${info.line_count.toLocaleString()} lines… · showing the start of the file` +
                ` · rows ${(firstRow + 1).toLocaleString()}–${(firstRow + visibleRows).toLocaleString()}`
            : info
              ? `${info.match_count.toLocaleString()} matching lines` +
              (info.context > 0 ? `, ${info.row_count.toLocaleString()} rows with ±${info.context} context` : "") +
              ` · ${info.line_count.toLocaleString()} lines ` +
              (info.cached ? "(cached result, no rescan)" : `scanned in ${Math.round(info.scan_ms).toLocaleString()} ms`) +
              (rowCount > 0 ? ` · rows ${(firstRow + 1).toLocaleString()}–${Math.min(rowCount, firstRow + visibleRows).toLocaleString()}` : "")
              : "Loading…"}
        </div>
        {exportMsg && (
          <div className="max-w-[40%] truncate text-xs text-muted-foreground" title={exportMsg}>
            {exportMsg}
          </div>
        )}
        <span className="hidden text-xs text-muted-foreground sm:inline">Export</span>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={!rowCount} onClick={() => download("txt")}>
          <Download className="size-3.5" />
          Text
        </Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={!rowCount} onClick={() => download("csv")}>
          <Download className="size-3.5" />
          CSV
        </Button>
      </div>

      {showMinimap && (
        <Minimap
          baseUrl={baseUrl}
          sessionId={sessionId}
          filterParams={filterParams}
          axis={minimapAxis}
          color={minimapColor}
          visible={visibleRef.current}
          onJumpToLine={jumpToLine}
          timeRange={timeRange}
          onTimeRangeChange={onTimeRangeChange}
        />
      )}

      {lanesField && (
        <ThreadLanes
          baseUrl={baseUrl}
          sessionId={sessionId}
          filterParams={filterParams}
          field={lanesField.name}
          fieldLabel={lanesField.label}
          visible={visibleRef.current}
          onJumpToLine={jumpToLine}
          timeRange={timeRange}
          onTimeRangeChange={onTimeRangeChange}
        />
      )}

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

      {/* Search & go to line: floating panel */}
      {searchOpen && (
        <FloatingPanel
          title="Search & go to"
          icon={<Search className="size-4 text-muted-foreground" />}
          onClose={() => onSearchOpenChange(false)}
          storageKey="logviewer.searchPanel"
          defaultRect={() => ({
            x: window.innerWidth - 460,
            y: 120,
            w: 440,
            h: Math.min(520, window.innerHeight - 160),
          })}
        >
          <div className="flex flex-col gap-2 border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder="Search in view…  (Ctrl+F)"
                className="h-8 pl-8"
                value={searchInput}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && searchResults.length > 0) jumpToRow(searchResults[0].row);
                }}
              />
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <LocateFixed className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={gotoInputRef}
                  placeholder={timeSpan ? "Go to line or time…  (Ctrl+G)" : "Go to line…  (Ctrl+G)"}
                  className="h-8 pl-8"
                  value={gotoInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGotoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") goTo();
                  }}
                  aria-describedby="goto-hint"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="h-8"
                onClick={goTo}
                disabled={!rowCount || parsedGoto?.kind === "error" || !gotoInput.trim()}
              >
                {parsedGoto?.kind === "range" ? "Filter" : "Go"}
              </Button>
            </div>
            <div id="goto-hint" className="line-clamp-2 min-h-4 break-words pl-1 font-mono text-[11px] text-muted-foreground" title={gotoMsg ?? undefined}>
              {gotoMsg ??
                (parsedGoto?.kind === "error" ? (
                  <span className="text-destructive">{parsedGoto.message}</span>
                ) : parsedGoto?.kind === "time" ? (
                  <>→ {formatFull(parsedGoto.t)}{timeSpan && (parsedGoto.t < timeSpan.start || parsedGoto.t > timeSpan.end) ? " (outside the file)" : ""}</>
                ) : parsedGoto?.kind === "range" ? (
                  <>Filter to {formatRange(parsedGoto)}</>
                ) : timeSpan ? (
                  "e.g. 48213 · 14:05 · 11-18 14:05:30 · 14:00 - 14:30 to filter"
                ) : (
                  "A line number"
                ))}
            </div>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
            {isSearching && <Spinner className="size-3" />}
            {panelStatus}
          </div>

          {/* Results */}
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-4">
            {searchResults.map((r) => (
              <button
                type="button"
                key={r.row}
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-accent ${r.row === highlightRow ? "bg-accent" : ""}`}
                onClick={() => jumpToRow(r.row)}
                title={r.text}
              >
                <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{r.line_number}</span>
                <ResultText hit={r} q={search} columns={columns} />
              </button>
            ))}
          </div>
        </FloatingPanel>
      )}
    </div>
  );
};
