import { useState } from "react";
import { FolderOpen, Scissors, X } from "lucide-react";
import { cutTimeRange, revealPath, type CutResult } from "../lib/platform";
import { formatDuration, type TimeRange } from "./TimeRangeSelect";
import { Spinner } from "./ui/spinner";

/*
 * "Cut to file": the lines of the selected time range, copied as they are into a new
 * file next to the log (name: log name + range, e.g. app_2026-11-20_0130-0240.log).
 * The button sits on the time range chip in the filter bar and in the name column of
 * the minimap's time scale; the result shows as a note in the corner of the window.
 */

export type CutState = {
  busy: boolean;
  cut: (r: TimeRange) => void;
};

type Note = { result: CutResult; error?: undefined } | { error: string; result?: undefined };

export function useCutRange(sessionId: string): CutState & { note: Note | null; dismiss: () => void } {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const cut = (r: TimeRange) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    cutTimeRange(sessionId, r.from, r.to)
      .then((result) => setNote({ result }))
      .catch((e) => setNote({ error: String(e) }))
      .finally(() => setBusy(false));
  };
  return { busy, cut, note, dismiss: () => setNote(null) };
}

const TITLE = "Cut to file: copy the lines of this time range into a new file next to the log";

/** Scissors on the time range chip (filter bar) */
export function CutChipButton({ range, state }: { range: TimeRange; state: CutState }) {
  return (
    <button
      type="button"
      aria-label="Cut this time range to a new file"
      title={TITLE}
      disabled={state.busy}
      onClick={() => state.cut(range)}
      className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-60"
    >
      {state.busy ? <Spinner className="size-3" /> : <Scissors className="size-3" />}
    </button>
  );
}

/** "✂ Cut to file" in the name column of the minimap's time scale, on a dashed cut line */
export function CutScaleButton({ range, state }: { range: TimeRange; state: CutState }) {
  return (
    <button
      type="button"
      title={TITLE}
      disabled={state.busy}
      onClick={() => state.cut(range)}
      onPointerDown={(e) => e.stopPropagation()}
      className="cut-scale group flex h-full w-full items-center gap-1 px-2 text-[10px] leading-none text-log-fg/70 hover:text-log-fg disabled:cursor-progress"
    >
      {state.busy ? <Spinner className="size-3 shrink-0" /> : <Scissors className="size-3 shrink-0 -scale-x-100 transition-transform group-hover:rotate-[-8deg]" />}
      <span className="truncate">{state.busy ? "Cutting…" : "Cut to file"}</span>
    </button>
  );
}

const size = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

/** The result of a cut, in the bottom right corner until dismissed */
export function CutNote({ note, onDismiss, onOpen }: { note: Note | null; onDismiss: () => void; onOpen?: (path: string) => void }) {
  if (!note) return null;
  const r = note.result;
  return (
    <div
      role="status"
      className="fixed bottom-9 right-4 z-40 flex max-w-[min(34rem,calc(100vw-2rem))] items-start gap-2.5 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
    >
      <Scissors className={`mt-0.5 size-3.5 shrink-0 ${r ? "text-muted-foreground" : "text-destructive"}`} />
      <div className="min-w-0 flex-1">
        {r ? (
          <>
            <div className="truncate font-mono font-medium" title={r.path}>
              {r.name}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {r.line_count.toLocaleString()} lines · {size(r.byte_count)} · lines {r.first_line.toLocaleString()}–{r.last_line.toLocaleString()} ·{" "}
              {formatDuration(r.millis)}
            </div>
            <div className="mt-1.5 flex gap-3">
              <button type="button" className="inline-flex items-center gap-1 font-medium hover:underline" onClick={() => revealPath(r.path).catch(() => {})}>
                <FolderOpen className="size-3.5" />
                Show in folder
              </button>
              {onOpen && (
                <button type="button" className="font-medium hover:underline" onClick={() => onOpen(r.path)} title="Open the new file in this window">
                  Open it
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="text-destructive">Could not cut the range: {note.error}</div>
        )}
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
