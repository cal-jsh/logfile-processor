import { useCallback, useEffect, useRef, useState } from "react";
import type { LogSummary } from "./lib/logSummary";
import { Dashboard } from "./pages/Dashboard";
import {
    getApiBase,
    initialFile,
    openLogDialog,
    openLogPath,
    type OpenedLog,
} from "./lib/platform";

// shadcn/ui components
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
    Item,
    ItemActions,
    ItemContent,
    ItemDescription,
    ItemTitle,
} from "@/components/ui/item"

export default function App() {
    const [baseUrl, setBaseUrl] = useState<string | null>(null);
    const [summary, setSummary] = useState<LogSummary | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [filePath, setFilePath] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Read by the drop handler, which outlives renders
    const current = useRef<{ baseUrl: string | null; sessionId: string | null }>({ baseUrl: null, sessionId: null });
    current.current = { baseUrl, sessionId };

    // The in-process API on a random localhost port
    useEffect(() => {
        getApiBase()
            .then(setBaseUrl)
            .catch((e) => setError(`Backend not available: ${e}`));
    }, []);

    const showOpened = (opened: OpenedLog) => {
        console.log("Opened log:", opened);
        // Replacing an open file (dropped onto the window): release the old one
        const { baseUrl: base, sessionId: old } = current.current;
        if (base && old && old !== opened.session_id) {
            fetch(`${base}/close_session?session_id=${encodeURIComponent(old)}`, { method: "POST" }).catch(() => {});
        }
        setSessionId(opened.session_id);
        setSummary(opened.summary);
        setFilePath(opened.path);
        setError(null);
    };

    /* ---------------- Open in place by path ---------------- */
    const openWith = useCallback(async (open: () => Promise<OpenedLog | null>) => {
        setBusy(true);
        try {
            const opened = await open();
            if (opened) showOpened(opened);
        } catch (err: any) {
            // The start page shows errors inline; over an open file, keep it and say so
            if (current.current.sessionId) window.alert(String(err));
            else setError(String(err));
            console.error(err);
        } finally {
            setBusy(false);
        }
    }, []);

    // A file passed on the command line, or dropped onto the exe icon
    useEffect(() => {
        initialFile()
            .then((p) => {
                if (p) openWith(() => openLogPath(p));
            })
            .catch((e) => setError(String(e)));
    }, [openWith]);

    // Drag and drop a file onto the window, also while one is open (it is replaced)
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let cancelled = false;
        import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
            getCurrentWebview()
                .onDragDropEvent((e) => {
                    if (e.payload.type === "drop" && e.payload.paths.length > 0) {
                        const p = e.payload.paths[0];
                        openWith(() => openLogPath(p));
                    }
                })
                .then((u) => (cancelled ? u() : (unlisten = u)))
        );
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [openWith]);

    /** Close the current file and go back to the start page. */
    const closeFile = () => {
        if (baseUrl && sessionId) {
            fetch(`${baseUrl}/close_session?session_id=${encodeURIComponent(sessionId)}`, {
                method: "POST",
            }).catch(() => {});
        }
        setSessionId(null);
        setSummary(null);
        setFilePath(null);
    };

    if (summary && sessionId && baseUrl) {
        return (
            <Dashboard
                // remount for each file
                key={sessionId}
                sessionId={sessionId}
                baseUrl={baseUrl}
                summary={summary}
                fileName={filePath ?? undefined}
                onClose={closeFile}
            />
        );
    }

    return (
        <div className="flex flex-col gap-6"
            style={{
                height: "100vh",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
            }}
        >
            <Item variant="outline">
                <ItemContent>
                    <ItemTitle>Open a log file</ItemTitle>
                    <ItemDescription>
                        Choose a local log file, or drop it on this window. It is read in place, not copied.
                    </ItemDescription>
                </ItemContent>
                <ItemActions>
                    <Button disabled={busy || !baseUrl} onClick={() => openWith(openLogDialog)}>
                        Open file…
                    </Button>
                </ItemActions>
            </Item>

            {busy && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> Indexing…
                </p>
            )}
            {error && <p style={{ color: "red" }}>{error}</p>}
        </div>
    );
}
