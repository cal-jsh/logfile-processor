/*
 * Forgiving time input for "go to time" and typed time ranges.
 *
 * Times are ms since 1970 in the log's own clock (no time zone), like the backend's.
 * Accepted, with `T` or a space between date and time, `.` or `,` before the fraction:
 *
 *   2026-11-18 14:05:30.250   a full timestamp
 *   2026-11-18                midnight of that day
 *   11-18 14:05               month-day and time, as the time scales label it; the year
 *                             is the file's (the next one if that is before the file)
 *   14:05, 14:05:30, 9:05     a time of day: on the day of `ref` (the rows on screen),
 *                             or the next day if that is before the file starts
 *
 * A range is two of these joined by " - ", "–", "—", " to " or "..". An end without a
 * date takes the start's day (the next day if it would be before the start); an end
 * that is only a date includes that whole day.
 */

export type TimeContext = {
  /** The file's first and last timestamp */
  start: number;
  end: number;
  /** A time on the day meant by a bare time of day (the top row's time) */
  ref?: number | null;
};

const DAY = 86_400_000;

type Parts = { y?: number; mo?: number; d?: number; h?: number; mi?: number; s?: number; ms?: number };

const RE =
  /^(?:(?:(\d{4})-)?(\d{1,2})-(\d{1,2}))?(?:(?:^|[ T]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?Z?$/i;

function parts(s: string): Parts | null {
  const m = RE.exec(s.trim());
  if (!m || (m[2] == null && m[4] == null)) return null;
  const n = (x: string | undefined) => (x == null ? undefined : Number(x));
  const p: Parts = { y: n(m[1]), mo: n(m[2]), d: n(m[3]), h: n(m[4]), mi: n(m[5]), s: n(m[6]) };
  if (m[7]) p.ms = Number(`0.${m[7]}`) * 1000;
  if (p.mo != null && (p.mo < 1 || p.mo > 12 || p.d! < 1 || p.d! > 31)) return null;
  if (p.h != null && (p.h > 23 || p.mi! > 59 || (p.s ?? 0) > 60)) return null;
  return p;
}

const timeOfDay = (p: Parts) => (((p.h ?? 0) * 60 + (p.mi ?? 0)) * 60 + (p.s ?? 0)) * 1000 + (p.ms ?? 0);
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;

/** One time; `base`: the day for a bare time of day (else from the context) */
function resolve(p: Parts, ctx: TimeContext, base?: number): number {
  const tod = timeOfDay(p);
  if (p.mo != null) {
    if (p.y != null) return Date.UTC(p.y, p.mo - 1, p.d!) + tod;
    const y = new Date(ctx.start).getUTCFullYear();
    const t = Date.UTC(y, p.mo - 1, p.d!) + tod;
    // a file over New Year: a date before the start means next year
    return t < dayStart(ctx.start) ? Date.UTC(y + 1, p.mo - 1, p.d!) + tod : t;
  }
  const day = dayStart(base ?? ctx.ref ?? ctx.start);
  let t = day + tod;
  if (t < ctx.start && t + DAY <= ctx.end) t += DAY;
  return t;
}

export type ParsedTime = { kind: "time"; t: number } | { kind: "range"; from: number; to: number } | { kind: "error"; message: string };

const RANGE_SPLIT = /\s+(?:-|–|—|to)\s+|\s*(?:–|—|\.\.)\s*/i;

/** Parse a time or a time range typed by the user */
export function parseTimeInput(input: string, ctx: TimeContext): ParsedTime | null {
  const s = input.trim();
  if (!s) return null;
  const halves = s.split(RANGE_SPLIT);
  if (halves.length === 2 && halves[0] && halves[1]) {
    const a = parts(halves[0]);
    const b = parts(halves[1]);
    if (!a || !b) return { kind: "error", message: "Not a time range, e.g. 14:00 - 14:30" };
    const from = resolve(a, ctx);
    let to: number;
    if (b.mo == null) {
      to = resolve(b, ctx, from);
      if (to <= from) to += DAY;
    } else {
      to = resolve(b, ctx);
      if (b.h == null) to += DAY; // a date as the end: all of that day
    }
    if (to <= from) return { kind: "error", message: "The end is before the start" };
    return { kind: "range", from, to };
  }
  const p = parts(s);
  if (!p) return { kind: "error", message: "Not a time, e.g. 14:05, 11-18 14:05 or 2026-11-18 14:05:30" };
  return { kind: "time", t: resolve(p, ctx) };
}

/** Input that is a line number rather than a time: digits, maybe with group separators */
export const isLineNumber = (s: string) => /^\s*\d[\d,'_ ]*\s*$/.test(s);
