/* Word highlights: words (or selected text) the user picked with a right-click in the log,
   each marked in its own colour wherever it shows in the rows and search results.
   Kept in localStorage for every file and window (another window's change arrives via the
   "storage" event). The text is matched on the frontend, in the rows already loaded, and
   drawn by the same <mark> path as the filter's and the search's matches (LogViewer
   `marked`). */
import { useSyncExternalStore } from "react";

/** The highlight colours, in the order they are handed out. Hues no log level, the
    selected-line yellow, the search orange or the bookmark vermilion use. */
export const HIGHLIGHT_COLORS = [
  { name: "Cyan", color: "#22c3dd" },
  { name: "Pink", color: "#ec5fa8" },
  { name: "Lime", color: "#9ccc2c" },
  { name: "Violet", color: "#9a7cf0" },
  { name: "Blue", color: "#4a8ff0" },
  { name: "Sand", color: "#c9a77a" },
] as const;

export type Highlight = {
  text: string;
  /** index into HIGHLIGHT_COLORS */
  color: number;
};

export type HighlightState = {
  words: Highlight[];
  /** "Error" does not match "error" */
  matchCase: boolean;
  /** "id" does not match inside "pid"; text that is not a word (selected) always matches anywhere */
  wholeWord: boolean;
};

const KEY = "logviewer.highlights";
const MAX = 50;
const listeners = new Set<() => void>();

function read(): HighlightState {
  const empty: HighlightState = { words: [], matchCase: true, wholeWord: true };
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!v || !Array.isArray(v.words)) return empty;
    return {
      words: v.words
        .filter((w: Highlight) => typeof w?.text === "string" && w.text && Number.isInteger(w.color))
        .map((w: Highlight) => ({ text: w.text, color: ((w.color % HIGHLIGHT_COLORS.length) + HIGHLIGHT_COLORS.length) % HIGHLIGHT_COLORS.length }))
        .slice(0, MAX),
      matchCase: v.matchCase !== false,
      wholeWord: v.wholeWord !== false,
    };
  } catch {
    return empty;
  }
}

let state = read();

function set(next: HighlightState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* kept for this window only */
  }
  listeners.forEach((l) => l());
}

window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  state = read();
  listeners.forEach((l) => l());
});

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useHighlights(): HighlightState {
  return useSyncExternalStore(subscribe, () => state);
}

const same = (a: string, b: string) => (state.matchCase ? a === b : a.toLowerCase() === b.toLowerCase());

/** The highlight of `text`, if it has one */
export function highlightOf(text: string): Highlight | undefined {
  return state.words.find((w) => same(w.text, text));
}

/** The colour the next new word gets: the first one not in use, else round robin */
export function nextColor(): number {
  const used = new Set(state.words.map((w) => w.color));
  for (let i = 0; i < HIGHLIGHT_COLORS.length; i++) if (!used.has(i)) return i;
  return state.words.length % HIGHLIGHT_COLORS.length;
}

/** Highlights `text` in `color` (a word already highlighted changes colour) */
export function setHighlight(text: string, color: number) {
  if (!text) return;
  const words = state.words.filter((w) => !same(w.text, text));
  set({ ...state, words: [...words, { text, color }].slice(-MAX) });
}

export function removeHighlight(text: string) {
  set({ ...state, words: state.words.filter((w) => !same(w.text, text)) });
}

export function clearHighlights() {
  set({ ...state, words: [] });
}

export function setHighlightOptions(o: Partial<Pick<HighlightState, "matchCase" | "wholeWord">>) {
  set({ ...state, ...o });
}

/* ---------------- Matching ---------------- */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
export const isWordChar = (c: string | undefined) => !!c && WORD_CHAR.test(c);

/** Matches a text against the highlights; built once per state */
export type Matcher = (text: string) => { start: number; end: number; color: number }[];

const cache = new WeakMap<HighlightState, Matcher | null>();

/** Finds the highlighted words in a text, or null when there are none to find */
export function matcherFor(s: HighlightState): Matcher | null {
  if (cache.has(s)) return cache.get(s)!;
  let m: Matcher | null = null;
  if (s.words.length) {
    const words = s.words.map((w) => ({
      needle: s.matchCase ? w.text : w.text.toLowerCase(),
      color: w.color,
      // only text that starts and ends like a word needs word edges around it
      edgeStart: s.wholeWord && isWordChar(w.text[0]),
      edgeEnd: s.wholeWord && isWordChar(w.text[w.text.length - 1]),
    }));
    m = (text) => {
      const hay = s.matchCase ? text : text.toLowerCase();
      const out: { start: number; end: number; color: number }[] = [];
      for (const w of words) {
        for (let at = hay.indexOf(w.needle); at >= 0; at = hay.indexOf(w.needle, at + 1)) {
          const end = at + w.needle.length;
          if (w.edgeStart && isWordChar(text[at - 1])) continue;
          if (w.edgeEnd && isWordChar(text[end])) continue;
          out.push({ start: at, end, color: w.color });
        }
      }
      return out;
    };
  }
  cache.set(s, m);
  return m;
}
