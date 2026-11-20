import { useEffect, useMemo, useRef, useState } from "react";
import { LogViewer } from "../components/LogViewer";
import type { LogSummary } from "../lib/logSummary";
import SearchableMultiSelect from "../components/SearchableMultiSelect";
import LogSummarySidebar from "../components/LogSummarySidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { levelColor, levelRank } from "../lib/colorMap";
import { ChevronDown, ChevronUp, Filter, GitBranch, Layers, ListFilter, Tag, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MinimapAxis } from "../components/Minimap";

interface DashboardProps {
    sessionId: string;
    /** The in-process API, e.g. "http://127.0.0.1:51234" */
    baseUrl: string;
    summary: LogSummary;
    /** Path of the open file */
    fileName?: string;
    /** Close this file and go back to the start page */
    onClose?: () => void;
    /** Reopen the file with another line format (null: detect it) */
    onChangeFormat: (pattern: string | null) => Promise<void>;
}

const FIELD_ICONS: Record<string, React.ReactNode> = {
    domain: <Layers className="size-3.5" />,
    thread: <GitBranch className="size-3.5" />,
};

const plural = (label: string) => (label.endsWith("s") ? label : `${label}s`);

/** A yes/no setting remembered per browser (shared by all windows) */
function useStoredFlag(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
    const [value, setValue] = useState<boolean>(() => {
        try {
            const v = localStorage.getItem(key);
            return v === null ? fallback : v === "true";
        } catch {
            return fallback;
        }
    });
    const set = (v: boolean) => {
        setValue(v);
        try {
            localStorage.setItem(key, String(v));
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    return [value, set];
}

/** Keys typed here keep their own meaning (Ctrl+arrows move by word in a text field) */
function isTypingTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
    if (t instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(t.type);
    // modal dialogs (log format, bug report, ...) and open dropdown lists
    return !!t.closest('[data-slot="dialog-content"], [role="listbox"], [role="menu"]');
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl, summary, fileName, onClose, onChangeFormat }) => {
    const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
    // values per filterable field (domain, thread, ...): none selected = all
    const [selectedFields, setSelectedFields] = useState<Record<string, string[]>>({});
    const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
    const [newKeyword, setNewKeyword] = useState<string>("");

    const [contextLines, setContextLines] = useState<number>(0);

    const [debouncedLevels, setDebouncedLevels] = useState<string>("");
    const [debouncedFields, setDebouncedFields] = useState<string>("");
    const [debouncedKeywords, setDebouncedKeywords] = useState<string>("");

    const [showDelta, setShowDelta] = useState(false); // controls delta display
    // level minimap above the rows; remembered per browser
    const [showMinimap, setShowMinimapState] = useState<boolean>(() => {
        try {
            return localStorage.getItem("logviewer.showMinimap") !== "false";
        } catch {
            return true;
        }
    });
    const [minimapAxis, setMinimapAxisState] = useState<MinimapAxis>(() => {
        try {
            return localStorage.getItem("logviewer.minimapAxis") === "time" ? "time" : "line";
        } catch {
            return "line";
        }
    });
    const setMinimapAxis = (v: MinimapAxis) => {
        setMinimapAxisState(v);
        try {
            localStorage.setItem("logviewer.minimapAxis", v);
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    // what the minimap colours by: "level" or a text field's name (e.g. "domain")
    const [minimapColor, setMinimapColorState] = useState<string>(() => {
        try {
            return localStorage.getItem("logviewer.minimapColor") || "level";
        } catch {
            return "level";
        }
    });
    const setMinimapColor = (v: string) => {
        setMinimapColorState(v);
        try {
            localStorage.setItem("logviewer.minimapColor", v);
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    const setShowMinimap = (v: boolean) => {
        setShowMinimapState(v);
        try {
            localStorage.setItem("logviewer.showMinimap", String(v));
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    // thread swimlanes below the minimap, and the field that makes the lanes
    const [showLanes, setShowLanesState] = useState<boolean>(() => {
        try {
            return localStorage.getItem("logviewer.showLanes") === "true";
        } catch {
            return false;
        }
    });
    const setShowLanes = (v: boolean) => {
        setShowLanesState(v);
        try {
            localStorage.setItem("logviewer.showLanes", String(v));
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    const [lanesField, setLanesFieldState] = useState<string>(() => {
        try {
            return localStorage.getItem("logviewer.lanesField") || "thread";
        } catch {
            return "thread";
        }
    });
    const setLanesField = (v: string) => {
        setLanesFieldState(v);
        try {
            localStorage.setItem("logviewer.lanesField", v);
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    // fields not shown as columns, by name; remembered per browser for all files
    const [hiddenColumns, setHiddenColumnsState] = useState<string[]>(() => {
        try {
            const v = JSON.parse(localStorage.getItem("logviewer.hiddenColumns") ?? "[]");
            return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
        } catch {
            return [];
        }
    });
    const setHiddenColumns = (v: string[]) => {
        setHiddenColumnsState(v);
        try {
            localStorage.setItem("logviewer.hiddenColumns", JSON.stringify(v));
        } catch {
            /* storage unavailable: keep it for this session only */
        }
    };
    const [searchOpen, setSearchOpen] = useState(false); // floating search panel

    // The sidebar and the filter panel start hidden so the log gets the space; the
    // choice is remembered. Ctrl+Right/Left show/hide the sidebar, Ctrl+Down/Up the filters.
    const [sidebarOpen, setSidebarOpen] = useStoredFlag("logviewer.sidebarOpen", false);
    const [filterOpen, setFilterOpen] = useStoredFlag("logviewer.filterOpen", false);
    const panelKeys = useRef({ setSidebarOpen, setFilterOpen });
    panelKeys.current = { setSidebarOpen, setFilterOpen };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
            const { setSidebarOpen, setFilterOpen } = panelKeys.current;
            const actions: Record<string, () => void> = {
                ArrowRight: () => setSidebarOpen(true),
                ArrowLeft: () => setSidebarOpen(false),
                ArrowDown: () => setFilterOpen(true),
                ArrowUp: () => setFilterOpen(false),
            };
            const action = actions[e.key];
            if (!action || isTypingTarget(e.target)) return;
            e.preventDefault();
            action();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    // the hidden filter controls can't be tabbed into
    const filterPanelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        filterPanelRef.current?.toggleAttribute("inert", !filterOpen);
    }, [filterOpen]);

    // Debounce filters
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(selectedLevels.join(","));
            const active = Object.entries(selectedFields).filter(([, v]) => v.length > 0);
            setDebouncedFields(active.length ? JSON.stringify(Object.fromEntries(active)) : "");
            setDebouncedKeywords(selectedKeywords.join(","));
        }, 300);
        return () => clearTimeout(timer);
    }, [selectedLevels, selectedFields, selectedKeywords]);

    // levels in the file, in severity order (unknown ones last)
    // colour by a field only if this file's format has it (the choice is kept for other files)
    const effectiveMinimapColor = summary.format.columns.some((c) => c.kind === "text" && c.name === minimapColor)
        ? minimapColor
        : "level";
    // lanes by the chosen field if this file has it, else by thread, else by the first text field
    const textFields = summary.format.columns.filter((c) => c.kind === "text");
    const lanesFieldDef =
        textFields.find((c) => c.name === lanesField) ?? textFields.find((c) => c.name === "thread") ?? textFields[0] ?? null;
    const levelOptions = Object.keys(summary.levels || {}).sort((a, b) => levelRank(a) - levelRank(b) || a.localeCompare(b));
    // a filter per field with more than one value (domain, thread, ...)
    const fieldFilters = (summary.fields ?? []).filter((f) => f.values.length > 1 || f.more);

    // widest value per field (from the summary), so the viewer can line the columns up
    const columnWidths = useMemo(() => {
        const w: Record<string, number> = {};
        for (const f of summary.fields ?? []) w[f.name] = Math.min(24, Math.max(0, ...f.values.map((v) => v.length)));
        const level = summary.format.columns.find((c) => c.kind === "level");
        if (level) w[level.name] = Math.max(0, ...Object.keys(summary.levels ?? {}).map((l) => l.length));
        return w;
    }, [summary]);

    const levelsParam = debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : "";
    const fieldsParam = debouncedFields ? `&fields=${encodeURIComponent(debouncedFields)}` : "";
    const keywordsParam = debouncedKeywords ? `&keywords=${encodeURIComponent(debouncedKeywords)}` : "";

    // Changing the filter triggers one scan on the backend; changing the context
    // reuses its result (the backend keeps match line numbers, not text).
    const filterParams = `${levelsParam}${fieldsParam}${keywordsParam}`;

    const toggleLevel = (l: string) =>
        setSelectedLevels((s) => (s.includes(l) ? s.filter((x) => x !== l) : [...s, l]));

    const addKeyword = () => {
        const val = newKeyword.trim();
        if (val && !selectedKeywords.includes(val)) setSelectedKeywords((s) => [...s, val]);
        setNewKeyword("");
    };

    const fieldCount = Object.values(selectedFields).reduce((a, v) => a + v.length, 0);
    const hasFilter = selectedLevels.length + fieldCount + selectedKeywords.length > 0;
    const clearFilters = () => {
        setSelectedLevels([]);
        setSelectedFields({});
        setSelectedKeywords([]);
        setNewKeyword("");
    };

    return (
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
            <LogSummarySidebar
                summary={summary}
                baseUrl={baseUrl}
                sessionId={sessionId}
                onChangeFormat={onChangeFormat}
                hiddenColumns={hiddenColumns}
                setHiddenColumns={setHiddenColumns}
                fileName={fileName}
                onOpenAnother={onClose}
                searchOpen={searchOpen}
                onToggleSearch={() => setSearchOpen((o) => !o)}
                showDelta={showDelta}
                setShowDelta={setShowDelta}
                showMinimap={showMinimap}
                setShowMinimap={setShowMinimap}
                minimapAxis={minimapAxis}
                setMinimapAxis={setMinimapAxis}
                minimapColor={effectiveMinimapColor}
                setMinimapColor={setMinimapColor}
                showLanes={showLanes}
                setShowLanes={setShowLanes}
                lanesField={lanesFieldDef?.name ?? null}
                setLanesField={setLanesField}
                contextLines={contextLines}
                setContextLines={setContextLines}
            />

            <SidebarInset className="h-svh min-w-0 overflow-hidden">
                <div className="flex h-full min-h-0 flex-col p-3">
                    {/* Filter panel: slides open from the top (Ctrl+Down), closes with Ctrl+Up */}
                    <div
                        className={cn(
                            "grid shrink-0 transition-[grid-template-rows] duration-200 ease-linear",
                            filterOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                        )}
                    >
                        <div ref={filterPanelRef} className="min-h-0 overflow-hidden" aria-hidden={!filterOpen}>
                            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-2 py-1.5 shadow-xs">
                                {/* the sidebar is a drawer on small screens */}
                                <SidebarTrigger className="md:hidden" />

                                <div className="flex items-center gap-1.5 pl-1 text-xs font-medium text-muted-foreground">
                                    <Filter className="size-3.5" />
                                    Filter
                                </div>

                                {/* Levels: toggle chips (none selected = all) */}
                                <div className="flex items-center gap-1" role="group" aria-label="Log levels">
                                    {levelOptions.map((l) => {
                                        const on = selectedLevels.includes(l);
                                        const color = levelColor(l) ?? "#6b6b6b";
                                        return (
                                            <button
                                                key={l}
                                                type="button"
                                                aria-pressed={on}
                                                onClick={() => toggleLevel(l)}
                                                className={cn(
                                                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
                                                    on
                                                        ? "border-transparent text-foreground"
                                                        : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                                                )}
                                                style={on ? { background: `color-mix(in oklab, ${color} 22%, transparent)`, borderColor: color } : undefined}
                                                title={`${(summary.levels?.[l] ?? 0).toLocaleString()} lines`}
                                            >
                                                <span className="size-2 rounded-full" style={{ background: color }} />
                                                {l}
                                            </button>
                                        );
                                    })}
                                </div>

                                {levelOptions.length > 0 && fieldFilters.length > 0 && (
                                    <Separator orientation="vertical" className="hidden h-5! sm:block" />
                                )}

                                {/* Other fields of the format: domain, thread, ... */}
                                {fieldFilters.map((f) => (
                                    <SearchableMultiSelect
                                        key={f.name}
                                        options={f.values}
                                        selected={selectedFields[f.name] ?? []}
                                        onChange={(v) => setSelectedFields((s) => ({ ...s, [f.name]: v }))}
                                        label={plural(f.label)}
                                        icon={FIELD_ICONS[f.name] ?? <ListFilter className="size-3.5" />}
                                        triggerClassName="h-7 w-auto gap-1 rounded-full px-3 text-xs font-medium"
                                    />
                                ))}

                                {/* Keywords: tag input */}
                                <div className="flex h-7 min-w-56 flex-1 items-center gap-1 rounded-full border bg-background pl-2.5 pr-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
                                    <Tag className="size-3.5 shrink-0 text-muted-foreground" />
                                    {selectedKeywords.map((kw) => (
                                        <span
                                            key={kw}
                                            className="inline-flex max-w-40 shrink-0 items-center gap-0.5 rounded-full bg-secondary py-0.5 pl-2 pr-0.5 text-xs"
                                        >
                                            <span className="truncate">{kw}</span>
                                            <button
                                                type="button"
                                                aria-label={`Remove keyword ${kw}`}
                                                onClick={() => setSelectedKeywords((s) => s.filter((x) => x !== kw))}
                                                className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                                            >
                                                <X className="size-3" />
                                            </button>
                                        </span>
                                    ))}
                                    <input
                                        value={newKeyword}
                                        onChange={(e) => setNewKeyword(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter" || e.key === ",") {
                                                e.preventDefault();
                                                addKeyword();
                                            } else if (e.key === "Backspace" && !newKeyword && selectedKeywords.length) {
                                                setSelectedKeywords((s) => s.slice(0, -1));
                                            }
                                        }}
                                        onBlur={addKeyword}
                                        placeholder={selectedKeywords.length ? "" : "Keywords (Enter to add)"}
                                        aria-label="Add keyword"
                                        className="h-full min-w-20 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                                    />
                                </div>

                                {hasFilter && (
                                    <Button variant="ghost" size="sm" className="h-7 rounded-full px-2.5 text-xs" onClick={clearFilters}>
                                        <X className="size-3.5" />
                                        Clear
                                    </Button>
                                )}

                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="ml-auto size-7 rounded-full"
                                    onClick={() => setFilterOpen(false)}
                                    title="Hide filters (Ctrl+↑)"
                                    aria-label="Hide filters"
                                >
                                    <ChevronUp className="size-4" />
                                </Button>
                            </div>
                        </div>
                    </div>

                    {/* LogViewer */}
                    <div className="min-h-0 flex-1">
                        <LogViewer
                            baseUrl={baseUrl}
                            sessionId={sessionId}
                            filterParams={filterParams}
                            columns={summary.format.columns}
                            hiddenColumns={hiddenColumns}
                            columnWidths={columnWidths}
                            context={contextLines}
                            showDelta={showDelta}
                            showMinimap={showMinimap}
                            minimapAxis={minimapAxis}
                            minimapColor={effectiveMinimapColor}
                            lanesField={showLanes && lanesFieldDef ? lanesFieldDef : null}
                            searchOpen={searchOpen}
                            onSearchOpenChange={setSearchOpen}
                            statusStart={
                                !filterOpen && (
                                    <FilterSummary
                                        levels={selectedLevels}
                                        fields={fieldFilters
                                            .map((f) => ({ label: f.label, count: selectedFields[f.name]?.length ?? 0 }))
                                            .filter((f) => f.count > 0)}
                                        keywords={selectedKeywords}
                                        onOpen={() => setFilterOpen(true)}
                                        onClear={hasFilter ? clearFilters : undefined}
                                    />
                                )
                            }
                        />
                    </div>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
};

/** The active filters, small, in the status bar while the filter panel is hidden; click to show the panel */
function FilterSummary({
    levels,
    fields,
    keywords,
    onOpen,
    onClear,
}: {
    levels: string[];
    fields: { label: string; count: number }[];
    keywords: string[];
    onOpen: () => void;
    onClear?: () => void;
}) {
    const active = levels.length + fields.length + keywords.length > 0;
    return (
        <div className="flex min-w-0 max-w-[60%] shrink items-center gap-0.5">
            {/* the sidebar is a drawer on small screens */}
            <SidebarTrigger className="size-5 md:hidden" />
            <button
                type="button"
                onClick={onOpen}
                title="Show filters (Ctrl+↓)"
                className={cn(
                    "inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-accent",
                    active ? "text-foreground" : "text-muted-foreground"
                )}
            >
                <Filter className="size-3 shrink-0" />
                <span className="shrink-0 font-medium">{active ? "Filtered:" : "Filter"}</span>
                {levels.map((l) => (
                    <span key={l} className="inline-flex shrink-0 items-center gap-1">
                        <span className="size-1.5 rounded-full" style={{ background: levelColor(l) ?? "#6b6b6b" }} />
                        {l}
                    </span>
                ))}
                {fields.map((f) => (
                    <span key={f.label} className="shrink-0 text-muted-foreground">
                        {f.count} {(f.count === 1 ? f.label : plural(f.label)).toLowerCase()}
                    </span>
                ))}
                {keywords.length > 0 && (
                    <span className="truncate text-muted-foreground">{keywords.map((k) => `"${k}"`).join(" ")}</span>
                )}
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </button>
            {onClear && (
                <button
                    type="button"
                    onClick={onClear}
                    title="Clear filters"
                    aria-label="Clear filters"
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                    <X className="size-3" />
                </button>
            )}
            <span className="ml-1 text-muted-foreground/50">·</span>
        </div>
    );
}
