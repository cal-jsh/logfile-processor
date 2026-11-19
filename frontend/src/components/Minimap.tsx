import { useEffect, useRef, useState } from "react";
import { colorMap } from "../lib/colorMap";

/*
 * Horizontal minimap of the whole file: one vertical line per pixel column, colored by
 * the most severe log level of the lines it covers.
 *
 * The backend aggregates the levels into one bucket per device pixel (GET /minimap), so
 * the browser never holds per-line data, whatever the file size. With a filter, the
 * file's levels stay as a dim background and the matching lines are drawn on top.
 * The box marks the lines currently on screen; click or drag to jump.
 *
 * Axis "line": every column covers the same number of lines.
 * Axis "time": every column covers the same slice of the file's time span, so quiet
 * periods show as gaps and bursts as dense bands. A time scale is drawn above it.
 */

export type MinimapAxis = "line" | "time";

const HEIGHT = 28; // css px, the bar
const AXIS_HEIGHT = 16; // css px, time labels above the bar
const MAX_BUCKETS = 16384; // backend limit
const LABEL_SPACING = 120; // css px between time labels, roughly

/** Level codes of the /minimap API, in severity order */
const CODE_LEVEL = [null, "OTHER", "TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;
const CODE_COLOR: (string | null)[] = [
  null,
  "#6b6b6b",
  colorMap.TRACE,
  colorMap.DEBUG,
  colorMap.INFO,
  colorMap.WARN,
  colorMap.ERROR,
];

type MinimapData = {
  axis: MinimapAxis;
  line_count: number;
  buckets: number;
  all: number[];
  matched: number[] | null;
  match_count: number | null;
  /** time axis: 1-based first line per column, 0 for an empty column */
  first_lines: number[] | null;
  time_start_ms: number | null;
  time_end_ms: number | null;
};

/** What is on screen: 1-based file lines, and their times (ms, log clock) if known */
export type VisibleRange = { first: number; last: number; tFirst: number | null; tLast: number | null };

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?/;

/** A log timestamp as ms since 1970 in the log's own clock (no time zone), like the backend */
export function parseLogTime(ts: string | undefined): number | null {
  const m = ts ? TS_RE.exec(ts.trim()) : null;
  if (!m) return null;
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + frac;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Format a log-clock time; `step` (ms) decides the precision */
function formatTime(t: number, step: number, withDate: boolean): string {
  const d = new Date(t);
  const date = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (step >= 86_400_000) return date;
  let time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (step < 60_000) time += `:${pad(d.getUTCSeconds())}`;
  if (step < 1000) time += `.${pad(d.getUTCMilliseconds(), 3)}`;
  return withDate ? `${date} ${time}` : time;
}

/** Full readout for the hover label */
function formatFull(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, S, 2 * S, 5 * S, 10 * S, 15 * S, 30 * S, M, 2 * M, 5 * M, 10 * M, 15 * M, 30 * M, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D, 91 * D, 365 * D];

/** Tick times and labels for a span of `start..end` over `width` px */
function timeTicks(start: number, end: number, width: number): { t: number; label: string }[] {
  const span = end - start;
  if (!(span > 0) || width <= 0) return [];
  const want = (span * LABEL_SPACING) / width;
  const step = STEPS.find((s) => s >= want) ?? STEPS[STEPS.length - 1];
  const out: { t: number; label: string }[] = [];
  let prevDay = -1;
  for (let t = Math.ceil(start / step) * step; t <= end && out.length < 200; t += step) {
    const day = Math.floor(t / D);
    out.push({ t, label: formatTime(t, step, step < D && day !== prevDay) });
    prevDay = day;
  }
  return out;
}

/** Fill each run of equal codes as one rectangle */
function paint(ctx: CanvasRenderingContext2D, codes: number[], width: number, height: number, alpha: number) {
  const n = codes.length;
  if (!n) return;
  ctx.globalAlpha = alpha;
  let i = 0;
  while (i < n) {
    const c = codes[i];
    let j = i + 1;
    while (j < n && codes[j] === c) j++;
    const color = CODE_COLOR[c];
    if (color) {
      const x0 = Math.round((i * width) / n);
      const x1 = Math.round((j * width) / n);
      ctx.fillStyle = color;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), height);
    }
    i = j;
  }
  ctx.globalAlpha = 1;
}

