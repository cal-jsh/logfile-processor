/* Settings > Highlights: the highlighted words with their colours, how they match, and a
   field to add one by typing (the usual way is a right-click on a word in the log). */
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  HIGHLIGHT_COLORS,
  clearHighlights,
  nextColor,
  removeHighlight,
  setHighlight,
  setHighlightOptions,
  useHighlights,
} from "../lib/highlights";
import { cn } from "@/lib/utils";

export default function HighlightSettings() {
  const { words, matchCase, wholeWord } = useHighlights();
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    setHighlight(t, nextColor());
    setDraft("");
  };
  return (
    <div className="grid max-w-xl gap-6">
      <div className="grid gap-1">
        <h3 className="text-base leading-none font-semibold">Highlights</h3>
        <p className="text-sm text-muted-foreground">
          Right-click a word in the log (or selected text) to mark it in a colour wherever it shows. Kept for every
          file and the next start.
        </p>
      </div>

      <section className="grid gap-2.5">
        <h4 className="text-sm font-medium">Matching</h4>
        <div className="flex items-center gap-2">
          <Checkbox id="hl-case" checked={matchCase} onCheckedChange={(v) => setHighlightOptions({ matchCase: v === true })} />
          <Label htmlFor="hl-case" className="font-normal">Match case</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="hl-word" checked={wholeWord} onCheckedChange={(v) => setHighlightOptions({ wholeWord: v === true })} />
          <Label htmlFor="hl-word" className="font-normal">
            Whole words only <span className="text-muted-foreground">(“id” does not mark inside “pid”)</span>
          </Label>
        </div>
      </section>

      <section className="grid gap-2.5">
        <div className="flex items-baseline justify-between">
          <h4 className="text-sm font-medium">Highlighted words</h4>
          {words.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearHighlights}>
              Clear all
            </Button>
          )}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a word…" className="h-8 font-mono text-[13px]" />
          <Button type="submit" size="sm" variant="secondary" className="h-8" disabled={!draft.trim()}>
            <Plus /> Add
          </Button>
        </form>
        {words.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">No words highlighted yet</p>
        ) : (
          <ul className="grid divide-y rounded-md border">
            {[...words].reverse().map((w) => (
              <li key={w.text} className="flex items-center gap-3 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={w.text}>
                  <mark className="mark-word" style={{ "--hl": HIGHLIGHT_COLORS[w.color].color } as React.CSSProperties}>
                    {w.text}
                  </mark>
                </span>
                <span role="radiogroup" aria-label={`Colour of ${w.text}`} className="flex gap-1">
                  {HIGHLIGHT_COLORS.map((c, i) => (
                    <button
                      key={c.name}
                      type="button"
                      role="radio"
                      aria-checked={w.color === i}
                      title={c.name}
                      onClick={() => setHighlight(w.text, i)}
                      className={cn(
                        "size-4 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        w.color === i ? "ring-2 ring-foreground/70 ring-offset-1 ring-offset-background" : "opacity-60 hover:opacity-100"
                      )}
                      style={{ background: c.color }}
                    />
                  ))}
                </span>
                <Button variant="ghost" size="icon" className="size-7" title="Remove" onClick={() => removeHighlight(w.text)}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
