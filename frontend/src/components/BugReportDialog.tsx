import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { copyText, gatherBugReportInfo, ISSUES_URL, openIssues } from "../lib/bugReport";
import { isDesktop } from "../lib/platform";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Version and environment info to paste into a GitHub issue, plus a link to the issues page. */
export default function BugReportDialog({ open, onOpenChange }: Props) {
  const [info, setInfo] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [linkError, setLinkError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCopy("idle");
    setLinkError(null);
    gatherBugReportInfo()
      .then((text) => !cancelled && setInfo(text))
      .catch((e) => !cancelled && setInfo(`Could not gather version info: ${e}`));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (copy === "idle") return;
    const t = setTimeout(() => setCopy("idle"), 2000);
    return () => clearTimeout(t);
  }, [copy]);

  const onCopy = () => {
    if (!info) return;
    copyText(info).then(
      () => setCopy("copied"),
      () => setCopy("failed")
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription>
            Open an issue on GitHub and paste the details below into it, together with what you did and what
            went wrong.
          </DialogDescription>
        </DialogHeader>

        <div className="relative min-w-0">
          <pre
            aria-label="Version information"
            className="max-h-64 min-h-24 overflow-auto rounded-md border bg-muted/50 p-3 pr-24 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all select-text"
          >
            {info ?? "Gathering version info…"}
          </pre>
          <Button
            variant="outline"
            size="sm"
            className="absolute top-2 right-2 h-7 gap-1.5 bg-background px-2 text-xs"
            disabled={!info}
            onClick={onCopy}
          >
            {copy === "copied" ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
            {copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy"}
          </Button>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-destructive">{linkError}</span>
          {isDesktop ? (
            <Button
              onClick={() =>
                openIssues().catch((e) => setLinkError(`Could not open the browser: ${e}`))
              }
            >
              <ExternalLink />
              Open GitHub issues
            </Button>
          ) : (
            <Button asChild>
              <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Open GitHub issues
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
