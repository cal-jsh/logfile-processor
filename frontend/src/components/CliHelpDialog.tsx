import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { copyText } from "../lib/bugReport";
import { cliHelp, type CliHelp } from "../lib/platform";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** A copy button that confirms for two seconds. */
function CopyButton({ text, label, className }: { text: string | null; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      className={`h-7 gap-1.5 bg-background px-2 text-xs ${className ?? ""}`}
      disabled={!text}
      onClick={() =>
        text &&
        copyText(text).then(
          () => setState("copied"),
          () => setState("failed")
        )
      }
    >
      {state === "copied" ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </Button>
  );
}

/** The command line options (the `--help` text, from Rust, so the two never differ). */
export default function CliHelpDialog({ open, onOpenChange }: Props) {
  const [help, setHelp] = useState<CliHelp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || help) return;
    cliHelp().then(setHelp, (e) => setError(`Could not load the help text: ${e}`));
  }, [open, help]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Command line</DialogTitle>
          <DialogDescription>
            Filter a log file by keyword, domain and level from a terminal or a script, without opening a window,
            and save the rows as text or CSV. The rows are the same as this window shows and exports for that
            filter. This is the text <code className="font-mono">logfile_processor_cli --help</code> prints.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">Program</span>
          <code
            aria-label="Path of the command line program"
            className="min-w-0 flex-1 truncate font-mono select-text"
            title={help?.cli_path ?? undefined}
          >
            {help ? (help.cli_path ?? "logfile_processor_cli was not found next to this app") : "…"}
          </code>
          <CopyButton text={help?.cli_path ?? null} label="Copy the program path" />
        </div>

        <div className="relative min-w-0">
          <pre
            aria-label="Command line help"
            className="max-h-[55vh] min-h-24 overflow-auto rounded-md border bg-muted/50 p-3 pr-24 font-mono text-xs leading-relaxed whitespace-pre select-text"
          >
            {error ?? help?.usage ?? "Loading…"}
          </pre>
          <CopyButton text={help?.usage ?? null} label="Copy the help text" className="absolute top-2 right-2" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