type Hover = { x: number; line: number | null; time: number | null; level: string | null };

export function Minimap({
  baseUrl,
  sessionId,
  filterParams,
  axis,
  visible,
  onJumpToLine,
}: {
  baseUrl: string;
  sessionId: string;
  /** Encoded filter query parameters, e.g. "&levels=ERROR&keywords=foo" */
  filterParams: string;
  axis: MinimapAxis;
  visible: VisibleRange | null;
  onJumpToLine: (line: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(0);
  const [pxWidth, setPxWidth] = useState(0); // debounced device-pixel width
  const [fetched, setFetched] = useState<MinimapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);

  // data of the other axis is never drawn (it arrives a moment after a switch)
  const data = fetched && fetched.axis === axis ? fetched : null;
  const timeAxis = data?.axis === "time" && data.time_start_ms != null && data.time_end_ms != null;
  const t0 = data?.time_start_ms ?? 0;
  const t1 = data?.time_end_ms ?? 0;

  /* width: redraw immediately (stretched), refetch after resizing settles */
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const w = el.clientWidth;
      setCssWidth(w);
      clearTimeout(t);
      t = setTimeout(() => setPxWidth(Math.min(MAX_BUCKETS, Math.round(w * (window.devicePixelRatio || 1)))), 150);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, []);

  /* fetch the buckets */
  useEffect(() => {
    if (!pxWidth) return;
    const ctrl = new AbortController();
    setLoading(true);
    fetch(
      `${baseUrl}/minimap?session_id=${encodeURIComponent(sessionId)}${filterParams}&buckets=${pxWidth}&axis=${axis}`,
      { signal: ctrl.signal }
    )
      .then((r) => {
        if (r.status === 409) return null; // superseded by a newer filter
        return r.ok ? r.json() : Promise.reject(new Error(String(r.status)));
      })
      .then((d: MinimapData | null) => {
        if (d) setFetched(d);
        setLoading(false);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setLoading(false);
      });
    return () => ctrl.abort();
  }, [baseUrl, sessionId, filterParams, pxWidth, axis]);

  /* draw */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.round(HEIGHT * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!data) return;
    if (data.matched) {
      paint(ctx, data.all, w, h, 0.16);
      paint(ctx, data.matched, w, h, 1);
    } else {
      paint(ctx, data.all, w, h, 1);
    }
  }, [data, cssWidth]);

  /* pointer: hover readout, click and drag to jump */
  const lineCount = data?.line_count ?? 0;
  const columnAt = (f: number) => (data ? Math.min(data.buckets - 1, Math.floor(f * data.buckets)) : 0);

  /** Line to jump to for a position: by line, proportional; by time, the first line of
      that time slice (or of the nearest slice with lines, looking ahead first) */
  const targetAt = (clientX: number): Hover & { jump: number | null } => {
    const rect = barRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const f = Math.min(Math.max(x / rect.width, 0), 0.999999);
    const codes = data ? data.matched ?? data.all : [];
    const level = CODE_LEVEL[codes[columnAt(f)] ?? 0];
    if (!timeAxis || !data?.first_lines) {
      const line = Math.floor(f * lineCount) + 1;
      return { x, line, time: null, level, jump: line };
    }
    const fl = data.first_lines;
    const c = columnAt(f);
    let jump: number | null = null;
    for (let d = 0; d < fl.length && jump == null; d++) {
      if (c + d < fl.length && fl[c + d] > 0) jump = fl[c + d];
      else if (c - d >= 0 && fl[c - d] > 0) jump = fl[c - d];
    }
    return { x, line: fl[c] > 0 ? fl[c] : null, time: t0 + f * (t1 - t0), level, jump };
  };
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!lineCount || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    const p = targetAt(e.clientX);
    if (p.jump != null) onJumpToLine(p.jump);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!lineCount) return;
    const p = targetAt(e.clientX);
    setHover(p);
    if (dragging.current && p.jump != null) onJumpToLine(p.jump);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  // viewport box, at least 3 px wide so it stays visible on huge files
  let box: { left: number; width: number } | null = null;
  if (visible && data && cssWidth) {
    let a: number | null = null;
    let b: number | null = null;
    if (timeAxis) {
      if (visible.tFirst != null && visible.tLast != null && t1 > t0) {
        a = (Math.min(visible.tFirst, visible.tLast) - t0) / (t1 - t0);
        b = (Math.max(visible.tFirst, visible.tLast) - t0) / (t1 - t0);
      }
    } else if (lineCount) {
      a = (visible.first - 1) / lineCount;
      b = visible.last / lineCount;
    }
    if (a != null && b != null) {
      const left = Math.max(0, a) * cssWidth;
      const width = Math.max(3, (Math.min(1, b) - Math.max(0, a)) * cssWidth);
      box = { left: Math.min(left, cssWidth - width), width };
    }
  }

  const ticks = timeAxis ? timeTicks(t0, t1, cssWidth) : [];
  const hoverColor = hover?.level ? CODE_COLOR[CODE_LEVEL.indexOf(hover.level as never)] ?? undefined : undefined;

  return (
    <div className="shrink-0 select-none border-b border-white/10" style={{ background: "#252526" }}>
      {/* time scale */}
      {axis === "time" && (
        <div className="relative overflow-hidden border-b border-white/5" style={{ height: AXIS_HEIGHT }}>
          {ticks.map(({ t, label }) => {
            const x = ((t - t0) / (t1 - t0)) * cssWidth;
            // no label that would be cut at the right edge
            if (x > cssWidth - (label.length * 6 + 8)) return null;
            return (
              <div key={t} className="absolute top-0 h-full" style={{ left: x }}>
                <div className="absolute bottom-0 h-1 w-px bg-white/30" />
                <div data-tick className="absolute left-1 top-0 whitespace-nowrap font-mono text-[10px] leading-[14px] text-white/55">
                  {label}
                </div>
              </div>
            );
          })}
          {data && !timeAxis && (
            <div className="px-3 text-[10px] leading-[16px] text-white/50">No timestamps found in this file</div>
          )}
        </div>
      )}

      <div
        ref={barRef}
        className="relative cursor-pointer touch-none"
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-label={`Minimap by ${axis}: log levels across the file, click to jump`}
        aria-valuemin={1}
        aria-valuemax={lineCount || 1}
        aria-valuenow={visible?.first ?? 1}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} />

        {box && (
          <div
            className="pointer-events-none absolute inset-y-0 rounded-[2px] border border-white/80 bg-white/10 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{ left: box.left, width: box.width }}
          />
        )}

        {hover && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-white/70" style={{ left: hover.x }} />
            <div
              className="pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 font-mono text-[10px] text-white shadow"
              style={hover.x > cssWidth - 260 ? { right: cssWidth - hover.x + 6 } : { left: hover.x + 6 }}
            >
              {hover.time != null && <span className="mr-1.5 text-white/75">{formatFull(hover.time)}</span>}
              {hover.line != null ? `Line ${hover.line.toLocaleString()}` : "No log lines"}
              {hover.line != null && hover.level && (
                <span className="ml-1.5 font-semibold" style={{ color: hoverColor }}>
                  {hover.level}
                </span>
              )}
            </div>
          </>
        )}

        {!data && (
          <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-[11px] text-white/50">
            {loading ? "Building minimap…" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
