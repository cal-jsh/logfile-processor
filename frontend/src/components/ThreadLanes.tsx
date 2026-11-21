import { useEffect, useRef, useState } from "react";
import { Focus, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { colorMap } from "../lib/colorMap";
import { formatFull, timeTicks, type VisibleRange } from "./Minimap";
import { RangeShade, rangeCursor, useTimeRangeDrag, type TimeRange } from "./TimeRangeSelect";

/*
 * Swimlanes of thread activity: one lane per thread, a shared time axis, and every log
 * line drawn in its thread's lane at its time, so parallel activity lines up vertically.
 *
 * Like the minimap, the backend aggregates per pixel column (GET /lanes): per lane the
 * most severe level (the colour) and how many lines fall in the column (the opacity, log
 * scale), so the browser never holds per-line data. The 48 busiest threads get a lane
 * each, in name order; the rest share an "other" lane at the bottom. More lanes than fit
 * scroll vertically; the panel height can be dragged.
 *
 * Zoom: Ctrl+wheel or the buttons; drag to pan, Shift+wheel too. The backend re-bins the
 * zoomed window from the lines in it, so zooming in shows finer detail, not bigger pixels.
 * While the new window loads, the previous one is drawn stretched.
 *
 * Hover shows the time, the thread and the first line of that thread under the pointer;
 * click jumps there. With a filter, all lines stay as a dim background and the matching
 * lines are drawn on top. The box marks the time range on screen.
 *
 * Time range filter, as on the minimap: drag on the time scale or Shift+drag on the lanes
 * to filter to a range, drag its edges to change it, drag it on the scale to move it.
 * Double-click the scale or the lanes to clear the range and show the whole file again.
 */

const LANE_H = 14; // css px per lane
const MARK_PAD = 2; // css px above and below the marks in a lane
const LABEL_W = 132; // css px, lane names
const AXIS_H = 18;
const MIN_SPAN = 50; // ms, deepest zoom
const DEFAULT_HEIGHT = 168;
const MAX_BUCKETS = 16384;

/** Level codes of the API (as the minimap) */
const CODE_LEVEL = [null, "OTHER", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"] as const;
const CODE_COLOR: (string | null)[] = [null, "#6b6b6b", colorMap.TRACE, colorMap.DEBUG, colorMap.INFO, colorMap.WARN, colorMap.ERROR, colorMap.CRITICAL];

type Lane = { name: string; lines: number };

type LanesData = {
  field: string;
  line_count: number;
  lanes: Lane[];
  other_values: number;
  other_lines: number;
  max_lanes: number;
  time_start_ms: number | null;
  time_end_ms: number | null;
  from_ms: number | null;
  to_ms: number | null;
  buckets: number;
  all: Encoded;
  matched: Encoded | null;
  match_count: number | null;
  window_lines: number;
};

/** One digit per column, per lane: dominant level, a CRITICAL/ERROR/WARN that does not dominate,
    and the number of lines (1..9, log scale) */
type Encoded = { levels: string[]; alerts: string[]; density: string[] };

/** A response plus the query that produced it (resent unchanged for /lanes/at) */
type Fetched = { data: LanesData; query: string; key: string };

type LaneAt = { line: number | null; level: number | null; time_ms: number | null; text: string | null };

type Hover = {
  x: number; // css px in the lanes area
  y: number; // css px from the panel's top
  lane: number;
  time: number;
  at: LaneAt | null;
};

type Window = { from: number; to: number };

const readHeight = () => {
  try {
    const v = Number(localStorage.getItem("logviewer.lanesHeight"));
    return Number.isFinite(v) && v >= 40 ? v : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
};

/** Draw one lane's columns of `data` (window df..dt) onto the view vf..vt */
function paintLane(
  ctx: CanvasRenderingContext2D,
  levels: string,
  density: string | null,
  y: number,
  h: number,
  w: number,
  df: number,
  dt: number,
  vf: number,
  vt: number,
  alpha: number | null
) {
  const n = levels.length;
  if (!n || !(dt > df) || !(vt > vf)) return;
  const xOf = (j: number) => ((df + (j * (dt - df)) / n - vf) / (vt - vf)) * w;
  let i = 0;
  while (i < n) {
    const c = levels.charCodeAt(i) - 48;
    const d = density ? density.charCodeAt(i) - 48 : 9;
    let j = i + 1;
    while (j < n && levels.charCodeAt(j) - 48 === c && (!density || density.charCodeAt(j) - 48 === d)) j++;
    const color = CODE_COLOR[c];
    if (color) {
      const x0 = Math.round(xOf(i));
      const x1 = Math.round(xOf(j));
      if (x1 >= 0 && x0 <= w) {
        ctx.globalAlpha = alpha ?? 0.3 + (0.7 * d) / 9;
        ctx.fillStyle = color;
        ctx.fillRect(x0, y, Math.max(2, x1 - x0), h);
      }
    }
    i = j;
  }
  ctx.globalAlpha = 1;
}

export function ThreadLanes({
  baseUrl,
  sessionId,
  filterParams,
  field,
  fieldLabel,
  visible,
  onJumpToLine,
  timeRange,
  onTimeRangeChange,
}: {
  baseUrl: string;
  sessionId: string;
  filterParams: string;
  /** The text field that makes the lanes, usually "thread" */
  field: string;
  fieldLabel: string;
  visible: VisibleRange | null;
  onJumpToLine: (line: number) => void;
  /** The time range filter, if any */
  timeRange: TimeRange | null;
  onTimeRangeChange: (r: TimeRange | null) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(0);
  const [pxWidth, setPxWidth] = useState(0);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<Window | null>(null); // null: the whole file
  const [height, setHeight] = useState(readHeight);
  const [hover, setHover] = useState<Hover | null>(null);

  // a response for another file or field is never drawn
  const key = `${sessionId}|${field}|${filterParams}`;
  const data = fetched && fetched.key === key ? fetched.data : fetched?.key.startsWith(`${sessionId}|${field}|`) ? fetched.data : null;
  const t0 = data?.time_start_ms ?? 0;
  const t1 = data?.time_end_ms ?? 0;
  const hasTime = data?.time_start_ms != null && data.time_end_ms != null && t1 >= t0;
  const vf = view?.from ?? t0;
  const vt = view?.to ?? (t1 > t0 ? t1 : t0 + 1);
  const laneCount = data ? data.all.levels.length : 0;

  // back to the whole file for another file or field
  useEffect(() => setView(null), [sessionId, field]);

  /* width: redraw at once, refetch after resizing settles */
  useEffect(() => {
    const el = areaRef.current;
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

  /* fetch: debounced, so zooming and panning ask once they pause */
  useEffect(() => {
    if (!pxWidth) return;
    const ctrl = new AbortController();
    const win = view ? `&from_ms=${Math.floor(view.from)}&to_ms=${Math.ceil(view.to)}` : "";
    const query = `session_id=${encodeURIComponent(sessionId)}&field=${encodeURIComponent(field)}${filterParams}&buckets=${pxWidth}${win}`;
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`${baseUrl}/lanes?${query}`, { signal: ctrl.signal })
        .then(async (r) => {
          if (r.status === 409) return null; // superseded by a newer filter
          if (!r.ok) throw new Error((await r.text()) || String(r.status));
          return r.json();
        })
        .then((d: LanesData | null) => {
          if (d) {
            setFetched({ data: d, query, key });
            setError(null);
          }
          setLoading(false);
        })
        .catch((e) => {
          if (e?.name === "AbortError") return;
          setLoading(false);
          setError(String(e?.message ?? e));
        });
    }, view ? 120 : 0);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [baseUrl, sessionId, field, filterParams, pxWidth, view, key]);

  /* draw */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(laneCount * LANE_H * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (!data || !hasTime) return;
    const df = data.from_ms ?? t0;
    const dt = data.to_ms ?? t1;
    const laneH = LANE_H * dpr;
    const pad = MARK_PAD * dpr;
    for (let l = 0; l < laneCount; l++) {
      const y = l * laneH;
      if (l % 2 === 1) {
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(0, y, w, laneH);
      }
      const markH = laneH - 2 * pad;
      if (data.matched) paintLane(ctx, data.all.levels[l], null, y + pad, markH, w, df, dt, vf, vt, 0.13);
      const e = data.matched ?? data.all;
      paintLane(ctx, e.levels[l], e.density[l], y + pad, markH, w, df, dt, vf, vt, null);
      // errors and warnings that do not dominate their column: a strip on top of the mark
      paintLane(ctx, e.alerts[l], null, y + pad, Math.max(1, Math.round(markH / 3)), w, df, dt, vf, vt, 1);
    }
  }, [data, cssWidth, laneCount, hasTime, t0, t1, vf, vt]);

  /* zoom and pan */
  const clampView = (from: number, to: number): Window | null => {
    const full = t1 - t0;
    let span = Math.max(MIN_SPAN, to - from);
    if (span >= full) return null;
    span = Math.min(span, full);
    const f = Math.min(Math.max(from, t0), t1 - span);
    return { from: f, to: f + span };
  };
  const zoomAt = (frac: number, factor: number) => {
    if (!hasTime) return;
    const span = vt - vf;
    const at = vf + frac * span;
    const ns = span * factor;
    setView(clampView(at - frac * ns, at - frac * ns + ns));
  };
  const panBy = (dxCss: number) => {
    if (!hasTime || !view || !cssWidth) return;
    const dt = (-dxCss / cssWidth) * (vt - vf);
    setView(clampView(vf + dt, vt + dt));
  };

  // wheel: Ctrl zooms, Shift (or a sideways wheel) pans, plain wheel scrolls the lanes
  const wheelRef = useRef<(e: WheelEvent) => void>(() => { });
  wheelRef.current = (e: WheelEvent) => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || !hasTime) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt((e.clientX - rect.left) / rect.width, Math.pow(1.0015, e.deltaY));
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      panBy(-(e.shiftKey ? e.deltaY : e.deltaX));
    }
  };
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);

  /* hover readout: the first line of that thread near the pointer, fetched when the
     pointer rests a moment */
  const atReq = useRef<AbortController | null>(null);
  const atTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lookup = (lane: number, x: number): Promise<LaneAt | null> => {
    if (!fetched || !data || !cssWidth) return Promise.resolve(null);
    const df = data.from_ms ?? t0;
    const dt = data.to_ms ?? t1;
    const t = vf + (x / cssWidth) * (vt - vf);
    const column = Math.floor(((t - df) / (dt - df)) * data.buckets);
    if (column < 0 || column >= data.buckets) return Promise.resolve(null);
    atReq.current?.abort();
    const ctrl = new AbortController();
    atReq.current = ctrl;
    return fetch(`${baseUrl}/lanes/at?${fetched.query}&lane=${lane}&column=${column}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  };

  const pointAt = (e: React.PointerEvent) => {
    const area = areaRef.current!.getBoundingClientRect();
    const panel = panelRef.current!.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - area.left, 0), area.width - 1);
    const lane = Math.floor((e.clientY - area.top) / LANE_H);
    return { x, y: e.clientY - panel.top, lane: Math.min(Math.max(lane, 0), Math.max(0, laneCount - 1)) };
  };

  /* time range: drag on the scale, Shift+drag or an edge on the lanes */
  const areaRect = () => areaRef.current!.getBoundingClientRect();
  const range = useTimeRangeDrag({
    range: hasTime ? timeRange : null,
    onChange: onTimeRangeChange,
    timeAt: (clientX) => {
      const r = areaRect();
      return vf + ((clientX - r.left) / r.width) * (vt - vf);
    },
    xOf: (t) => {
      const r = areaRect();
      return r.left + ((t - vf) / (vt - vf)) * r.width;
    },
    bounds: [t0, t1],
  });
  const shownRange = hasTime ? range.draft ?? timeRange : null;
  // double-click on the scale or the lanes: the whole file again, without the time range
  const showAll = () => {
    setView(null);
    if (timeRange) onTimeRangeChange(null);
  };
  const onScaleDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !hasTime || !areaRef.current) return;
    range.begin(e, true);
  };
  const onScaleMove = (e: React.PointerEvent) => {
    if (!hasTime || !areaRef.current || range.move(e)) return;
    (e.currentTarget as HTMLElement).style.cursor = rangeCursor(range.hit(e.clientX), true) ?? "";
  };

  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !hasTime) return;
    const h = range.hit(e.clientX);
    if (e.shiftKey || h === "from" || h === "to") {
      setHover(null);
      range.begin(e, false);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!data || !hasTime) return;
    if (range.move(e)) return;
    const h = range.hit(e.clientX);
    (e.currentTarget as HTMLElement).style.cursor = h === "from" || h === "to" ? "ew-resize" : e.shiftKey ? "crosshair" : "";
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      if (d.moved || Math.abs(dx) > 3) {
        if (view) {
          d.moved = true;
          d.x = e.clientX;
          panBy(dx);
          setHover(null);
          return;
        }
      }
    }
    const p = pointAt(e);
    const time = vf + (p.x / Math.max(1, cssWidth)) * (vt - vf);
    setHover((h) => ({ ...p, time, at: h && h.lane === p.lane && Math.abs(h.x - p.x) < 2 ? h.at : null }));
    clearTimeout(atTimer.current);
    atTimer.current = setTimeout(() => {
      lookup(p.lane, p.x).then((at) => {
        if (at) setHover((h) => (h && h.lane === p.lane && h.x === p.x ? { ...h, at } : h));
      });
    }, 90);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (range.dragging() && range.end()) return;
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !data) return;
    const p = pointAt(e);
    lookup(p.lane, p.x).then((at) => {
      if (at?.line) onJumpToLine(at.line);
    });
  };
  useEffect(() => () => clearTimeout(atTimer.current), []);

  /* panel height: drag the bottom edge */
  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const max = Math.max(60, laneCount * LANE_H + 2);
    const move = (ev: PointerEvent) => setHeight(Math.min(max, Math.max(LANE_H * 2, startH + ev.clientY - startY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setHeight((h) => {
        try {
          localStorage.setItem("logviewer.lanesHeight", String(Math.round(h)));
        } catch {
          /* storage unavailable */
        }
        return h;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // time range on screen
  let box: { left: number; width: number } | null = null;
  if (visible && hasTime && cssWidth && visible.tFirst != null && visible.tLast != null) {
    const a = (Math.min(visible.tFirst, visible.tLast) - vf) / (vt - vf);
    const b = (Math.max(visible.tFirst, visible.tLast) - vf) / (vt - vf);
    if (b >= 0 && a <= 1) {
      const left = Math.max(0, a) * cssWidth;
      const width = Math.max(3, (Math.min(1, b) - Math.max(0, a)) * cssWidth);
      box = { left: Math.min(left, cssWidth - width), width };
    }
  }

  const ticks = hasTime ? timeTicks(vf, vt, cssWidth) : [];
  const names: string[] = data ? [...data.lanes.map((l) => l.name)] : [];
  if (data && data.other_values > 0) names.push(`other (${data.other_values.toLocaleString()})`);
  const laneTitle = (i: number) => {
    if (!data) return "";
    const l = data.lanes[i];
    if (l) return `${l.name}: ${l.lines.toLocaleString()} lines`;
    return `${data.other_values.toLocaleString()} quieter ${fieldLabel.toLowerCase()}s together: ${data.other_lines.toLocaleString()} lines`;
  };
  const zoomFactor = hasTime && t1 > t0 ? (t1 - t0) / (vt - vf) : 1;
  const atLevel = hover?.at?.level != null ? CODE_LEVEL[hover.at.level] : null;

  return (
    <div ref={panelRef} className="relative shrink-0 select-none border-b border-white/10 text-white" style={{ background: "#252526" }}>
      {/* header: name column and time scale */}
      <div className="flex border-b border-white/5" style={{ height: AXIS_H }}>
        <div className="flex shrink-0 items-center gap-0.5 border-r border-white/5 pl-2 pr-1 text-[10px] text-white/60" style={{ width: LABEL_W }}>
          <span className="mr-auto truncate" title={data ? `${fieldLabel} lanes: the ${data.max_lanes} busiest get a lane each` : undefined}>
            {fieldLabel}s{data ? ` · ${(data.lanes.length + data.other_values).toLocaleString()}` : ""}
          </span>
          <button type="button" title="Zoom in (Ctrl+wheel)" aria-label="Zoom in" disabled={!hasTime || vt - vf <= MIN_SPAN} onClick={() => zoomAt(0.5, 0.5)} className="rounded p-0.5 hover:bg-white/10 disabled:opacity-30">
            <ZoomIn className="size-3" />
          </button>
          <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!view} onClick={() => zoomAt(0.5, 2)} className="rounded p-0.5 hover:bg-white/10 disabled:opacity-30">
            <ZoomOut className="size-3" />
          </button>
          <button type="button" title="Whole file" aria-label="Show the whole file" disabled={!view} onClick={() => setView(null)} className="rounded p-0.5 hover:bg-white/10 disabled:opacity-30">
            <Maximize2 className="size-3" />
          </button>
          {timeRange && hasTime && (
            <button
              type="button"
              title="Zoom to the time range filter"
              aria-label="Zoom to the time range filter"
              onClick={() => {
                const pad = (timeRange.to - timeRange.from) * 0.05;
                setView(clampView(timeRange.from - pad, timeRange.to + pad));
              }}
              className="rounded p-0.5 hover:bg-white/10"
            >
              <Focus className="size-3" />
            </button>
          )}
        </div>
        <div
          className="relative min-w-0 flex-1 touch-none overflow-hidden"
          onDoubleClick={showAll}
          onPointerDown={onScaleDown}
          onPointerMove={onScaleMove}
          onPointerUp={() => range.dragging() && range.end()}
          onPointerCancel={range.cancel}
          title={hasTime ? `Drag to filter a time range${view || timeRange ? " · double-click: whole file, no time range" : ""}` : undefined}
        >
          {ticks.map(({ t, label }) => {
            const x = ((t - vf) / (vt - vf)) * cssWidth;
            if (x > cssWidth - (label.length * 6 + 8)) return null;
            return (
              <div key={t} className="absolute top-0 h-full" style={{ left: x }}>
                <div className="absolute bottom-0 h-1 w-px bg-white/30" />
                <div className="absolute left-1 top-0 whitespace-nowrap font-mono text-[10px] leading-[16px] text-white/55">{label}</div>
              </div>
            );
          })}
          {view && (
            <div className="absolute right-1 top-0 rounded bg-black/40 px-1 font-mono text-[10px] leading-[16px] text-white/60">
              {zoomFactor >= 10 ? Math.round(zoomFactor).toLocaleString() : zoomFactor.toFixed(1)}×
            </div>
          )}
          {shownRange && <RangeShade range={shownRange} vf={vf} vt={vt} width={cssWidth} grips label draft={!!range.draft} />}
        </div>
      </div>

      {/* lanes: names and marks scroll together */}
      <div className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: height }}>
        <div className="flex" style={{ height: Math.max(laneCount * LANE_H, 2 * LANE_H) }}>
          <div className="shrink-0 border-r border-white/5" style={{ width: LABEL_W }}>
            {names.map((n, i) => (
              <div
                key={n}
                title={laneTitle(i)}
                className={`truncate px-2 font-mono text-[10px] ${hover?.lane === i ? "bg-white/10 text-white" : i >= (data?.lanes.length ?? 0) ? "italic text-white/45" : "text-white/70"}`}
                style={{ height: LANE_H, lineHeight: `${LANE_H}px` }}
              >
                {n}
              </div>
            ))}
          </div>
          <div
            ref={areaRef}
            className={`relative min-w-0 flex-1 touch-none ${view ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              range.cancel();
            }}
            onDoubleClick={showAll}
            onPointerLeave={() => {
              clearTimeout(atTimer.current);
              setHover(null);
            }}
            role="img"
            aria-label={`${fieldLabel} lanes over time, click to jump to a line`}
          >
            <canvas ref={canvasRef} className="absolute left-0 top-0 w-full" style={{ height: laneCount * LANE_H, imageRendering: "pixelated" }} />
            {shownRange && <RangeShade range={shownRange} vf={vf} vt={vt} width={cssWidth} draft={!!range.draft} dim={0.3} />}
            {box && (
              <div
                className="pointer-events-none absolute inset-y-0 z-[6] rounded-[2px] border border-white/80 bg-white/10 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{ left: box.left, width: box.width }}
              />
            )}
            {hover && (
              <>
                <div className="pointer-events-none absolute inset-y-0 w-px bg-white/60" style={{ left: hover.x }} />
                <div className="pointer-events-none absolute inset-x-0 bg-white/[0.06]" style={{ top: hover.lane * LANE_H, height: LANE_H }} />
              </>
            )}
            {!data && (
              <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-[11px] text-white/50" style={{ height: LANE_H * 2 }}>
                {error ? `Thread lanes unavailable: ${error}` : loading ? "Building thread lanes…" : ""}
              </div>
            )}
            {data && (!hasTime || laneCount === 0) && (
              <div className="pointer-events-none px-3 text-[11px] leading-[28px] text-white/50">
                {!hasTime ? "No timestamps found in this file" : `No ${fieldLabel.toLowerCase()} values in this file`}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* resize handle */}
      {laneCount * LANE_H > 2 * LANE_H && (
        <div
          className="h-1 cursor-row-resize bg-white/5 hover:bg-white/20"
          onPointerDown={onResizeDown}
          title="Drag to resize"
          aria-label="Resize thread lanes"
          role="separator"
        />
      )}

      {/* hover readout, above the lanes so the scroll area does not clip it */}
      {hover && data && (
        <div
          className="pointer-events-none absolute z-20 max-w-[min(640px,70%)] rounded bg-black/90 px-1.5 py-1 font-mono text-[10px] text-white shadow"
          style={{
            top: Math.max(0, hover.y + 12),
            ...(hover.x > cssWidth / 2 ? { right: cssWidth - hover.x + 8 } : { left: LABEL_W + hover.x + 8 }),
          }}
        >
          <div className="whitespace-nowrap">
            <span className="text-white/75">{formatFull(hover.time)}</span>
            <span className="ml-1.5 font-semibold">{names[hover.lane]}</span>
          </div>
          {hover.at?.line != null ? (
            <>
              <div className="whitespace-nowrap">
                Line {hover.at.line.toLocaleString()}
                {atLevel && (
                  <span className="ml-1.5 font-semibold" style={{ color: CODE_COLOR[hover.at.level!] ?? undefined }}>
                    {atLevel === "OTHER" ? "" : atLevel}
                  </span>
                )}
                {hover.at.time_ms != null && <span className="ml-1.5 text-white/60">{formatFull(hover.at.time_ms)}</span>}
              </div>
              <div className="truncate text-white/80">{hover.at.text}</div>
            </>
          ) : hover.at ? (
            <div className="text-white/50">No lines of this {fieldLabel.toLowerCase()} here</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
