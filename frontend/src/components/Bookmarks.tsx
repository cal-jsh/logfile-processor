import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, Trash2, Undo2, Upload, X } from "lucide-react";
import type { FieldDef } from "../lib/logSummary";
import { levelColor } from "../lib/colorMap";
import { formatFull } from "./Minimap";
import {
  byLine,
  exportFileName,
  fileStamp,
  formatExport,
  loadFileBookmarks,
  newId,
  openTextFile,
  parseExport,
  sameLine,
  sameStamp,
  saveFileBookmarks,
  saveTextFile,
  TEXT_KEEP,
  type Bookmark,
  type FileStamp,
} from "../lib/bookmarks";
import { splitPath } from "../lib/recentFiles";

/*
 * Bookmarks of the open file: the store (useBookmarks), the mark drawn in the gutter, on
 * the minimap and in the thread lanes (BookmarkGlyph, .bookmark-* in index.css), and the
 * list in the Bookmarks panel (BookmarksList).
 *
 * Ctrl+B or a click in the gutter marks the current line, F2 / Shift+F2 go to the next /
 * previous one (LogViewer). Bookmarks stay on their file lines whatever the filter: the
 * viewer asks the backend which rows show them (/view/lines_at), F2 skips the hidden ones
 * and the panel lists them greyed.
 */

/** A file line, as the viewer has it, to bookmark */
export type LineData = { line: number; text: string; fields: string[] | null; t: number | null };

/** Where a bookmark is in the current view (from /view/lines_at) */
export type BookmarkPlace = { row: number | null; nextRow: number };

/** A line as /view/lines_at returns it */
export type LineAt = {
  line_number: number;
  text: string;
  fields: string[] | null;
  t: number | null;
  truncated: boolean;
  row: number | null;
  next_row: number;
};

const LINES_PER_REQUEST = 2000;

/** File lines with their place in the view of `viewParams` (session, filter, context) */
export async function fetchLinesAt(baseUrl: string, viewParams: string, lines: number[], signal?: AbortSignal): Promise<LineAt[]> {
  const out: LineAt[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_REQUEST) {
    const part = lines.slice(i, i + LINES_PER_REQUEST).join(",");
    const r = await fetch(`${baseUrl}/view/lines_at?${viewParams}&lines=${part}`, { signal });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    out.push(...(await r.json()).lines);
  }
  return out;
}

/** What a bookmark keeps of its line */
function lineDetails(d: LineData, columns: FieldDef[]): Pick<Bookmark, "t" | "level" | "fields" | "text"> {
  const fields: Record<string, string> = {};
  let level: string | null = null;
  if (d.fields) {
    columns.forEach((c, i) => {
      const v = d.fields![i];
      if (v == null) return;
      if (c.kind === "level") level = v;
      else if (c.kind === "text") fields[c.name] = v;
    });
  }
  return { t: d.t, level, fields, text: d.text.slice(0, TEXT_KEEP) };
}

export interface BookmarksApi {
  /** In file order */
  list: Bookmark[];
  byLine: Map<number, Bookmark>;
  /** The file is being checked against its bookmarks (it changed since they were saved) */
  checking: boolean;
  /** Mark a line, or unmark it if it is marked */
  toggle: (d: LineData) => void;
  setNote: (id: string, note: string) => void;
  remove: (id: string) => void;
  clearAll: () => void;
  /** Drop the bookmarks whose line changed */
  forgetStale: () => void;
  exportToFile: () => Promise<void>;
  importFromFile: () => Promise<void>;
  /** The last thing that happened, for the panel and the status bar */
  notice: { text: string; undo?: () => void; warn?: boolean } | null;
  dismissNotice: () => void;
}

