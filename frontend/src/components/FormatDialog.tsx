import { useEffect, useState } from "react";
import { ChevronRight, RotateCcw, Wand2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { levelColor } from "../lib/colorMap";
import { cn } from "@/lib/utils";
import type { FieldDef, FormatInfo } from "../lib/logSummary";

/*
 * "Log format" dialog: shows how lines are split into fields and lets the user set
 * their own spdlog-style pattern, with a live preview of the first lines of the file
 * (GET /format/test). Applying reopens the file with the pattern, which is remembered
 * for this file; "Detect automatically" goes back to detection.
 */

type FormatTest = {
  pattern: string;
  error: string | null;
  columns: FieldDef[];
  sample_lines: number;
  matched: number;
  lines: { line_number: number; text: string; fields: string[] | null }[];
  detected_pattern: string;
};

/** Flags worth knowing, shown in the cheat sheet */
const FLAGS: [string, string][] = [
  ["%Y-%m-%d", "date, e.g. 2026-11-20"],
  ["%H:%M:%S", "time (also %T)"],
  ["%e %f %F", "ms, µs, ns (3, 6, 9 digits)"],
  ["%l / %L", "level / short level (I, W, E)"],
  ["%t", "thread id"],
  ["%n", "logger name (Domain)"],
  ["%P", "process id"],
  ["%v", "the message"],
  ["%{name}", "any other field, e.g. %{thread} for a thread name"],
  ["%-8l", "padded field (padding is trimmed)"],
  ["%+", "spdlog's default pattern"],
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  baseUrl: string;
  sessionId: string;
  format: FormatInfo;
  /** Reopen the file with this pattern (null: detect it). Rejects with a message. */
  onApply: (pattern: string | null) => Promise<void>;
}

export default function FormatDialog({ open, onOpenChange, baseUrl, sessionId, format, onApply }: Props) {
  const [input, setInput] = useState(format.pattern);
  const [test, setTest] = useState<FormatTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setInput(format.pattern);
      setApplyError(null);
    }
  }, [open, format.pattern]);

  // live preview, debounced
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setTesting(true);
    const t = setTimeout(() => {
      fetch(
        `${baseUrl}/format/test?session_id=${encodeURIComponent(sessionId)}&pattern=${encodeURIComponent(input)}`,
        { signal: ctrl.signal }
      )
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: FormatTest) => {
          setTest(d);
          setTesting(false);
        })
        .catch((e) => {
          if (e?.name !== "AbortError") setTesting(false);
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, input, baseUrl, sessionId]);

  const apply = async (pattern: string | null) => {
    setBusy(true);
    setApplyError(null);
    try {
      await onApply(pattern);
      onOpenChange(false);
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const share = test && test.sample_lines > 0 ? test.matched / test.sample_lines : null;
  const unchanged = input.trim() === format.pattern;
  const columns = test?.error ? [] : test?.columns ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Log format</DialogTitle>
          <DialogDescription>
            How lines are split into fields, in{" "}
            <span className="font-medium text-foreground">spdlog</span>'s pattern syntax. Currently{" "}
            {format.raw
              ? "no known format fits this file, so every line is shown as it is."
              : format.detected
                ? "detected automatically."
                : "set by you for this file."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && test && !test.error && !busy) apply(input.trim());
              }}
              spellCheck={false}
              aria-label="Pattern"
              placeholder="e.g. [%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v"
              className="h-9 font-mono text-sm"
            />
            {test && test.detected_pattern !== input.trim() && (
              <Button
                variant="outline"
                className="h-9 shrink-0"
                title={`Detected: ${test.detected_pattern}`}
                onClick={() => setInput(test.detected_pattern)}
              >
                <Wand2 />
                Use detected
              </Button>
            )}
          </div>

          <div className="flex min-h-5 items-center gap-2 text-xs">
            {testing && <Spinner className="size-3" />}
            {test?.error ? (
              <span className="text-destructive">{test.error}</span>
            ) : test && share != null ? (
              <span
                className={cn(
                  share >= 0.9 ? "text-green-600 dark:text-green-400" : share >= 0.5 ? "text-amber-600" : "text-destructive"
                )}
              >
                Matches {test.matched.toLocaleString()} of the first {test.sample_lines.toLocaleString()} lines
                {share < 1 && ". Lines that don't match are hidden unless shown as context."}
              </span>
            ) : null}
          </div>

          {/* Preview of the first lines */}
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 bg-muted text-left text-[11px] font-medium text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-right">#</th>
                  {columns.map((c) => (
                    <th key={c.name} className="px-2 py-1 whitespace-nowrap">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(test?.lines ?? []).map((l) => (
                  <tr key={l.line_number} className="border-t align-top">
                    <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">{l.line_number}</td>
                    {l.fields && !test?.error ? (
                      l.fields.map((v, i) => {
                        const c = columns[i];
                        return (
                          <td
                            key={i}
                            className={cn(
                              "px-2 py-0.5",
                              c?.kind === "message" ? "max-w-md truncate" : "whitespace-nowrap"
                            )}
                            title={v}
                            style={
                              c?.kind === "level"
                                ? { color: levelColor(v), fontWeight: 600 }
                                : undefined
                            }
                          >
                            {v}
                          </td>
                        );
                      })
                    ) : (
                      <td colSpan={Math.max(1, columns.length)} className="max-w-md truncate px-2 py-0.5 text-muted-foreground italic" title={l.text}>
                        {l.text} <span className="not-italic text-[10px]">(no match)</span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              Pattern flags
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                {FLAGS.map(([flag, what]) => (
                  <div key={flag} className="flex gap-2">
                    <code className="w-20 shrink-0 font-mono text-foreground">{flag}</code>
                    <span className="text-muted-foreground">{what}</span>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              disabled={busy || format.detected}
              title={format.detected ? "Already detected automatically" : "Forget the pattern for this file"}
              onClick={() => apply(null)}
            >
              <RotateCcw />
              Detect automatically
            </Button>
            {applyError && <span className="text-xs text-destructive">{applyError}</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !test || !!test.error || !input.trim() || unchanged} onClick={() => apply(input.trim())}>
              {busy && <Spinner className="size-3.5" />}
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
