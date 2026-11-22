import { useEffect, useRef, useState } from "react";
import { Focus, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { colorMap, NO_LEVEL_COLOR } from "../lib/colorMap";
import { useTheme } from "../lib/theme";
import { formatFull, timeTicks, type OverviewMark, type VisibleRange } from "./Minimap";
import { RangeShade, rangeCursor, useTimeRangeDrag, type TimeRange } from "./TimeRangeSelect";
import { IndexingSweep } from "./IndexingSweep";
import { dialogOpen, isTypingTarget, prefersReducedMotion } from "../lib/keys";
import { END_W, LABEL_W } from "./plotColumns";

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
 * Zoom: Ctrl+wheel or the buttons; Shift+drag (or the middle button) to pan, Shift+wheel too.
 * With the pointer over the panel W/S zoom in/out at the pointer and A/D pan, smoothly while
 * held, as in Perfetto (a step per press with reduced motion). The backend re-bins the
 * zoomed window from the lines in it, so zooming in shows finer detail, not bigger pixels.
 * While the new window loads, the previous one is drawn stretched.
 *
 * Hover shows the time, the thread and the first line of that thread under the pointer;
 * click jumps there. With a filter, all lines stay as a dim background and the matching
 * lines are drawn on top. The box marks the time range on screen.
 *
 * Bookmarks are pins in their line's lane at its time (hollow when the filter hides it).
 *
 * Time range filter, as on the minimap: drag on the lanes or their time scale to filter
 * to a range (a click jumps), drag its edges to change it, drag it on the scale to move it.
 * Double-click the scale or the lanes to clear the range and show the whole file again.
 */

const LANE_H = 14; // css px per lane
const MARK_PAD = 2; // css px above and below the marks in a lane
const AXIS_H = 18;
const MIN_SPAN = 50; // ms, deepest zoom
const DEFAULT_HEIGHT = 168;
const MAX_BUCKETS = 16384;
const FETCH_DEBOUNCE = 120; // ms of quiet before a zoomed window is fetched
const FETCH_MAX_WAIT = 250; // ms, at the latest while zooming or panning goes on

/* Keyboard navigation, as in Perfetto: W/S zoom in/out at the pointer, A/D pan, smooth while
   held. Speeds at full ramp; a key starts at KEY_RAMP_START of it and reaches full speed
   after KEY_RAMP_MS, so a tap is a small step and holding it gets going. */
const NAV_KEYS: Record<string, "in" | "out" | "left" | "right"> = { KeyW: "in", KeyS: "out", KeyA: "left", KeyD: "right" };
const ZOOM_PER_S = Math.LN2 / 0.3; // the span halves every 0.3 s
const PAN_PER_S = 1.2; // window widths per second
const KEY_RAMP_START = 0.45;
const KEY_RAMP_MS = 500;
// reduced motion: one step per keypress (and per auto-repeat), no animation
const STEP_ZOOM = 0.6;
const STEP_PAN = 0.2;

/** Level codes of the API (as the minimap) */
const CODE_LEVEL = [null, "OTHER", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"] as const;
/** Colours of the codes, from the palette of the theme in effect */
const codeColors = (): (string | null)[] => [null, NO_LEVEL_COLOR, colorMap.TRACE, colorMap.DEBUG, colorMap.INFO, colorMap.WARN, colorMap.ERROR, colorMap.CRITICAL];

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
  const colors = codeColors();
  const xOf = (j: number) => ((df + (j * (dt - df)) / n - vf) / (vt - vf)) * w;
  let i = 0;
  while (i < n) {
    const c = levels.charCodeAt(i) - 48;
    const d = density ? density.charCodeAt(i) - 48 : 9;
    let j = i + 1;
    while (j < n && levels.charCodeAt(j) - 48 === c && (!density || density.charCodeAt(j) - 48 === d)) j++;
    const color = colors[c];
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
  onViewChange,
  marks,
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
  /** The zoomed time window (null: the whole file), for the minimap's marker */
  onViewChange?: (w: TimeRange | null) => void;
  /** Bookmarks, drawn as pins in their lanes */
  marks?: OverviewMark[];
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
  const theme = useTheme();

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

  // tell the minimap which window is zoomed in; nothing once the lanes are gone
  const viewFrom = view?.from;
  const viewTo = view?.to;
  useEffect(() => {
    onViewChange?.(viewFrom != null && viewTo != null ? { from: viewFrom, to: viewTo } : null);
  }, [viewFrom, viewTo, onViewChange]);
  useEffect(() => () => onViewChange?.(null), [onViewChange]);

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

  /* fetch: debounced, so zooming and panning ask once they pause, but at least every
     FETCH_MAX_WAIT while they go on (holding W), so detail fills in on the way. A request
     for an earlier window of the same lanes is not aborted: any response can be drawn
     (stretched to the view), only an older one never replaces a newer one. One request at
     a time; a window asked for meanwhile is fetched when it returns. */
  const reqs = useRef<{ base: string; ctrls: Set<AbortController>; skipped: boolean }>({ base: "", ctrls: new Set(), skipped: false });
  const reqSeq = useRef({ sent: 0, shown: 0 });
  const pendingSince = useRef<number | null>(null);
  const [refetch, setRefetch] = useState(0);
  useEffect(() => {
    if (!pxWidth) return;
    const base = `${baseUrl}|${key}|${pxWidth}`;
    if (reqs.current.base !== base) {
      reqs.current.ctrls.forEach((c) => c.abort());
      reqs.current = { base, ctrls: new Set(), skipped: false };
    }
    // a zoomed window is fetched with a window's width to spare on each side, at the same
    // resolution, so panning (A/D, Shift+drag) shows lanes at once instead of a blank edge
    let win = "";
    let buckets = pxWidth;
    if (view) {
      const span = view.to - view.from;
      const from = Math.max(t0, view.from - span);
      const to = Math.min(t1, view.to + span);
      buckets = Math.min(MAX_BUCKETS, Math.round((pxWidth * (to - from)) / span));
      win = `&from_ms=${Math.floor(from)}&to_ms=${Math.ceil(to)}`;
    }
    const query = `session_id=${encodeURIComponent(sessionId)}&field=${encodeURIComponent(field)}${filterParams}&buckets=${buckets}${win}`;
    const now = performance.now();
    pendingSince.current ??= now;
    const wait = view ? Math.max(0, Math.min(FETCH_DEBOUNCE, pendingSince.current + FETCH_MAX_WAIT - now)) : 0;
    const timer = setTimeout(() => {
      pendingSince.current = null;
      const r = reqs.current;
      if (r.ctrls.size) {
        r.skipped = true; // asked again when the one in flight returns
        return;
      }
      const ctrl = new AbortController();
      r.ctrls.add(ctrl);
      const id = ++reqSeq.current.sent;
      setLoading(true);
      fetch(`${baseUrl}/lanes?${query}`, { signal: ctrl.signal })
        .then(async (res) => {
          if (res.status === 409) return null; // superseded by a newer filter
          if (!res.ok) throw new Error((await res.text()) || String(res.status));
          return res.json();
        })
        .then((d: LanesData | null) => {
          if (d && id > reqSeq.current.shown) {
            reqSeq.current.shown = id;
            setFetched({ data: d, query, key });
            setError(null);
          }
        })
        .catch((e) => {
          if (e?.name !== "AbortError") setError(String(e?.message ?? e));
        })
        .finally(() => {
          r.ctrls.delete(ctrl);
          if (reqs.current !== r || r.ctrls.size) return;
          setLoading(false);
          if (r.skipped) {
            r.skipped = false;
            setRefetch((n) => n + 1);
          }
        });
    }, wait);
    return () => clearTimeout(timer);
    // t0/t1 left out on purpose: they only matter with a view, which needs them set already,
    // and their arrival with the first response must not fetch the whole file again
  }, [baseUrl, sessionId, field, filterParams, pxWidth, view, key, refetch]);
  useEffect(() => () => reqs.current.ctrls.forEach((c) => c.abort()), []);

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
        ctx.fillStyle = theme === "light" ? "rgba(42,33,27,0.035)" : "rgba(255,255,255,0.03)";
        ctx.fillRect(0, y, w, laneH);
      }
      const markH = laneH - 2 * pad;
      if (data.matched) paintLane(ctx, data.all.levels[l], null, y + pad, markH, w, df, dt, vf, vt, 0.13);
      const e = data.matched ?? data.all;
      paintLane(ctx, e.levels[l], e.density[l], y + pad, markH, w, df, dt, vf, vt, null);
      // errors and warnings that do not dominate their column: a strip on top of the mark
      paintLane(ctx, e.alerts[l], null, y + pad, Math.max(1, Math.round(markH / 3)), w, df, dt, vf, vt, 1);
    }
  }, [data, cssWidth, laneCount, hasTime, t0, t1, vf, vt, theme]);

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

  /* W/S/A/D while the pointer is over the panel (see NAV_KEYS). The window being animated
     is kept in a ref, so frames that come faster than React renders still build on each other. */
  const pointer = useRef({ x: 0, inside: false });
  const shownWin = useRef<Window>({ from: vf, to: vt });
  shownWin.current = { from: vf, to: vt };
  const navRef = useRef<(zoom: number, pan: number) => void>(() => { });
  /** zoom: factor on the span (< 1 zooms in) at the pointer; pan: fraction of the span (> 0 later) */
  navRef.current = (zoom, pan) => {
    if (!hasTime) return;
    const { from, to } = shownWin.current;
    let span = to - from;
    let f = from;
    if (zoom !== 1) {
      const r = areaRef.current?.getBoundingClientRect();
      const px = r && r.width > 0 ? (pointer.current.x - r.left) / r.width : 0.5;
      const frac = px >= 0 && px <= 1 ? px : 0.5; // over the names: the middle
      const at = f + frac * span;
      span *= zoom;
      f = at - frac * span;
    }
    f += pan * span;
    const next = clampView(f, f + span);
    if (!next && !view) return; // whole file already
    if (next && view && next.from === view.from && next.to === view.to) return;
    setView(next);
    const w = next ?? { from: t0, to: t1 > t0 ? t1 : t0 + 1 };
    shownWin.current = w;
    // the pointer line keeps its spot; the time under it moves when panning
    if (cssWidth) setHover((h) => (h ? { ...h, time: w.from + (h.x / cssWidth) * (w.to - w.from), at: pan ? null : h.at } : h));
  };
  const heldKeys = useRef(new Map<string, number>()); // code -> when pressed
  useEffect(() => {
    const held = heldKeys.current;
    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;
      let zoom = 0;
      let pan = 0;
      held.forEach((since, code) => {
        const ramp = Math.min(1, KEY_RAMP_START + ((1 - KEY_RAMP_START) * (now - since)) / KEY_RAMP_MS);
        const k = NAV_KEYS[code];
        if (k === "in") zoom -= ramp;
        else if (k === "out") zoom += ramp;
        else if (k === "left") pan -= ramp;
        else if (k === "right") pan += ramp;
      });
      if (zoom || pan) navRef.current(Math.exp(zoom * ZOOM_PER_S * dt), pan * PAN_PER_S * dt);
      raf = held.size ? requestAnimationFrame(frame) : 0;
    };
    const onDown = (e: KeyboardEvent) => {
      const k = NAV_KEYS[e.code];
      if (!k || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!pointer.current.inside || isTypingTarget(e.target) || dialogOpen()) return;
      e.preventDefault();
      if (prefersReducedMotion()) {
        navRef.current(k === "in" ? STEP_ZOOM : k === "out" ? 1 / STEP_ZOOM : 1, k === "left" ? -STEP_PAN : k === "right" ? STEP_PAN : 0);
        return;
      }
      if (held.has(e.code)) return; // auto-repeat: the animation is already running
      held.set(e.code, performance.now());
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    const onUp = (e: KeyboardEvent) => held.delete(e.code);
    const release = () => held.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
      cancelAnimationFrame(raf);
      held.clear();
    };
  }, []);
  const onPanelPointer = (e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, inside: true };
  };
  const onPanelLeave = () => {
    pointer.current.inside = false;
    heldKeys.current.clear();
  };

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
  // a plain drag selects a time range (a click jumps); Shift+drag or the middle button pans
  const onPointerDown = (e: React.PointerEvent) => {
    if (!hasTime || (e.button !== 0 && e.button !== 1)) return;
    if (e.button === 0 && !e.shiftKey) {
      range.begin(e, false);
      return;
    }
    e.preventDefault(); // no autoscroll on the middle button
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!data || !hasTime) return;
    if (range.dragging() && range.move(e) && range.draft) {
      setHover(null);
      return;
    }
    const h = range.hit(e.clientX);
    (e.currentTarget as HTMLElement).style.cursor =
      h === "from" || h === "to" ? "ew-resize" : drag.current ? "grabbing" : e.shiftKey && view ? "grab" : "crosshair";
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
    let click = false;
    if (range.dragging()) {
      if (range.end()) return;
      click = true;
    }
    const d = drag.current;
    drag.current = null;
    if (!click && (!d || d.moved)) return;
    if (!data) return;
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
  // bookmarks: their lane (by the line's field value; else "other", if there is one) and x
  const pins: { lane: number; x: number; hidden: boolean; key: number }[] = [];
  if (data && hasTime && cssWidth && marks?.length) {
    const laneOf = new Map(data.lanes.map((l, i) => [l.name, i]));
    for (const m of marks) {
      const v = m.fields[field];
      if (m.t == null || v == null) continue;
      const lane = laneOf.get(v) ?? (data.other_values > 0 ? data.lanes.length : -1);
      const x = ((m.t - vf) / (vt - vf)) * cssWidth;
      if (lane >= 0 && x >= 0 && x <= cssWidth) pins.push({ lane, x, hidden: m.hidden, key: m.line });
    }
  }
  const zoomFactor = hasTime && t1 > t0 ? (t1 - t0) / (vt - vf) : 1;
  const atLevel = hover?.at?.level != null ? CODE_LEVEL[hover.at.level] : null;

  return (
    <div
      ref={panelRef}
      className="relative shrink-0 select-none border-b border-log-ink/10 bg-log-panel text-log-fg"
      onPointerEnter={onPanelPointer}
      onPointerMove={onPanelPointer}
      onPointerLeave={onPanelLeave}
    >
      {/* header: name column and time scale */}
      <div className="flex border-b border-log-ink/5" style={{ height: AXIS_H }}>
        <div className="flex shrink-0 items-center gap-0.5 border-r border-log-ink/5 pl-2 pr-1 text-[10px] text-log-fg/60" style={{ width: LABEL_W }}>
          <span className="mr-auto truncate" title={data ? `${fieldLabel} lanes: the ${data.max_lanes} busiest get a lane each` : undefined}>
            {fieldLabel}s{data ? ` · ${(data.lanes.length + data.other_values).toLocaleString()}` : ""}
          </span>
          <button type="button" title="Zoom in (W or Ctrl+wheel, at the pointer)" aria-label="Zoom in" disabled={!hasTime || vt - vf <= MIN_SPAN} onClick={() => zoomAt(0.5, 0.5)} className="rounded p-0.5 hover:bg-log-ink/10 disabled:opacity-30">
            <ZoomIn className="size-3" />
          </button>
          <button type="button" title="Zoom out (S or Ctrl+wheel)" aria-label="Zoom out" disabled={!view} onClick={() => zoomAt(0.5, 2)} className="rounded p-0.5 hover:bg-log-ink/10 disabled:opacity-30">
            <ZoomOut className="size-3" />
          </button>
          <button type="button" title="Whole file" aria-label="Show the whole file" disabled={!view} onClick={() => setView(null)} className="rounded p-0.5 hover:bg-log-ink/10 disabled:opacity-30">
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
              className="rounded p-0.5 hover:bg-log-ink/10"
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
          title={hasTime ? `Drag to filter a time range · W/S zoom, A/D pan${view || timeRange ? " · double-click: whole file, no time range" : ""}` : undefined}
        >
          {ticks.map(({ t, label }) => {
            const x = ((t - vf) / (vt - vf)) * cssWidth;
            if (x > cssWidth - (label.length * 6 + 8)) return null;
            return (
              <div key={t} className="absolute top-0 h-full" style={{ left: x }}>
                <div className="absolute bottom-0 h-1 w-px bg-log-ink/30" />
                <div className="absolute left-1 top-0 whitespace-nowrap font-mono text-[10px] leading-[16px] text-log-fg/55">{label}</div>
              </div>
            );
          })}
          {view && (
            <div className="absolute right-1 top-0 rounded bg-log-panel/80 px-1 font-mono text-[10px] leading-[16px] text-log-fg/60">
              {zoomFactor >= 10 ? Math.round(zoomFactor).toLocaleString() : zoomFactor.toFixed(1)}×
            </div>
          )}
          {shownRange && <RangeShade range={shownRange} vf={vf} vt={vt} width={cssWidth} grips label draft={!!range.draft} />}
        </div>
        {/* above the lanes' scrollbar, so the scale ends where the lanes do */}
        <div className="shrink-0" style={{ width: END_W }} />
      </div>

      {/* lanes: names and marks scroll together */}
      <div className="lanes-scroll overflow-y-auto overflow-x-hidden" style={{ maxHeight: height }}>
        <div className="flex" style={{ height: Math.max(laneCount * LANE_H, 2 * LANE_H) }}>
          <div className="shrink-0 border-r border-log-ink/5" style={{ width: LABEL_W }}>
            {names.map((n, i) => (
              <div
                key={n}
                title={laneTitle(i)}
                className={`truncate px-2 font-mono text-[10px] ${hover?.lane === i ? "bg-log-ink/10 text-log-fg" : i >= (data?.lanes.length ?? 0) ? "italic text-log-fg/45" : "text-log-fg/70"}`}
                style={{ height: LANE_H, lineHeight: `${LANE_H}px` }}
              >
                {n}
              </div>
            ))}
          </div>
          <div
            ref={areaRef}
            className="relative min-w-0 flex-1 touch-none cursor-crosshair"
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
                className="pointer-events-none absolute inset-y-0 z-[6] rounded-[2px] border border-log-ink/80 bg-log-ink/10 shadow-[0_0_0_1px_color-mix(in_srgb,var(--range-outside)_60%,transparent)]"
                style={{ left: box.left, width: box.width }}
              />
            )}
            {pins.map((p) => (
              <div
                key={p.key}
                className={`pointer-events-none absolute z-[7] w-[3px] -translate-x-1/2 rounded-[1px] ${p.hidden ? "bookmark-tick-hidden" : "bookmark-tick"}`}
                style={{ left: p.x, top: p.lane * LANE_H + 1, height: LANE_H - 2 }}
                aria-hidden
              />
            ))}
            {hover && (
              <>
                <div className="pointer-events-none absolute inset-y-0 w-px bg-log-ink/60" style={{ left: hover.x }} />
                <div className="pointer-events-none absolute inset-x-0 bg-log-ink/[0.06]" style={{ top: hover.lane * LANE_H, height: LANE_H }} />
              </>
            )}
            {!data && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center overflow-hidden px-3 text-[11px] text-log-fg/50" style={{ height: LANE_H * 2 }}>
                {/* first load: the same sweep as the minimap while the file is indexed */}
                {!error && !fetched && (loading || !pxWidth) && <IndexingSweep />}
                <span className="relative">{error ? `Thread lanes unavailable: ${error}` : loading || !pxWidth ? "Building thread lanes…" : ""}</span>
              </div>
            )}
            {data && (!hasTime || laneCount === 0) && (
              <div className="pointer-events-none px-3 text-[11px] leading-[28px] text-log-fg/50">
                {!hasTime ? "No timestamps found in this file" : `No ${fieldLabel.toLowerCase()} values in this file`}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* resize handle */}
      {laneCount * LANE_H > 2 * LANE_H && (
        <div
          className="h-1 cursor-row-resize bg-log-ink/5 hover:bg-log-ink/20"
          onPointerDown={onResizeDown}
          title="Drag to resize"
          aria-label="Resize thread lanes"
          role="separator"
        />
      )}

      {/* hover readout, above the lanes so the scroll area does not clip it */}
      {hover && data && (
        <div
          className="pointer-events-none absolute z-20 max-w-[min(640px,70%)] rounded bg-log-tip/90 px-1.5 py-1 font-mono text-[10px] text-white shadow"
          style={{
            top: Math.max(0, hover.y + 12),
            ...(hover.x > cssWidth / 2 ? { right: cssWidth - hover.x + END_W + 8 } : { left: LABEL_W + hover.x + 8 }),
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
                  <span className="ml-1.5 font-semibold" style={{ color: codeColors()[hover.at.level!] ?? undefined }}>
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