/** The bookmarks of the file at `path`, kept in localStorage (lib/bookmarks.ts) */
export function useBookmarks({
  path,
  baseUrl,
  sessionId,
  columns,
}: {
  path: string | undefined;
  baseUrl: string;
  sessionId: string;
  columns: FieldDef[];
}): BookmarksApi {
  const [list, setList] = useState<Bookmark[]>(() => (path ? loadFileBookmarks(path)?.bookmarks.sort(byLine) ?? [] : []));
  const listRef = useRef(list);
  const stampRef = useRef<FileStamp | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<BookmarksApi["notice"]>(null);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const plain = `session_id=${encodeURIComponent(sessionId)}`;

  /** Set and store the list (the only way it changes) */
  const commit = useCallback(
    (next: Bookmark[]) => {
      next = [...next].sort(byLine);
      listRef.current = next;
      setList(next);
      if (path) saveFileBookmarks(path, stampRef.current, next);
    },
    [path]
  );

  /* On open: the file's stamp now. If it changed since the bookmarks were saved, check each
     bookmark against its line: a log that grew keeps them all, one rewritten flags those
     whose line is different now. */
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    (async () => {
      const stamp = await fileStamp(path).catch(() => null);
      if (ctrl.signal.aborted) return;
      stampRef.current = stamp;
      const stored = loadFileBookmarks(path);
      if (!stored?.bookmarks.length || !stamp || sameStamp(stored, stamp)) return;
      setChecking(true);
      try {
        const now = await fetchLinesAt(baseUrl, plain, stored.bookmarks.map((b) => b.line), ctrl.signal);
        const at = new Map(now.map((l) => [l.line_number, l]));
        let flagged = 0;
        const checked = listRef.current.map((b) => {
          const l = at.get(b.line);
          const stale = !l || !sameLine(b.text, l.text);
          if (stale) flagged++;
          return stale === !!b.stale ? b : { ...b, stale: stale || undefined };
        });
        commit(checked);
        if (flagged)
          setNotice({
            warn: true,
            text:
              `The file changed since these bookmarks were set: ${flagged.toLocaleString()} of ${checked.length.toLocaleString()} ` +
              `no longer match their line and are flagged.`,
          });
      } catch (e: any) {
        if (e?.name !== "AbortError") console.error("Checking bookmarks:", e);
      } finally {
        if (!ctrl.signal.aborted) setChecking(false);
      }
    })();
    return () => ctrl.abort();
    // once per file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, sessionId]);

  const removeWithUndo = (gone: Bookmark[], text: string) => {
    const before = listRef.current;
    commit(before.filter((b) => !gone.includes(b)));
    // a bookmark with a note is work: removing one can be undone
    const undo = gone.some((b) => b.note) || gone.length > 1 ? () => {
      const ids = new Set(listRef.current.map((b) => b.id));
      commit([...listRef.current, ...gone.filter((b) => !ids.has(b.id))]);
      setNotice(null);
    } : undefined;
    setNotice({ text, undo });
  };

  const toggle = (d: LineData) => {
    const old = listRef.current.find((b) => b.line === d.line);
    if (old) {
      removeWithUndo([old], `Bookmark on line ${d.line.toLocaleString()} removed`);
      return;
    }
    const now = Date.now();
    commit([...listRef.current, { id: newId(), line: d.line, note: "", created: now, updated: now, ...lineDetails(d, columnsRef.current) }]);
    setNotice(null);
  };

  const setNote = (id: string, note: string) => {
    const clean = note.replace(/\s*[\r\n]+\s*/g, " ").slice(0, 500);
    commit(listRef.current.map((b) => (b.id === id && b.note !== clean ? { ...b, note: clean, updated: Date.now() } : b)));
  };

  const remove = (id: string) => {
    const b = listRef.current.find((x) => x.id === id);
    if (b) removeWithUndo([b], `Bookmark on line ${b.line.toLocaleString()} removed`);
  };

  const clearAll = () => {
    const all = listRef.current;
    if (all.length) removeWithUndo(all, `${all.length.toLocaleString()} bookmarks removed`);
  };

  const forgetStale = () => {
    const stale = listRef.current.filter((b) => b.stale);
    if (stale.length) removeWithUndo(stale, `${stale.length.toLocaleString()} changed bookmarks removed`);
  };

  const exportToFile = async () => {
    if (!path || !listRef.current.length) return;
    const { dir, name } = exportFileName(path);
    try {
      const contents = formatExport(splitPath(path).name, stampRef.current, listRef.current);
      const saved = await saveTextFile("Export bookmarks", dir, name, contents);
      if (saved) setNotice({ text: `${listRef.current.length.toLocaleString()} bookmarks saved to ${saved}` });
    } catch (e) {
      setNotice({ warn: true, text: `Export failed: ${e}` });
    }
  };

  const importFromFile = async () => {
    if (!path) return;
    try {
      const picked = await openTextFile("Import bookmarks", exportFileName(path).dir);
      if (!picked) return;
      const parsed = parseExport(picked.contents);
      const lines = [...new Set(parsed.bookmarks.map((b) => b.line))];
      const now = await fetchLinesAt(baseUrl, plain, lines);
      const at = new Map(now.map((l) => [l.line_number, l]));
      const existing = new Map(listRef.current.map((b) => [b.line, b]));
      const added: Bookmark[] = [];
      // notes for lines already marked that had none
      const notes = new Map<number, string>();
      let merged = 0;
      let mismatched = 0;
      const t = Date.now();
      for (const imp of parsed.bookmarks) {
        const old = existing.get(imp.line);
        if (old) {
          // already marked: keep it, take the note if it had none
          if (imp.note && !old.note && !notes.has(imp.line)) notes.set(imp.line, imp.note);
          merged++;
          continue;
        }
        const twice = added.find((b) => b.line === imp.line);
        if (twice) {
          if (imp.note && !twice.note) twice.note = imp.note;
          continue;
        }
        const l = at.get(imp.line);
        const stale = !l || (imp.text != null && !sameLine(imp.text.slice(0, TEXT_KEEP), l.text));
        if (stale) mismatched++;
        const details = l && !stale
          ? lineDetails({ line: imp.line, text: l.text, fields: l.fields, t: l.t }, columnsRef.current)
          : { t: null, level: null, fields: {}, text: (imp.text ?? "").slice(0, TEXT_KEEP) };
        added.push({ id: newId(), line: imp.line, note: imp.note, created: t, updated: t, ...details, stale: stale || undefined });
      }
      commit([
        ...listRef.current.map((b) => (notes.has(b.line) ? { ...b, note: notes.get(b.line)!, updated: t } : b)),
        ...added,
      ]);
      const from = splitPath(picked.path).name;
      const parts = [`Imported ${added.length.toLocaleString()} bookmark${added.length === 1 ? "" : "s"} from ${from}`];
      if (merged) parts.push(`${merged.toLocaleString()} already there`);
      if (mismatched) parts.push(`${mismatched.toLocaleString()} do not match this file's line and are flagged`);
      if (parsed.skipped.length) parts.push(`${parsed.skipped.length.toLocaleString()} unreadable line${parsed.skipped.length === 1 ? "" : "s"} skipped`);
      const other = parsed.fileName && parsed.fileName.toLowerCase() !== splitPath(path).name.toLowerCase() ? ` (exported from ${parsed.fileName})` : "";
      setNotice({ text: parts.join(", ") + other, warn: mismatched > 0 });
    } catch (e: any) {
      setNotice({ warn: true, text: `Import failed: ${e?.message ?? e}` });
    }
  };

  const byLineMap = useMemo(() => new Map(list.map((b) => [b.line, b])), [list]);
  return {
    list,
    byLine: byLineMap,
    checking,
    toggle,
    setNote,
    remove,
    clearAll,
    forgetStale,
    exportToFile,
    importFromFile,
    notice,
    dismissNotice: () => setNotice(null),
  };
}

