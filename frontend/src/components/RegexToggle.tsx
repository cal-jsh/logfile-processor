import { cn } from "../lib/utils";

/** The ".*" switch next to a text field: the text is a regular expression (Alt+R). */
export function RegexToggle({
  on,
  onChange,
  className,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label="Regular expression"
      title={on ? "Regular expression (Alt+R): on" : "Regular expression (Alt+R)"}
      // keep the focus in the text field next to it
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!on)}
      className={cn(
        "inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded-md px-1 font-mono text-[11px] font-semibold leading-none tracking-tight transition-colors",
        on
          ? "bg-primary text-primary-foreground shadow-xs"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        className
      )}
    >
      .*
    </button>
  );
}
