import { useState, useMemo } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandGroup,
} from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Asterisk, ChevronsUpDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isPattern, valueMatcher } from "@/lib/valuePattern";

export interface SearchableMultiSelectProps {
  options: string[];
  /** Checked entries: options and patterns */
  selected: string[];
  onChange: (values: string[]) => void;
  /** Patterns the user added (e.g. `ui.*`), kept in the list whether checked or not.
   *  Without `onPatternsChange` no patterns can be added. */
  patterns?: string[];
  onPatternsChange?: (patterns: string[]) => void;
  /** Shown on the trigger, e.g. "Domains" */
  label?: string;
  icon?: React.ReactNode;
  triggerClassName?: string;
}

export default function SearchableMultiSelect({
  options,
  selected,
  onChange,
  patterns = [],
  onPatternsChange,
  label,
  icon,
  triggerClassName,
}: SearchableMultiSelectProps) {
  // Controlled open so we can reliably toggle from the Button
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const canAdd = onPatternsChange != null;
  // a query with `*` is a pattern: the list previews what it would select
  const typedIsPattern = canAdd && isPattern(typed);

  const filtered = useMemo(() => {
    if (typedIsPattern) return options.filter(valueMatcher(typed));
    const q = typed.toLowerCase();
    return options.filter((opt) => opt.toLowerCase().includes(q));
  }, [options, typed, typedIsPattern]);

  // the checked patterns, to show which options they select
  const activePatterns = useMemo(
    () => selected.filter(isPattern).map((p) => ({ p, test: valueMatcher(p) })),
    [selected]
  );
  const coveredBy = (opt: string) => activePatterns.find((a) => a.test(opt))?.p;
  const matchCount = useMemo(() => {
    const n: Record<string, number> = {};
    for (const p of patterns) n[p] = options.filter(valueMatcher(p)).length;
    return n;
  }, [patterns, options]);

  const toggleOption = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter((s: string) => s !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  const addPattern = () => {
    if (!typedIsPattern) return;
    if (!patterns.includes(typed)) onPatternsChange?.([...patterns, typed]);
    if (!selected.includes(typed)) onChange([...selected, typed]);
    setQuery("");
  };

  const removePattern = (p: string) => {
    onPatternsChange?.(patterns.filter((x) => x !== p));
    if (selected.includes(p)) onChange(selected.filter((s) => s !== p));
  };

  // while searching, the patterns are filtered like the options
  const visiblePatterns =
    typed && !typedIsPattern ? patterns.filter((p) => p.toLowerCase().includes(typed.toLowerCase())) : patterns;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* important: type="button" and explicit onClick toggle */}
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-64 justify-between", triggerClassName)}
          onClick={() => setOpen((v) => !v)} // <-- ensures clicking opens/closes reliably
        >
          {label ? (
            <span className="flex items-center gap-1.5">
              {icon}
              {label}
              {selected.length > 0 && (
                <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground tabular-nums">
                  {selected.length}
                </span>
              )}
            </span>
          ) : selected.length > 0 ? (
            `${selected.length} selected`
          ) : (
            "Select options..."
          )}
          <ChevronsUpDown className="ml-1 h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      {/* add a high z-index so it won't be hidden under other elements */}
      <PopoverContent className="p-0 w-72 z-50" align="start">
        {/* filtered here: cmdk's fuzzy filter knows nothing of patterns */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={canAdd ? "Search, or add a pattern like ui.*" : "Search..."}
            value={query}
            onValueChange={(val: string) => setQuery(val)}
          />

          <CommandList>
            {typedIsPattern && (
              <CommandGroup>
                <CommandItem value="__add_pattern" onSelect={addPattern} className="gap-2">
                  <Plus className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    Add <span className="font-mono font-medium">{typed}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {filtered.length} {filtered.length === 1 ? "match" : "matches"}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}

            {!typed && (
              <CommandGroup>
                <CommandItem
                  key="__select_all"
                  value="__select_all"
                  onSelect={() => {
                    onChange([...selected.filter(isPattern), ...options]);
                    setOpen(false);
                  }}
                >
                  <div className="w-full text-center">Select all</div>
                </CommandItem>

                <CommandItem
                  key="__select_none"
                  value="__select_none"
                  onSelect={() => {
                    onChange([]);
                    setOpen(false);
                  }}
                >
                  <div className="w-full text-center">Select none</div>
                </CommandItem>
              </CommandGroup>
            )}

            {visiblePatterns.length > 0 && (
              <>
                <div className="border-t border-border my-1 mx-2" role="separator" />
                <CommandGroup heading="Patterns">
                  {visiblePatterns.map((p) => (
                    <CommandItem
                      key={`p:${p}`}
                      value={`__pattern:${p}`}
                      onSelect={() => toggleOption(p)}
                      className="group/pat"
                    >
                      <Checkbox checked={selected.includes(p)} className="mr-2" />
                      <Asterisk className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono">{p}</span>
                      <span
                        className="text-xs tabular-nums text-muted-foreground"
                        title={`Selects ${matchCount[p]} of the listed values`}
                      >
                        {matchCount[p]}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${p}`}
                        title="Remove pattern"
                        className="-mr-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover/pat:opacity-100 group-data-[selected=true]/pat:opacity-100"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          removePattern(p);
                        }}
                      >
                        <X className="size-3.5" />
                      </button>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}

            {/* separator between the actions and the selectable options */}
            <div className="border-t border-border my-1 mx-2" role="separator" />

            <CommandGroup>
              {filtered.length === 0 && (
                <div className="py-4 text-center text-sm text-muted-foreground">No results.</div>
              )}
              {filtered.map((opt) => {
                const on = selected.includes(opt);
                // not checked itself, but selected through a checked pattern
                const via = on ? undefined : coveredBy(opt);
                return (
                  <CommandItem
                    key={opt}
                    value={opt}
                    // CommandItem's onSelect signature varies across implementations.
                    // Using an inline handler is robust.
                    onSelect={() => toggleOption(opt)}
                    title={via ? `Selected by ${via}` : undefined}
                  >
                    <Checkbox checked={on || via != null} className={cn("mr-2", via && "opacity-45")} />
                    <span className={cn("min-w-0 flex-1 truncate", via && "text-muted-foreground")}>{opt}</span>
                    {via && <span className="font-mono text-[10px] text-muted-foreground">{via}</span>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
