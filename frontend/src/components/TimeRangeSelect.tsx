import { useRef, useState } from "react";

/*
 * Selecting a time range by dragging, shared by the minimap and the thread lanes.
 *
 * Gestures (the same on both): drag on the time scale, or Shift+drag on the bar or the
 * lanes, to select a range; drag a range's edge to move that edge; drag inside the range
 * on the time scale to move it. Plain drags keep their old meaning (the minimap jumps,
 * zoomed lanes pan). Releasing applies the range as a filter; a click does not.
 *
 * Times are ms since 1970 in the log's own clock (no time zone), as everywhere else.
 */

/** A time range filter: `from` included, `to` excluded */
export type TimeRange = { from: number; to: number };

/** Colour of the range edges and label: the logo's paper tone, apart from every level
    and group colour, and from the white box that marks the rows on screen */
export const RANGE_COLOR = "#f3eadb";

/** css px around an edge that grab it */
const EDGE_GRAB = 5;
/** css px a press must move to become a drag */
const DRAG_MIN = 3;

type Mode = "new" | "from" | "to" | "move";

type Drag = { mode: Mode; x: number; anchor: number; orig: TimeRange | null; moved: boolean };

/** What a press at a position would do */
export type RangeHit = "from" | "to" | "inside" | null;

export function useTimeRangeDrag({
  range,
  onChange,
  timeAt,
  xOf,
  bounds,
}: {
  range: TimeRange | null;
  onChange: (r: TimeRange | null) => void;
  /** The time at a client x (css px) */
  timeAt: (clientX: number) => number;
  /** The client x (css px) of a time */
  xOf: (t: number) => number;
  /** Times a range is kept inside (the file's span) */
  bounds: [number, number];
}) {
  const [draft, setDraftState] = useState<TimeRange | null>(null);
  // the latest draft, for the release (state may lag a render behind)
  const draftRef = useRef<TimeRange | null>(null);
  const setDraft = (r: TimeRange | null) => {
    draftRef.current = r;
    setDraftState(r);
  };
  const drag = useRef<Drag | null>(null);

  const hit = (clientX: number): RangeHit => {
    if (!range) return null;
    const a = xOf(range.from);
    const b = xOf(range.to);
    // the nearer edge wins when the range is only a few pixels wide
    const da = Math.abs(clientX - a);
    const db = Math.abs(clientX - b);
    if (Math.min(da, db) <= EDGE_GRAB) return da <= db ? "from" : "to";
    return clientX > a && clientX < b ? "inside" : null;
  };

  const clampT = (t: number) => Math.min(Math.max(t, bounds[0]), bounds[1]);

  /** Start a drag; `allowMove`: a press inside the range moves it (else starts a new one) */
  const begin = (e: React.PointerEvent, allowMove: boolean) => {
    const h = hit(e.clientX);
    const mode: Mode = h === "from" || h === "to" ? h : h === "inside" && allowMove ? "move" : "new";
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, anchor: clampT(timeAt(e.clientX)), orig: range, moved: false };
  };

  /** Follow the pointer; false when no range drag is running */
  const move = (e: React.PointerEvent): boolean => {
    const d = drag.current;
    if (!d) return false;
    if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_MIN) return true;
    d.moved = true;
    const t = clampT(timeAt(e.clientX));
    let r: TimeRange;
    if (d.mode === "new" || !d.orig) {
      r = { from: Math.min(d.anchor, t), to: Math.max(d.anchor, t) };
    } else if (d.mode === "move") {
      const span = d.orig.to - d.orig.from;
      const from = Math.min(Math.max(d.orig.from + (t - d.anchor), bounds[0]), bounds[1] - span);
      r = { from, to: from + span };
    } else {
      // dragging one edge over the other swaps them
      const other = d.mode === "from" ? d.orig.to : d.orig.from;
      r = { from: Math.min(other, t), to: Math.max(other, t) };
    }
    setDraft(r);
    return true;
  };

  /** Finish; returns whether this was a range drag that moved (else: a click) */
  const end = (): boolean => {
    const d = drag.current;
    drag.current = null;
    if (!d) return false;
    const r = draftRef.current;
    setDraft(null);
    if (!d.moved || !r) return false;
    // whole ms, `to` excluded: a range ending on a line's time still shows that line
    const from = Math.floor(r.from);
    const to = Math.max(from + 1, Math.ceil(r.to) + (r.to >= bounds[1] ? 1 : 0));
    onChange({ from, to });
    return true;
  };

  const cancel = () => {
    drag.current = null;
    setDraft(null);
  };

  return { draft, hit, begin, move, end, cancel, dragging: () => drag.current != null };
}

