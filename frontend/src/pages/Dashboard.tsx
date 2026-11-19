import { useEffect, useState } from "react";
import { LogViewer } from "../components/LogViewer";
import type { LogSummary } from "../../openapi/client/models/LogSummary";
import SearchableMultiSelect from "../components/SearchableMultiSelect";
import LogSummarySidebar from "../components/LogSummarySidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { colorMap, LEVEL_ORDER } from "../lib/colorMap";
import { Filter, Layers, Tag, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface DashboardProps {
    sessionId: string;
    baseUrl: string; // e.g. "http://localhost:8080"
    summary: LogSummary;
    /** Path (desktop) or name (web) of the open file */
    fileName?: string;
    /** Close this file and go back to the start page */
    onClose?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ sessionId, baseUrl, summary, fileName, onClose }) => {
    const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
    const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
    const [selectedKeywords, setSelectedKeywords] = useState<string[]>([]);
    const [newKeyword, setNewKeyword] = useState<string>("");

    const [contextLines, setContextLines] = useState<number>(0);

    const [debouncedLevels, setDebouncedLevels] = useState<string>("");
    const [debouncedDomains, setDebouncedDomains] = useState<string>("");
    const [debouncedKeywords, setDebouncedKeywords] = useState<string>("");

    const [showDelta, setShowDelta] = useState(false); // controls delta display
    const [searchOpen, setSearchOpen] = useState(false); // floating search panel

    // Debounce filters
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedLevels(selectedLevels.join(","));
            setDebouncedDomains(selectedDomains.join(","));
            setDebouncedKeywords(selectedKeywords.join(","));
        }, 300);
        return () => clearTimeout(timer);
    }, [selectedLevels, selectedDomains, selectedKeywords]);

    // levels in the file, in severity order (unknown ones last)
    const fileLevels = Object.keys(summary.levels || {});
    const levelOptions = [
        ...LEVEL_ORDER.filter((l) => fileLevels.includes(l)),
        ...fileLevels.filter((l) => !(LEVEL_ORDER as readonly string[]).includes(l)),
    ];
    const domainOptions = summary.unique_domains || [];

    const levelsParam = debouncedLevels ? `&levels=${encodeURIComponent(debouncedLevels)}` : "";
    const domainsParam = debouncedDomains ? `&domains=${encodeURIComponent(debouncedDomains)}` : "";
    const keywordsParam = debouncedKeywords ? `&keywords=${encodeURIComponent(debouncedKeywords)}` : "";

    // Changing the filter triggers one scan on the backend; changing the context
    // reuses its result (the backend keeps match line numbers, not text).
    const filterParams = `${levelsParam}${domainsParam}${keywordsParam}`;

    const toggleLevel = (l: string) =>
        setSelectedLevels((s) => (s.includes(l) ? s.filter((x) => x !== l) : [...s, l]));

    const addKeyword = () => {
        const val = newKeyword.trim();
        if (val && !selectedKeywords.includes(val)) setSelectedKeywords((s) => [...s, val]);
        setNewKeyword("");
    };

    const hasFilter = selectedLevels.length + selectedDomains.length + selectedKeywords.length > 0;
    const clearFilters = () => {
        setSelectedLevels([]);
        setSelectedDomains([]);
        setSelectedKeywords([]);
        setNewKeyword("");
    };

    // Cleanup session on exit
    useEffect(() => {
        const cleanupSession = () => {
            const url = `${baseUrl}/close_session?session_id=${encodeURIComponent(sessionId)}`;
            navigator.sendBeacon(url);
        };

        window.addEventListener("beforeunload", cleanupSession);
        window.addEventListener("unload", cleanupSession);

        return () => {
            window.removeEventListener("beforeunload", cleanupSession);
            window.removeEventListener("unload", cleanupSession);
        };
    }, [sessionId, baseUrl]);

    return (
        <SidebarProvider defaultOpen={true}>
            <LogSummarySidebar
                summary={summary}
                fileName={fileName}
                onOpenAnother={onClose}
                searchOpen={searchOpen}
                onToggleSearch={() => setSearchOpen((o) => !o)}
                showDelta={showDelta}
                setShowDelta={setShowDelta}
                contextLines={contextLines}
                setContextLines={setContextLines}
            />

            <SidebarInset className="h-svh min-w-0 overflow-hidden">
                <div className="flex h-full min-h-0 flex-col gap-2 p-3">
                    {/* Filter bar */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-2 py-1.5 shadow-xs">
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
                                const color = colorMap[l] ?? "currentColor";
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

                        <Separator orientation="vertical" className="hidden h-5! sm:block" />

                        {/* Domains */}
                        <SearchableMultiSelect
                            options={domainOptions}
                            selected={selectedDomains}
                            onChange={setSelectedDomains}
                            label="Domains"
                            icon={<Layers className="size-3.5" />}
                            triggerClassName="h-7 w-auto gap-1 rounded-full px-3 text-xs font-medium"
                        />

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
                    </div>

                    {/* LogViewer */}
                    <div className="min-h-0 flex-1">
                        <LogViewer
                            baseUrl={baseUrl}
                            sessionId={sessionId}
                            filterParams={filterParams}
                            context={contextLines}
                            showDelta={showDelta}
                            searchOpen={searchOpen}
                            onSearchOpenChange={setSearchOpen}
                        />
                    </div>
                </div>
            </SidebarInset>
        </SidebarProvider>
    );
};