/** The bookmark mark: a ribbon with a notch. Hollow for a bookmark whose line changed. */
export function BookmarkGlyph({ stale, className, title }: { stale?: boolean; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 8 11" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path
        d="M0.75 0.75h6.5v9.5L4 7.6 0.75 10.25z"
        fill={stale ? "none" : "var(--bookmark)"}
        stroke="var(--bookmark)"
        strokeWidth={stale ? 1.3 : 0.6}
        strokeLinejoin="round"
        strokeDasharray={stale ? "2 1.2" : undefined}
      />
    </svg>
  );
}

/** The panel's list: each bookmark with its time, level, thread and the start of its line,
    and its note (click to edit). Hidden ones (filtered out) are greyed; a click still goes
    to where they would be. */
export function BookmarksList({
  api,
  places,
  lanesField,
  current,
  onJump,
}: {
  api: BookmarksApi;
  /** By line; missing while the view is loading */
  places: Map<number, BookmarkPlace>;
  /** Field shown next to the level (the lanes' field, usually thread) */
  lanesField: string | null;
  /** Line of the bookmark gone to last */
  current: number | null;
  onJump: (b: Bookmark) => void;
}) {
  const { list, notice } = api;
  const [editing, setEditing] = useState<string | null>(null);
  const hidden = list.filter((b) => places.get(b.line)?.row === null).length;
  const stale = list.filter((b) => b.stale).length;
  const currentRef = useRef<HTMLDivElement>(null);
  // (braces: scrollIntoView returns a promise in newer WebView2, which React would take for a cleanup)
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="mr-auto pl-1 text-xs text-muted-foreground">
          {list.length ? `${list.length.toLocaleString()} bookmark${list.length === 1 ? "" : "s"}` : "No bookmarks"}
          {hidden > 0 && ` · ${hidden.toLocaleString()} hidden by the filter`}
          {api.checking && " · checking…"}
        </span>
        <PanelButton onClick={api.importFromFile} title="Add bookmarks from an exported file" icon={<Upload className="size-3.5" />}>
          Import
        </PanelButton>
        <PanelButton
          onClick={api.exportToFile}
          disabled={!list.length}
          title="Save the bookmarks as a small text file, to share or keep"
          icon={<Download className="size-3.5" />}
        >
          Export
        </PanelButton>
        <PanelButton onClick={api.clearAll} disabled={!list.length} title="Remove all bookmarks of this file (can be undone)" icon={<Trash2 className="size-3.5" />} />
      </div>

      {notice && (
        <div className={`flex items-start gap-2 border-b px-3 py-1.5 text-[11px] ${notice.warn ? "bg-amber-500/10 text-amber-800 dark:text-amber-300" : "text-muted-foreground"}`} role="status">
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          {notice.undo && (
            <button type="button" onClick={notice.undo} className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground hover:underline">
              <Undo2 className="size-3" /> Undo
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={api.dismissNotice} className="shrink-0 rounded p-0.5 hover:bg-accent">
            <X className="size-3" />
          </button>
        </div>
      )}

      {stale > 0 && (
        <div className="flex items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="flex-1">
            {stale.toLocaleString()} bookmark{stale === 1 ? "'s line has" : "s' lines have"} changed in the file (dashed mark).
          </span>
          <button type="button" onClick={api.forgetStale} className="shrink-0 font-medium text-foreground hover:underline">
            Remove
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1">
        {!list.length && (
          <div className="px-2 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            Mark a line with <Kbd>Ctrl+B</Kbd> or a click left of its number.
            <br />
            <Kbd>F2</Kbd> / <Kbd>Shift+F2</Kbd> go to the next / previous one.
          </div>
        )}
        {list.map((b) => {
          const place = places.get(b.line);
          const isHidden = place?.row === null;
          const thread = lanesField ? b.fields[lanesField] : undefined;
          const message = messageOf(b);
          return (
            <div
              key={b.id}
              ref={b.line === current ? currentRef : undefined}
              className={`group rounded-md px-2 py-1 ${b.line === current ? "bg-accent" : "hover:bg-accent/60"} ${isHidden ? "opacity-50" : ""}`}
            >
              <button
                type="button"
                className="flex w-full items-baseline gap-2 text-left font-mono text-xs"
                onClick={() => onJump(b)}
                title={
                  (isHidden ? "Hidden by the current filter: goes to where it would be\n" : "") +
                  (b.stale ? "This line changed in the file since it was marked\n" : "") +
                  b.text
                }
              >
                <BookmarkGlyph stale={b.stale} className="relative top-px h-[11px] w-2 shrink-0" />
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{b.line.toLocaleString()}</span>
                {b.t != null && <span className="shrink-0 tabular-nums text-muted-foreground">{formatFull(b.t).slice(5)}</span>}
                {b.level && (
                  <span className="w-11 shrink-0 font-semibold" style={{ color: `color-mix(in oklab, ${levelColor(b.level) ?? "currentColor"} 70%, var(--foreground))` }}>
                    {b.level}
                  </span>
                )}
                {thread && <span className="max-w-24 shrink-0 truncate text-muted-foreground">{thread}</span>}
                <span className="min-w-0 truncate">{message}</span>
                {isHidden && <span className="ml-auto shrink-0 font-sans text-[10px] italic text-muted-foreground">hidden</span>}
              </button>
              <NoteField
                note={b.note}
                editing={editing === b.id}
                onEdit={() => setEditing(b.id)}
                onDone={(note) => {
                  setEditing(null);
                  if (note != null) api.setNote(b.id, note);
                }}
                onRemove={() => api.remove(b.id)}
              />
            </div>
          );
        })}
      </div>
      <div className="border-t px-3 py-1 text-[10px] text-muted-foreground">
        <Kbd>Ctrl+B</Kbd> mark · <Kbd>F2</Kbd> next · <Kbd>Shift+F2</Kbd> previous · <Kbd>Ctrl+Shift+B</Kbd> this panel
      </div>
    </div>
  );
}

/** The message of a bookmarked line (the text after the bracketed fields), else the line */
function messageOf(b: Bookmark): string {
  let s = b.text;
  // [time] [LEVEL] [domain] [thread] message: drop the leading bracket groups
  for (let i = 0; i < 6 && s.startsWith("["); i++) {
    const end = s.indexOf("]");
    if (end < 0) break;
    s = s.slice(end + 1).trimStart();
  }
  return s || b.text;
}

function NoteField({
  note,
  editing,
  onEdit,
  onDone,
  onRemove,
}: {
  note: string;
  editing: boolean;
  onEdit: () => void;
  /** null: cancelled */
  onDone: (note: string | null) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(note);
  useEffect(() => {
    setDraft(note);
  }, [note, editing]);
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={500}
        placeholder="A short note…"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onDone(draft.trim())}
        onKeyDown={(e) => {
          if (e.key === "Enter") onDone(draft.trim());
          else if (e.key === "Escape") {
            e.stopPropagation();
            onDone(null);
          }
        }}
        className="ml-[1.375rem] mt-0.5 h-6 w-[calc(100%-1.375rem)] rounded border bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    );
  }
  return (
    <div className="ml-[1.375rem] flex items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        title="Edit the note"
        className={`min-w-0 flex-1 truncate rounded px-1 text-left text-xs ${note ? "text-foreground" : "text-muted-foreground/0 group-hover:text-muted-foreground"}`}
      >
        {note || "Add a note…"}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove this bookmark"
        title="Remove this bookmark"
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function PanelButton({
  children,
  icon,
  title,
  disabled,
  onClick,
}: {
  children?: React.ReactNode;
  icon: React.ReactNode;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={children ? undefined : title}
      className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border bg-muted px-1 font-sans text-[10px] text-foreground/80">{children}</kbd>
);