/** Cursor for a position over a range-selecting surface */
export function rangeCursor(h: RangeHit, onScale: boolean): string | undefined {
  if (h === "from" || h === "to") return "ew-resize";
  if (h === "inside" && onScale) return "grab";
  return onScale ? "crosshair" : undefined;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A time for range labels: date only when it differs from `ref`, ms only when not 0 */
export function formatRangeTime(t: number, ref?: number): string {
  const d = new Date(t);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const sameDay = ref != null && Math.floor(ref / 86_400_000) === Math.floor(t / 86_400_000);
  let time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (d.getUTCMilliseconds()) time += `.${pad(d.getUTCMilliseconds(), 3)}`;
  return sameDay ? time : `${day} ${time}`;
}

/** Duration in the largest two units: "3 d 4 h", "1 h 27 m", "12.5 s", "340 ms" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const units: [number, string][] = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"], [1000, "s"]];
  const parts: string[] = [];
  let rest = Math.round(ms / 1000) * 1000;
  for (const [u, name] of units) {
    if (rest >= u || parts.length) {
      const n = Math.floor(rest / u);
      rest -= n * u;
      if (n || parts.length) parts.push(`${n} ${name}`);
      if (parts.length === 2) break;
    }
  }
  return parts.join(" ");
}

/** "from – to · duration" */
export function formatRange(r: TimeRange): string {
  return `${formatRangeTime(r.from)} – ${formatRangeTime(r.to, r.from)} · ${formatDuration(r.to - r.from)}`;
}

/**
 * The range drawn over a surface of `width` css px showing times `vf..vt`: the outside
 * dimmed, the edges as bright lines. `grips` draws tabs on the edges (the time scale);
 * `label` writes the range into it.
 */
export function RangeShade({
  range,
  vf,
  vt,
  width,
  grips = false,
  label = false,
  draft = false,
  dim = 0.45,
}: {
  range: TimeRange;
  vf: number;
  vt: number;
  width: number;
  grips?: boolean;
  label?: boolean;
  /** Still being dragged (drawn a little lighter) */
  draft?: boolean;
  /** How dark the outside gets (0..1); light where the outside is drawn dim already */
  dim?: number;
}) {
  if (!(vt > vf) || width <= 0) return null;
  const x = (t: number) => ((t - vf) / (vt - vf)) * width;
  const a = Math.min(Math.max(x(range.from), -2), width + 2);
  const b = Math.min(Math.max(x(range.to), -2), width + 2);
  const w = Math.max(1, b - a);
  const text = formatRange(range);
  // the label sits inside the range when it fits, else next to it on the roomier side
  const inside = w > text.length * 6 + 16;
  const labelStyle: React.CSSProperties = inside
    ? { left: a + w / 2, transform: "translateX(-50%)" }
    : a > width - b
      ? { right: width - a + 6 }
      : { left: b + 6 };
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      <div className="absolute inset-y-0 left-0" style={{ width: Math.max(0, a), background: `rgba(0,0,0,${dim})` }} />
      <div className="absolute inset-y-0 right-0" style={{ left: Math.min(width, b), background: `rgba(0,0,0,${dim})` }} />
      <div
        className="absolute inset-y-0"
        style={{
          left: a,
          width: w,
          borderLeft: `2px solid ${RANGE_COLOR}`,
          borderRight: `2px solid ${RANGE_COLOR}`,
          background: grips ? `color-mix(in oklab, ${RANGE_COLOR} ${draft ? 18 : 12}%, transparent)` : undefined,
          opacity: draft ? 0.85 : 1,
        }}
      />
      {grips && (
        <>
          <div className="absolute top-1/2 h-2.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px]" style={{ left: a + 1, background: RANGE_COLOR }} />
          <div className="absolute top-1/2 h-2.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px]" style={{ left: b - 1, background: RANGE_COLOR }} />
        </>
      )}
      {label && (
        <div
          className="absolute top-0 whitespace-nowrap rounded-sm bg-[#1b1b1c]/90 px-1 font-mono text-[10px] leading-[14px]"
          style={{ ...labelStyle, color: RANGE_COLOR }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
