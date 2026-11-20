import { useState, useMemo } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandGroup,
  CommandEmpty,
} from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SearchableMultiSelectProps {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** Shown on the trigger, e.g. "Domains" */
  label?: string;
  icon?: React.ReactNode;
  triggerClassName?: string;
}

export default function SearchableMultiSelect({
  options,
  selected,
  onChange,
  label,
  icon,
  triggerClassName,
}: SearchableMultiSelectProps) {
  // Controlled open so we can reliably toggle from the Button
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return options.filter((opt) =>
      opt.toLowerCase().includes(query.toLowerCase())
    );
  }, [options, query]);

  const toggleOption = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter((s: string) => s !== option));
    } else {
      onChange([...selected, option]);
    }
  };

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
      <PopoverContent className="p-0 w-64 z-50" align="start">
        <Command>
          <CommandInput
            placeholder="Search..."
            value={query}
            onValueChange={(val: string) => setQuery(val)}
          />

          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>

            <CommandGroup>
              <CommandItem
                key="__select_all"
                value="__select_all"
                onSelect={() => {
                  onChange(options.slice());
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

            {/* separator between the actions and the selectable options */}
            <div className="border-t border-gray-200 my-1 mx-2" role="separator" />

            <CommandGroup>
              {filtered.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  // CommandItem's onSelect signature varies across implementations.
                  // Using an inline handler is robust.
                  onSelect={() => toggleOption(opt)}
                >
                  <Checkbox checked={selected.includes(opt)} className="mr-2" />
                  {opt}
                </CommandItem>
              ))}
            </CommandGroup>

          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
