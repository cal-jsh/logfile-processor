import { Check, Palette, SlidersHorizontal } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import FormatSettings, { type FormatPageProps } from "./FormatSettings";
import { setThemeChoice, useTheme, useThemeChoice, type ThemeChoice } from "../lib/theme";
import { cn } from "@/lib/utils";

export type SettingsPage = "appearance" | "format";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: SettingsPage;
  onPageChange: (page: SettingsPage) => void;
  /** The open file's line format (the "Log format" page) */
  format: FormatPageProps;
}

/** True when the file's line format is worth a warning: none found, or it fits less
    than half of the first lines */
export function formatNeedsAttention(f: FormatPageProps["format"]): boolean {
  return f.raw || (f.sample_lines > 0 && f.sample_matched / f.sample_lines < 0.5);
}

/** Settings, one page per topic, listed on the left. Opened from the sidebar footer or
    with Ctrl+, (the log format page also from its warning in the sidebar), so the
    sidebar keeps only what changes the current view. */
export default function SettingsDialog({ open, onOpenChange, page, onPageChange, format }: Props) {
  const f = format.format;
  const pages: { id: SettingsPage; label: string; hint: string; icon: React.ReactNode; warn?: boolean }[] = [
    {
      id: "format",
      label: "Log format",
      hint: f.raw ? "No format found" : f.detected ? "Detected for this file" : "Set by you for this file",
      icon: <SlidersHorizontal />,
      warn: formatNeedsAttention(f),
    },
    { id: "appearance", label: "Appearance", hint: "Theme", icon: <Palette /> },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* no focus ring on the first control when it opens: it read as "selected" */}
      <DialogContent
        className="flex h-[min(720px,88vh)] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <nav className="flex w-56 shrink-0 flex-col gap-1 border-r bg-muted/40 p-3">
          <DialogTitle className="px-2 pt-1 pb-3 text-base">Settings</DialogTitle>
          <DialogDescription className="sr-only">App settings and the open file's log format</DialogDescription>
          {pages.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={page === p.id ? "page" : undefined}
              onClick={() => onPageChange(p.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0",
                page === p.id
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
              )}
            >
              {p.icon}
              <span className="grid min-w-0">
                <span className="text-sm font-medium">{p.label}</span>
                <span className={cn("truncate text-xs", p.warn ? "text-amber-600" : "text-muted-foreground")}>
                  {p.hint}
                </span>
              </span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-auto p-6 pr-12">
          {page === "appearance" ? (
            <AppearancePage />
          ) : (
            <FormatSettings {...format} active={open && page === "format"} onDone={() => onOpenChange(false)} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppearancePage() {
  const choice = useThemeChoice();
  const theme = useTheme();
  return (
    <div className="grid max-w-xl gap-6">
      <div className="grid gap-1">
        <h3 className="text-base leading-none font-semibold">Appearance</h3>
        <p className="text-sm text-muted-foreground">Kept for the next start, in every window.</p>
      </div>
      <section className="grid gap-2.5">
        <div className="flex items-baseline justify-between">
          <h4 className="text-sm font-medium">Theme</h4>
          {choice === "system" && <span className="text-xs text-muted-foreground">Windows is set to {theme} now</span>}
        </div>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2.5">
          {OPTIONS.map((o) => {
            const on = choice === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setThemeChoice(o.value)}
                className={cn(
                  "group grid gap-1.5 rounded-lg p-1.5 text-left outline-none transition-colors",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  on ? "bg-secondary" : "hover:bg-secondary/60"
                )}
              >
                <div
                  className={cn(
                    "relative aspect-[16/10] overflow-hidden rounded-md border",
                    on ? "border-foreground/60 ring-1 ring-foreground/60" : "border-border"
                  )}
                >
                  {o.value === "system" ? (
                    <>
                      <Preview look="light" />
                      <div className="absolute inset-0 [clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]">
                        <Preview look="dark" />
                      </div>
                    </>
                  ) : (
                    <Preview look={o.value} />
                  )}
                  {on && (
                    <span className="absolute right-1 bottom-1 grid size-4 place-items-center rounded-full bg-foreground text-background">
                      <Check className="size-2.5" strokeWidth={3} />
                    </span>
                  )}
                </div>
                <div className="px-0.5">
                  <div className="text-sm leading-tight font-medium">{o.label}</div>
                  <div className="text-xs leading-snug text-muted-foreground">{o.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

const OPTIONS: { value: ThemeChoice; label: string; hint: string }[] = [
  { value: "system", label: "Auto", hint: "Follows Windows" },
  { value: "light", label: "Light", hint: "Ink on paper" },
  { value: "dark", label: "Dark", hint: "Light text on dark" },
];

/* A small picture of the app in a theme: sidebar, minimap, a few log lines. Drawn with
   the themes' own colours (index.css, lib/colorMap.ts), not the tokens in effect. */
const LOOKS = {
  light: {
    chrome: "#ffffff", line: "#e5e5e5", text: "#d4d4d4", log: "#fbf8f2", panel: "#f1eadf",
    ink: "#2a211b", dim: "#c9bfb5", levels: ["#4b8a1c", "#3f7d96", "#c26a00", "#d3261b"],
  },
  dark: {
    chrome: "#171717", line: "#2a2a2a", text: "#3d3d3d", log: "#1e1e1e", panel: "#252526",
    ink: "#e8e8e8", dim: "#4b5160", levels: ["#8cc644", "#94bbc8", "orange", "red"],
  },
} as const;

function Preview({ look }: { look: "light" | "dark" }) {
  const c = LOOKS[look];
  const rows = [
    [0, 0.72], [1, 0.55], [0, 0.8], [2, 0.6], [0, 0.48], [3, 0.66], [1, 0.74],
  ] as const;
  return (
    <div className="absolute inset-0 flex" style={{ background: c.chrome }}>
      {/* sidebar */}
      <div className="flex w-[24%] flex-col gap-[7%] border-r px-[5%] pt-[8%]" style={{ borderColor: c.line }}>
        {[0.9, 0.7, 0.8, 0.5].map((w, i) => (
          <div key={i} className="h-[3px] rounded-full" style={{ width: `${w * 100}%`, background: c.text }} />
        ))}
      </div>
      {/* log surface */}
      <div className="m-[4%] flex flex-1 flex-col overflow-hidden rounded-[3px]" style={{ background: c.log }}>
        <div className="flex h-[16%] items-center gap-[1px] px-[3%]" style={{ background: c.panel }}>
          {[3, 1, 0, 0, 2, 0, 1, 0, 0, 3, 0, 1].map((l, i) => (
            <div key={i} className="h-[55%] flex-1" style={{ background: c.levels[l], opacity: l === 0 ? 0.55 : 1 }} />
          ))}
        </div>
        <div className="flex flex-1 flex-col justify-evenly px-[5%]">
          {rows.map(([l, w], i) => (
            <div key={i} className="flex items-center gap-[4%]">
              <div className="h-[2px] w-[8%] rounded-full" style={{ background: c.dim }} />
              <div className="h-[2px] w-[10%] rounded-full" style={{ background: c.levels[l] }} />
              <div className="h-[2px] rounded-full" style={{ width: `${w * 70}%`, background: c.ink, opacity: 0.75 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
