export const LEVEL_ORDER = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"] as const;

export const colorMap: Record<string, string> = {
  TRACE: "#888",
  DEBUG: "#94bbc8ff",
  INFO: "#8cc644ff",
  WARN: "orange",
  ERROR: "red",
  CRITICAL: "#e040fb",
};

export type LogLevel = (typeof LEVEL_ORDER)[number];

/** The known level a level name stands for, like the backend's `level_code`: spdlog's
    "info", "warning", "critical" and one-letter names map to the six known levels.
    CRITICAL (and FATAL) is its own level above ERROR, as in the level filter. */
export function canonicalLevel(name: string | undefined | null): LogLevel | null {
  switch ((name ?? "").trim().toUpperCase()) {
    case "CRITICAL": case "CRIT": case "FATAL": case "C": case "F":
      return "CRITICAL";
    case "ERROR": case "ERR": case "SEVERE": case "E":
      return "ERROR";
    case "WARN": case "WARNING": case "W":
      return "WARN";
    case "INFO": case "NOTICE": case "I":
      return "INFO";
    case "DEBUG": case "DBG": case "D":
      return "DEBUG";
    case "TRACE": case "VERBOSE": case "T": case "V":
      return "TRACE";
    default:
      return null;
  }
}

/** Color of any level name, or undefined for an unknown one. */
export function levelColor(name: string | undefined | null): string | undefined {
  const l = canonicalLevel(name);
  return l ? colorMap[l] : undefined;
}

/** Severity rank for sorting level names (unknown ones last). */
export function levelRank(name: string): number {
  const l = canonicalLevel(name);
  return l ? LEVEL_ORDER.indexOf(l) : LEVEL_ORDER.length;
}

/** Colours for groups of a field (e.g. top-level domains) in the minimap, picked to be
    told apart on the dark background and from each other. */
export const GROUP_PALETTE = [
  "#4e9be6", // blue
  "#f28e2b", // orange
  "#59a14f", // green
  "#e15759", // red
  "#b07aa1", // purple
  "#edc948", // yellow
  "#76b7b2", // teal
  "#ff9da7", // pink
  "#9c755f", // brown
  "#a0cbe8", // light blue
  "#8cd17d", // light green
  "#d4a6c8", // light purple
] as const;

/** Colour of the groups outside the coloured ones ("other") */
export const OTHER_GROUP_COLOR = "#6b6b6b";

/** A colour per group name, by rank: `names` is most common first (as the backend sends
    them, by line count and then name, so the same file always gets the same colours), and
    the palette is ordered so the largest groups get the most distinct colours. */
export function groupColors(names: string[]): string[] {
  return names.map((_, i) => GROUP_PALETTE[i] ?? OTHER_GROUP_COLOR);
}
