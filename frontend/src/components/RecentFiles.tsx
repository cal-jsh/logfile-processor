import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openedAgo, splitPath, type RecentFile } from "@/lib/recentFiles";

interface RecentFilesProps {
    files: RecentFile[];
    /** Paths that are not there any more (deleted, moved, share offline) */
    missing: Set<string>;
    disabled?: boolean;
    onOpen: (path: string) => void;
    onRemove: (path: string) => void;
    onClear: () => void;
}

/** The recently opened log files on the start page; a click opens one again. */
export function RecentFiles({ files, missing, disabled, onOpen, onRemove, onClear }: RecentFilesProps) {
    if (files.length === 0) return null;
    return (
        <section className="w-full max-w-xl" aria-labelledby="recent-files-title">
            <div className="mb-1 flex items-center justify-between px-1">
                <h2 id="recent-files-title" className="text-sm font-medium text-muted-foreground">
                    Recently opened
                </h2>
                <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onClear}>
                    Clear list
                </Button>
            </div>
            <ul className="flex flex-col rounded-md border">
                {files.map((f) => {
                    const { name, dir } = splitPath(f.path);
                    const gone = missing.has(f.path);
                    return (
                        <li key={f.path} className="group flex items-center border-b last:border-b-0">
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => onOpen(f.path)}
                                title={gone ? `File not found: ${f.path}` : f.path}
                                className={cn(
                                    "flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left outline-none",
                                    "hover:bg-accent/60 focus-visible:bg-accent/60 disabled:pointer-events-none",
                                    gone && "opacity-60"
                                )}
                            >
                                <FileText className="size-4 shrink-0 text-muted-foreground" />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className={cn("truncate text-sm font-medium", gone && "line-through")}>
                                        {name}
                                    </span>
                                    <span className="truncate text-xs text-muted-foreground">{dir}</span>
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {gone ? <span className="text-destructive">File not found</span> : openedAgo(f.openedAt)}
                                </span>
                            </button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="mr-1 size-7 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                aria-label={`Remove ${name} from the list`}
                                title="Remove from list"
                                onClick={() => onRemove(f.path)}
                            >
                                <X className="size-4" />
                            </Button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
