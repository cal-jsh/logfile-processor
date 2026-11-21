import { useEffect, useRef, useState } from "react";
import { CircleCheck, Download, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import {
  checkForUpdate,
  currentVersion,
  describeUpdateError,
  downloadUpdate,
  installUpdate,
  openReleasePage,
  rememberCheck,
  type Update,
} from "../lib/updater";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after each check, so the sidebar button can show whether an update waits */
  onChecked: (update: Update | null) => void;
}

type State =
  | { step: "checking" }
  | { step: "current" }
  | { step: "available"; update: Update }
  | { step: "downloading"; update: Update; downloaded: number; total: number | null }
  | { step: "installing"; update: Update }
  | { step: "error"; message: string; update: Update | null };

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Checks GitHub for a newer release, shows its notes, downloads it (with progress and a
    signature check) and installs it, which restarts the app. */
export default function UpdateDialog({ open, onOpenChange, onChecked }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<State>({ step: "checking" });
  const [linkError, setLinkError] = useState<string | null>(null);
  const busy = state.step === "downloading" || state.step === "installing";
  const onCheckedRef = useRef(onChecked);
  onCheckedRef.current = onChecked;

  const runCheck = () => {
    setState({ step: "checking" });
    setLinkError(null);
    checkForUpdate().then(
      (update) => {
        rememberCheck(update);
        onCheckedRef.current(update);
        setState(update ? { step: "available", update } : { step: "current" });
      },
      (e) => setState({ step: "error", message: describeUpdateError(e), update: null })
    );
  };

  useEffect(() => {
    if (!open) return;
    currentVersion().then(setVersion, () => setVersion(null));
    // Don't start over while a download from an earlier opening still runs
    if (!busy) runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const install = async (update: Update) => {
    setState({ step: "downloading", update, downloaded: 0, total: null });
    try {
      await downloadUpdate(update, (downloaded, total) =>
        setState({ step: "downloading", update, downloaded, total })
      );
      setState({ step: "installing", update });
      // Windows: the app exits here and the installer starts the new version.
      // Linux: the AppImage is replaced or the .deb installed, then the app restarts.
      await installUpdate(update);
    } catch (e) {
      setState({ step: "error", message: describeUpdateError(e), update });
    }
  };

  const update = "update" in state ? state.update : null;
  const notes = update?.body?.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Update</DialogTitle>
          <DialogDescription>
            This is version <span className="font-mono text-foreground">{version ?? "…"}</span>. Updates come
            from the project's published GitHub releases, and the installer is only run if its signature matches
            the key built into this app.
          </DialogDescription>
        </DialogHeader>

        <div aria-live="polite" className="flex min-h-10 items-start gap-2 text-sm">
          {state.step === "checking" && (
            <>
              <Spinner className="mt-0.5" />
              <span>Checking for updates…</span>
            </>
          )}
          {state.step === "current" && (
            <>
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-600" />
              <span>You have the newest version.</span>
            </>
          )}
          {update && state.step !== "error" && (
            <>
              <Download className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>
                Version <span className="font-mono font-medium">{update.version}</span> is available
                {update.date && <> (released {new Date(update.date.replace(" ", "T")).toLocaleDateString()})</>}.
              </span>
            </>
          )}
          {state.step === "error" && (
            <>
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span className="min-w-0 break-words">{state.message}</span>
            </>
          )}
        </div>

        {update && (
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Release notes</div>
            <pre
              aria-label="Release notes"
              className="max-h-48 min-h-12 overflow-auto rounded-md border bg-muted/50 p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap break-words select-text"
            >
              {notes || "No notes for this release."}
            </pre>
          </div>
        )}

        {state.step === "downloading" && (
          <div className="space-y-1">
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={state.total ?? undefined}
              aria-valuenow={state.downloaded}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width]"
                style={{
                  width: state.total ? `${Math.min(100, (state.downloaded / state.total) * 100)}%` : "100%",
                  opacity: state.total ? 1 : 0.4,
                }}
              />
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              Downloading {mb(state.downloaded)}
              {state.total ? ` of ${mb(state.total)}` : ""}…
            </div>
          </div>
        )}
        {state.step === "installing" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            Signature checked. Starting the installer; the app closes and opens again when it is done.
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            {update && (
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 text-xs"
                onClick={() =>
                  openReleasePage(update.version).catch((e) => setLinkError(`Could not open the browser: ${e}`))
                }
              >
                <ExternalLink />
                Release on GitHub
              </Button>
            )}
            {linkError && <span className="text-xs text-destructive">{linkError}</span>}
          </div>
          <div className="flex gap-2">
            {(state.step === "current" || (state.step === "error" && !state.update)) && (
              <Button variant="outline" onClick={runCheck}>
                <RefreshCw />
                Check again
              </Button>
            )}
            {(state.step === "available" || (state.step === "error" && state.update)) && update && (
              <Button onClick={() => install(update)} title="Other windows of the app close too">
                <Download />
                {state.step === "error" ? "Try again" : "Download and restart"}
              </Button>
            )}
            {busy && (
              <Button disabled>
                <Spinner />
                {state.step === "downloading" ? "Downloading…" : "Installing…"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
