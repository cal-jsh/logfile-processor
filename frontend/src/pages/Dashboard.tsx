import { useEffect, useMemo, useRef, useState } from "react";
import { LogViewer } from "../components/LogViewer";
import type { LogSummary } from "../lib/logSummary";
import SearchableMultiSelect from "../components/SearchableMultiSelect";
import LogSummarySidebar from "../components/LogSummarySidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { levelColor, levelRank } from "../lib/colorMap";
import { ChevronDown, ChevronUp, Clock, Filter, GitBranch, Layers, ListFilter, Regex, Tag, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MinimapAxis } from "../components/Minimap";
import { formatDuration, formatRangeTime, RANGE_COLOR, type TimeRange } from "../components/TimeRangeSelect";
import { RegexToggle } from "../components/RegexToggle";
import { useTheme } from "../lib/theme";

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

/** A keyword, or a regular expression (Rust regex syntax), of the filter bar */
type SearchTerm = { text: string; regex: boolean };

/** Why `pattern` is not a valid regular expression (several lines, the spot marked), or null. */
async function checkRegex(baseUrl: string, pattern: string, signal?: AbortSignal): Promise<string | null> {
    const r = await fetch(`${baseUrl}/regex/check?pattern=${encodeURIComponent(pattern)}`, { signal });
    if (!r.ok) throw new Error(String(r.status));
    return ((await r.json()) as { error: string | null }).error;
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl, summary, fileName, onClose, onChangeFormat }) => {
    // the level colours (sidebar, filter bar) follow the theme: render again when it changes
    useTheme();
    const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
    // values per filterable field (domain, thread, ...): none selected = all
    const [selectedFields, setSelectedFields] = useState<Record<string, string[]>>({});
    // keywords and regular expressions; a line matches if its message has any of them
    const [selectedTerms, setSelectedTerms] = useState<SearchTerm[]>([]);
    const [newKeyword, setNewKeyword] = useState<string>("");
    // what the input adds: a keyword, or a regular expression (".*" switch, Alt+R)
    const [regexMode, setRegexModeState] = useState<boolean>(() => {
        try {
            return localStorage.getItem("logviewer.keywordRegex") === "true";
        } catch {
            return false;
        }
    });
    const setRegexMode = (on: boolean) => {
        setRegexModeState(on);
        try {
            localStorage.setItem("logviewer.keywordRegex", String(on));
        } catch {
            /* not stored */
        }
    };
    // why the regular expression being typed does not compile (checked by the backend)
    const [regexError, setRegexError] = useState<string | null>(null);
    // the error is shown under the keyword field
    const termsRef = useRef<HTMLDivElement>(null);
    const termsRect = regexError ? termsRef.current?.getBoundingClientRect() : undefined;
    const errorAt: React.CSSProperties | undefined = termsRect && { left: termsRect.left + 20, top: termsRect.bottom + 6 };
    // time range filter (ms, log clock, `to` excluded): set by dragging on the minimap or
    // the thread lanes, or typed in Go to; applied at once (no debounce, it comes from a drag)
    const [timeRange, setTimeRange] = useState<TimeRange | null>(null);

    const [contextLines, setContextLines] = useState<number>(0);

    const [debouncedLevels, setDebouncedLevels] = useState<string>("");
    const [debouncedFields, setDebouncedFields] = useState<string>("");
    const [debouncedKeywords, setDebouncedKeywords] = useState<string>("");
    const [debouncedPatterns, setDebouncedPatterns] = useState<string>("");

    const [showDelta, setShowDelta] = useStoredFlag("logviewer.showDelta", false); // controls delta display
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
            setDebouncedKeywords(selectedTerms.filter((t) => !t.regex).map((t) => t.text).join(","));
            const patterns = selectedTerms.filter((t) => t.regex).map((t) => t.text);
            setDebouncedPatterns(patterns.length ? JSON.stringify(patterns) : "");
        }, 300);
        return () => clearTimeout(timer);
    }, [selectedLevels, selectedFields, selectedTerms]);

    // check the regular expression while it is typed
    useEffect(() => {
        const pattern = newKeyword.trim();
        if (!regexMode || !pattern) {
            setRegexError(null);
            return;
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => {
            checkRegex(baseUrl, pattern, ctrl.signal)
                .then(setRegexError)
                .catch(() => { });
        }, 150);
        return () => {
            clearTimeout(t);
            ctrl.abort();
        };
    }, [newKeyword, regexMode, baseUrl]);

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
    const regexParam = debouncedPatterns ? `&regex=${encodeURIComponent(debouncedPatterns)}` : "";
    const timeParam = timeRange ? `&time_from=${timeRange.from}&time_to=${timeRange.to}` : "";
    const timeSpan = useMemo(
        () => (summary.start_ms != null && summary.stop_ms != null ? { start: Math.min(summary.start_ms, summary.stop_ms), end: Math.max(summary.start_ms, summary.stop_ms) } : null),
        [summary]
    );

    // Changing the filter triggers one scan on the backend; changing the context
    // reuses its result (the backend keeps match line numbers, not text).
    const filterParams = `${levelsParam}${fieldsParam}${keywordsParam}${regexParam}${timeParam}`;

    const toggleLevel = (l: string) =>
        setSelectedLevels((s) => (s.includes(l) ? s.filter((x) => x !== l) : [...s, l]));

    const addKeyword = async () => {
        const val = newKeyword.trim();
        if (!val) return setNewKeyword("");
        const term: SearchTerm = { text: val, regex: regexMode };
        if (regexMode) {
            // a pattern that does not compile stays in the input, with the reason below it
            const err = await checkRegex(baseUrl, val).catch(() => null);
            setRegexError(err);
            if (err) return;
        }
        setSelectedTerms((s) => (s.some((t) => t.text === term.text && t.regex === term.regex) ? s : [...s, term]));
        setNewKeyword("");
    };

    const fieldCount = Object.values(selectedFields).reduce((a, v) => a + v.length, 0);
    const hasFilter = selectedLevels.length + fieldCount + selectedTerms.length > 0 || timeRange != null;
    const clearFilters = () => {
        setSelectedLevels([]);
        setSelectedFields({});
        setSelectedTerms([]);
        setNewKeyword("");
        setTimeRange(null);
    };
    // the minimap's time scale is where ranges are dragged: show it
    const showTimeScale = () => {
        setShowMinimap(true);
        setMinimapAxis("time");
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

                                {/* Keywords and regular expressions: tag input */}
                                <div
                                    ref={termsRef}
                                    className={cn(
                                        "flex h-7 min-w-56 flex-1 items-center gap-1 rounded-full border bg-background pl-2.5 pr-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
                                        regexError && "border-destructive focus-within:border-destructive focus-within:ring-destructive/25"
                                    )}
                                >
                                    {regexMode ? (
                                        <Regex className="size-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                        <Tag className="size-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    {/* chips shrink (and the row clips) before the switch moves */}
                                    <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
                                        {selectedTerms.map((t) => (
                                            <span
                                                key={(t.regex ? "re:" : "kw:") + t.text}
                                                title={t.regex ? `Regular expression: ${t.text}` : `Keyword: ${t.text}`}
                                                className={cn(
                                                    "inline-flex min-w-14 max-w-48 items-center gap-0.5 rounded-full py-0.5 pl-2 pr-0.5 text-xs",
                                                    t.regex ? "term-regex font-mono text-[11px]" : "bg-secondary"
                                                )}
                                            >
                                                <span className="truncate">
                                                    {t.regex ? (
                                                        <>
                                                            <span className="opacity-50">/</span>
                                                            {t.text}
                                                            <span className="opacity-50">/</span>
                                                        </>
                                                    ) : (
                                                        t.text
                                                    )}
                                                </span>
                                                <button
                                                    type="button"
                                                    aria-label={`Remove ${t.regex ? "regular expression" : "keyword"} ${t.text}`}
                                                    onClick={() => setSelectedTerms((s) => s.filter((x) => x !== t))}
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
                                                // a comma ends a keyword, but is common inside a regex ({1,3})
                                                if (e.key === "Enter" || (e.key === "," && !regexMode)) {
                                                    e.preventDefault();
                                                    addKeyword();
                                                } else if (e.key === "Backspace" && !newKeyword && selectedTerms.length) {
                                                    setSelectedTerms((s) => s.slice(0, -1));
                                                } else if (e.key === "Escape" && regexError) {
                                                    setNewKeyword("");
                                                } else if (e.altKey && e.key.toLowerCase() === "r") {
                                                    e.preventDefault();
                                                    setRegexMode(!regexMode);
                                                }
                                            }}
                                            onBlur={addKeyword}
                                            placeholder={
                                                selectedTerms.length
                                                    ? ""
                                                    : regexMode
                                                        ? "Regular expression (Enter to add)"
                                                        : "Keywords (Enter to add)"
                                            }
                                            aria-label={regexMode ? "Add regular expression" : "Add keyword"}
                                            aria-invalid={!!regexError}
                                            spellCheck={false}
                                            className={cn(
                                                "h-full min-w-28 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground",
                                                regexMode && "font-mono text-[11px]"
                                            )}
                                        />
                                    </div>
                                    <RegexToggle on={regexMode} onChange={setRegexMode} className="rounded-full" />
                                    {/* fixed: the filter panel clips what overflows it */}
                                    {regexError && newKeyword.trim() && (
                                        <pre
                                            role="alert"
                                            style={errorAt}
                                            className="fixed z-50 max-w-[min(32rem,90vw)] overflow-x-auto rounded-md border border-destructive/40 bg-popover px-2.5 py-1.5 font-mono text-[11px] leading-snug whitespace-pre text-destructive shadow-md"
                                        >
                                            {regexError.replace(/^regex parse error:\n/, "")}
                                        </pre>
                                    )}
                                </div>

                                {/* Time range: set by dragging on the minimap's time scale */}
                                {timeSpan && (
                                    <TimeRangeChip
                                        range={timeRange}
                                        onClear={() => setTimeRange(null)}
                                        onPick={showTimeScale}
                                        timeScaleShown={showMinimap && minimapAxis === "time"}
                                    />
                                )}

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
                            timeSpan={timeSpan}
                            timeRange={timeRange}
                            onTimeRangeChange={setTimeRange}
                            statusStart={
                                !filterOpen && (
                                    <FilterSummary
                                        levels={selectedLevels}
                                        fields={fieldFilters
                                            .map((f) => ({ label: f.label, count: selectedFields[f.name]?.length ?? 0 }))
                                            .filter((f) => f.count > 0)}
                                        terms={selectedTerms}
                                        timeRange={timeRange}
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

/** The time range filter in the filter bar: the range with its length and a clear button;
    without a range, a quiet button that shows the minimap's time scale to drag on */
function TimeRangeChip({
    range,
    onClear,
    onPick,
    timeScaleShown,
}: {
    range: TimeRange | null;
    onClear: () => void;
    onPick: () => void;
    timeScaleShown: boolean;
}) {
    if (!range) {
        return (
            <button
                type="button"
                onClick={onPick}
                title={
                    timeScaleShown
                        ? "Drag on the minimap to filter a time range; or type one in Go to (Ctrl+G), e.g. 14:00 - 14:30"
                        : "Show the minimap by time, then drag on it to filter a time range"
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
                <Clock className="size-3.5" />
                Time range
            </button>
        );
    }
    return (
        <span
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border pl-2.5 pr-1 text-xs"
            style={{ borderColor: `color-mix(in oklab, ${RANGE_COLOR} 55%, var(--border))`, background: `color-mix(in oklab, ${RANGE_COLOR} 10%, transparent)` }}
            title="Time range filter: drag its edges on the minimap or the thread lanes to change it"
        >
            <Clock className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono tabular-nums">
                {formatRangeTime(range.from)} – {formatRangeTime(range.to, range.from)}
            </span>
            <span className="shrink-0 text-muted-foreground">{formatDuration(range.to - range.from)}</span>
            <button
                type="button"
                aria-label="Clear the time range"
                onClick={onClear}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            >
                <X className="size-3" />
            </button>
        </span>
    );
}

/** The active filters, small, in the status bar while the filter panel is hidden; click to show the panel */
function FilterSummary({
    levels,
    fields,
    terms,
    timeRange,
    onOpen,
    onClear,
}: {
    levels: string[];
    fields: { label: string; count: number }[];
    terms: SearchTerm[];
    timeRange: TimeRange | null;
    onOpen: () => void;
    onClear?: () => void;
}) {
    const active = levels.length + fields.length + terms.length > 0 || timeRange != null;
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
                {timeRange && (
                    <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums text-muted-foreground">
                        <Clock className="size-3" />
                        {formatRangeTime(timeRange.from)} – {formatRangeTime(timeRange.to, timeRange.from)}
                    </span>
                )}
                {terms.length > 0 && (
                    <span className="truncate text-muted-foreground">
                        {terms.map((t) => (t.regex ? `/${t.text}/` : `"${t.text}"`)).join(" ")}
                    </span>
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
