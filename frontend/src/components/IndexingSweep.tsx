/**
 * A soft band that sweeps across its parent while the file is still being indexed: a
 * quiet "not ready yet" instead of a spinner over everything. The parent must be
 * `relative overflow-hidden`. Still (no motion) when the user prefers reduced motion.
 */
export function IndexingSweep({ tone = "light" }: { tone?: "light" | "dark" }) {
  const via = tone === "light" ? "via-log-ink/20" : "via-foreground/20";
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-linear-to-r from-transparent ${via} to-transparent motion-safe:animate-indexing`}
    />
  );
}
