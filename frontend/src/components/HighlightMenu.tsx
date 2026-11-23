/* The log's right-click menu: highlight the word under the pointer (or the selected text)
   in one of the highlight colours, remove it, clear all, copy the selection. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Eraser, Settings2, X } from "lucide-react";
import {
  HIGHLIGHT_COLORS,
  clearHighlights,
  highlightOf,
  isWordChar,
  nextColor,
  removeHighlight,
  setHighlight,
  useHighlights,
} from "../lib/highlights";
import { cn } from "@/lib/utils";

export type HighlightTarget = {
  x: number;
  y: number;
  /** the word under the pointer or the selected text; null on a spot without text */
  text: string | null;
  /** the text came from a selection (Copy is offered) */
  selection: boolean;
};

const MAX_TEXT = 200;

/** What a right-click at (x, y) in the log points at: the selected text if the click is
    in a one-line selection, else the word under the pointer (letters, digits, `_`) in
    the row's text (the element with `data-row-text`). */
export function targetAt(x: number, y: number, root: HTMLElement): HighlightTarget {
  const sel = window.getSelection();
  const s = sel?.toString().trim();
  if (s && sel!.rangeCount && root.contains(sel!.anchorNode) && !/[\r\n]/.test(s)) {
    const inside = Array.from(sel!.getRangeAt(0).getClientRects()).some(
      (r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2
    );
    if (inside) return { x, y, text: s.slice(0, MAX_TEXT), selection: true };
  }
  const caret = document.caretRangeFromPoint?.(x, y);
  const node = caret?.startContainer;
  const rowEl = node?.nodeType === Node.TEXT_NODE ? node.parentElement?.closest<HTMLElement>("[data-row-text]") : null;
  if (!caret || !rowEl) return { x, y, text: null, selection: false };
  const before = document.createRange();
  before.setStart(rowEl, 0);
  before.setEnd(caret.startContainer, caret.startOffset);
  const full = rowEl.textContent ?? "";
  const at = before.toString().length;
  let a = at;
  let b = at;
  while (a > 0 && isWordChar(full[a - 1])) a--;
  while (b < full.length && isWordChar(full[b])) b++;
  return { x, y, text: b > a ? full.slice(a, b).slice(0, MAX_TEXT) : null, selection: false };
}

export function HighlightMenu({
  target,
  onClose,
  onOpenSettings,
}: {
  target: HighlightTarget;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useHighlights();
  const text = target.text;
  const current = text ? highlightOf(text) : undefined;
  const [pos, setPos] = useState({ left: target.x, top: target.y });

  // keep it on screen; open up or left when there is no room below or right
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = target.x + r.width > window.innerWidth - 4 ? Math.max(4, target.x - r.width) : target.x;
    const top = target.y + r.height > window.innerHeight - 4 ? Math.max(4, target.y - r.height) : target.y;
    setPos({ left, top });
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [target]);

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("wheel", away, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", away, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // arrow keys move between the items (the colours count as items)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem],[role=menuitemradio]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step || !items.length) return;
    e.preventDefault();
    items[(i + step + items.length) % items.length].focus();
  };

  const act = (f: () => void) => () => {
    f();
    onClose();
  };
  const preview = current?.color ?? nextColor();

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Highlight"
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-64 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
      style={pos}
    >
      {text && (
        <>
          <div className="px-2 pt-1.5 pb-2">
            <div className="text-xs text-muted-foreground">{current ? "Highlighted everywhere" : "Highlight everywhere"}</div>
            <div className="mt-1 truncate font-mono text-[13px]" title={text}>
              <mark className="mark-word" style={{ "--hl": HIGHLIGHT_COLORS[preview].color } as React.CSSProperties}>
                {text}
              </mark>
            </div>
          </div>
          <div role="group" aria-label="Colour" className="flex gap-1 px-2 pb-2">
            {HIGHLIGHT_COLORS.map((c, i) => {
              const on = current?.color === i;
              return (
                <button
                  key={c.name}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  title={c.name}
                  onClick={act(() => setHighlight(text, i))}
                  className={cn(
                    "grid size-7 place-items-center rounded-md outline-none transition-transform",
                    "hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
                    on && "ring-2 ring-foreground/70"
                  )}
                  style={{ background: c.color }}
                >
                  {on && <Check className="size-3.5 text-[#1c1917]" strokeWidth={3} />}
                </button>
              );
            })}
          </div>
          <div className="-mx-1 my-1 h-px bg-border" />
        </>
      )}
      {text && current && (
        <Item icon={<X />} onClick={act(() => removeHighlight(text))}>
          Remove this highlight
        </Item>
      )}
      {target.selection && text && (
        <Item icon={<Copy />} shortcut="Ctrl+C" onClick={act(() => navigator.clipboard?.writeText(text).catch(() => {}))}>
          Copy
        </Item>
      )}
      <Item icon={<Eraser />} disabled={!state.words.length} onClick={act(clearHighlights)}>
        Clear all highlights{state.words.length ? ` (${state.words.length})` : ""}
      </Item>
      <Item icon={<Settings2 />} onClick={act(onOpenSettings)}>
        Highlight settings…
      </Item>
    </div>,
    document.body
  );
}

function Item({
  icon,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none",
        "hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-xs text-muted-foreground">{shortcut}</span>}
    </button>
  );
}
