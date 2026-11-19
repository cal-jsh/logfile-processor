import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GripVertical, X } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

/*
 * A panel that floats above the page: drag it by its title bar, resize it from the
 * bottom-right corner, close it with the X or Escape. It lives inside the app window
 * (web and desktop alike), and remembers where it was per `storageKey`.
 */

type Rect = { x: number; y: number; w: number; h: number };

const MIN_W = 280;
const MIN_H = 200;
const MARGIN = 8; // keep at least this much of the panel inside the window

function fitToWindow(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(r.w, MIN_W), vw - 2 * MARGIN);
  const h = Math.min(Math.max(r.h, MIN_H), vh - 2 * MARGIN);
  return {
    w,
    h,
    x: Math.min(Math.max(r.x, MARGIN), vw - w - MARGIN),
    y: Math.min(Math.max(r.y, MARGIN), vh - h - MARGIN),
  };
}

function loadRect(key: string | undefined, fallback: () => Rect): Rect {
  if (key) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      if (saved && [saved.x, saved.y, saved.w, saved.h].every(Number.isFinite)) {
        return fitToWindow(saved);
      }
    } catch {
      /* storage unavailable: use the default */
    }
  }
  return fitToWindow(fallback());
}

export interface FloatingPanelProps {
  title: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  /** Where the panel opens the first time (it then remembers its own place) */
  defaultRect?: () => Rect;
  storageKey?: string;
  className?: string;
  children: ReactNode;
}

export function FloatingPanel({
  title,
  icon,
  onClose,
  defaultRect,
  storageKey,
  className,
  children,
}: FloatingPanelProps) {
  const [rect, setRect] = useState<Rect>(() =>
    loadRect(storageKey, defaultRect ?? (() => ({ x: window.innerWidth - 440, y: 80, w: 420, h: 480 })))
  );
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const save = useCallback(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(rectRef.current));
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  // stay inside the window when it shrinks
  useEffect(() => {
    const onResize = () => setRect((r) => fitToWindow(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  /* drag (title bar) and resize (corner) share one pointer handler */
  const gesture = useRef<{ mode: "move" | "resize"; px: number; py: number; start: Rect } | null>(null);

  const begin = (mode: "move" | "resize") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // let buttons in the title bar work normally
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { mode, px: e.clientX, py: e.clientY, start: rectRef.current };
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.px;
    const dy = e.clientY - g.py;
    setRect(
      fitToWindow(
        g.mode === "move"
          ? { ...g.start, x: g.start.x + dx, y: g.start.y + dy }
          : { ...g.start, w: g.start.w + dx, h: g.start.h + dy }
      )
    );
  };
  const end = () => {
    if (!gesture.current) return;
    gesture.current = null;
    save();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal={false}
      onKeyDown={onKeyDown}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl ring-1 ring-black/5",
        "animate-in fade-in-0 zoom-in-95 duration-150",
        className
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {/* title bar: drag handle */}
      <div
        className="flex h-10 shrink-0 cursor-grab select-none items-center gap-2 border-b bg-muted/40 pl-2 pr-1 active:cursor-grabbing"
        onPointerDown={begin("move")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => {
          // double-click the title bar to put it back where it started
          setRect(fitToWindow((defaultRect ?? (() => rectRef.current))()));
          setTimeout(save);
        }}
      >
        <GripVertical className="size-4 text-muted-foreground/60" />
        {icon}
        <div className="flex-1 truncate text-sm font-medium">{title}</div>
        <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>

      {/* resize handle */}
      <div
        aria-hidden
        className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
        onPointerDown={begin("resize")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/50">
          <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>,
    document.body
  );
}

export default FloatingPanel;
