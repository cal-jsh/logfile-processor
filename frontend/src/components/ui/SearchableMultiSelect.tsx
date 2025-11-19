import { useState, useMemo } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Command, CommandInput, CommandItem, CommandList, CommandGroup, CommandEmpty } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ChevronsUpDown } from "lucide-react";

// Example usage:
// <SearchableMultiSelect
//   options={["Apple", "Banana", "Mango", "Cherry"]}
//   selected={selectedValues}
//   onChange={setSelectedValues}
// />

export interface SearchableMultiSelectProps {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}

export default function SearchableMultiSelect({ options, selected, onChange }: SearchableMultiSelectProps) {
  
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    return options.filter((opt) => opt.toLowerCase().includes(query.toLowerCase()));
  }, [options, query]);

  const toggleOption = (option: string) => {
    if (selected.includes(option)) {
      onChange(selected.filter((s: string) => s !== option));
    } else {
      onChange([...selected, option]);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="w-64 justify-between"
        >
          {selected.length > 0
            ? `${selected.length} selected`
            : "Select options..."}
          <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="p-0 w-64">
        <Command>
          <CommandInput
            placeholder="Search..."
            value={query}
            onValueChange={setQuery}
          />

          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>

            <CommandGroup>
              {filtered.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => toggleOption(opt)}
                >
                  <Checkbox
                    checked={selected.includes(opt)}
                    className="mr-2"
                  />
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
