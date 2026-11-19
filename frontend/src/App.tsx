import { useCallback, useEffect, useState } from "react";
import { OpenAPI } from "../openapi/client/core/OpenAPI";
import { request as __request } from "../openapi/client/core/request";
import type { LogSummary } from "../openapi/client/models/LogSummary";
import { Dashboard } from "./pages/Dashboard";
import {
    getApiBase,
    initialFile,
    isDesktop,
    openLogDialog,
    openLogPath,
    type OpenedLog,
} from "./lib/platform";

// shadcn/ui components
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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

    // Web: the standalone backend. Desktop: the in-process API on a random port.
    useEffect(() => {
        getApiBase()
            .then((base) => {
                OpenAPI.BASE = base;
                setBaseUrl(base);
            })
            .catch((e) => setError(`Backend not available: ${e}`));
    }, []);

    const showOpened = (opened: OpenedLog) => {
        console.log("Opened log:", opened);
        setSessionId(opened.session_id);
        setSummary(opened.summary);
        setFilePath(opened.path ?? null);
        setError(null);
    };

    /* ---------------- Web: upload ---------------- */
    const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const formData = new FormData();
        formData.append("file", file);

        setBusy(true);
        try {
            const response = await __request(OpenAPI, {
                method: "POST",
                url: "/upload",
                body: formData,
            });
            showOpened({ ...(response as OpenedLog), path: file.name });
        } catch (err: any) {
            setError("Upload failed");
            console.error(err);
        } finally {
            setBusy(false);
        }
    };

    /* ---------------- Desktop: open in place by path ---------------- */
    const openWith = useCallback(async (open: () => Promise<OpenedLog | null>) => {
        setBusy(true);
        try {
            const opened = await open();
            if (opened) showOpened(opened);
        } catch (err: any) {
            setError(String(err));
            console.error(err);
        } finally {
            setBusy(false);
        }
    }, []);

    // A file passed on the command line ("Open with")
    useEffect(() => {
        if (!isDesktop) return;
        initialFile().then((p) => {
            if (p) openWith(() => openLogPath(p));
        });
    }, [openWith]);

    // Drag and drop a file onto the window
    useEffect(() => {
        if (!isDesktop || sessionId) return;
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
    }, [openWith, sessionId]);

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
                    <ItemTitle>{isDesktop ? "Open a log file" : "Logfile Upload"}</ItemTitle>
                    <ItemDescription>
                        {isDesktop
                            ? "Choose a local log file, or drop it on this window. It is read in place, not copied."
                            : "Please select the logfile you wish to analyze."}
                    </ItemDescription>
                </ItemContent>
                <ItemActions>
                    {isDesktop ? (
                        <Button disabled={busy || !baseUrl} onClick={() => openWith(openLogDialog)}>
                            Open file…
                        </Button>
                    ) : (
                        <Input id="logfile-upload" type="file" accept=".txt,.log" onChange={handleUpload} disabled={busy || !baseUrl} className="cursor-pointer border hover:bg-gray-100 transition-colors" />
                    )}
                </ItemActions>
            </Item>

            {busy && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Spinner /> {isDesktop ? "Indexing…" : "Uploading and indexing…"}
                </p>
            )}
            {error && <p style={{ color: "red" }}>{error}</p>}
        </div>
    );
}
