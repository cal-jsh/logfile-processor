export const LEVEL_ORDER = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"] as const;

/** Level colours for the dark log surface (#1e1e1e) */
const DARK_LEVELS: Record<string, string> = {
  TRACE: "#888",
  DEBUG: "#94bbc8ff",
  INFO: "#8cc644ff",
  WARN: "orange",
  ERROR: "red",
  CRITICAL: "#e040fb",
};

/** Level colours for the light log surface (warm paper, ink text): the same hues, deep
    enough to read as text on paper and to stand out as minimap bars */
const LIGHT_LEVELS: Record<string, string> = {
  TRACE: "#8c8279",
  DEBUG: "#3f7d96",
  INFO: "#4b8a1c",
  WARN: "#c26a00",
  ERROR: "#d3261b",
  CRITICAL: "#a72fc0",
};

/** Level colours of the theme in effect; `setPalette` swaps them (lib/theme.ts). Read
    them when drawing, not once at load. */
export const colorMap: Record<string, string> = { ...DARK_LEVELS };

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
const DARK_GROUPS = [
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
];

/** The same order for the light background: the pale ones (yellow, light blue, light
    green, pink) made deeper so they don't fade into the paper */
const LIGHT_GROUPS = [
  "#3a7fc8", // blue
  "#e97c12", // orange
  "#4a9140", // green
  "#d8434a", // red
  "#9a5f8e", // purple
  "#c49a12", // yellow
  "#3f948d", // teal
  "#e57487", // pink
  "#8a6149", // brown
  "#6aa3d0", // light blue
  "#6fb85e", // light green
  "#bd88b3", // light purple
];

/** Group colours of the theme in effect (swapped by `setPalette`) */
export const GROUP_PALETTE: string[] = [...DARK_GROUPS];

/** Colour of the groups outside the coloured ones ("other") */
export let OTHER_GROUP_COLOR = "#6b6b6b";

/** Colour of lines in no known level (minimap and lanes code 1) */
export let NO_LEVEL_COLOR = "#6b6b6b";

/** Switches the colours above to the palette of a theme (called by lib/theme.ts) */
export function setPalette(theme: "light" | "dark") {
  Object.assign(colorMap, theme === "light" ? LIGHT_LEVELS : DARK_LEVELS);
  GROUP_PALETTE.splice(0, GROUP_PALETTE.length, ...(theme === "light" ? LIGHT_GROUPS : DARK_GROUPS));
  OTHER_GROUP_COLOR = theme === "light" ? "#b3a99f" : "#6b6b6b";
  NO_LEVEL_COLOR = theme === "light" ? "#b3a99f" : "#6b6b6b";
}

/** A colour per group name, by rank: `names` is most common first (as the backend sends
    them, by line count and then name, so the same file always gets the same colours), and
    the palette is ordered so the largest groups get the most distinct colours. */
export function groupColors(names: string[]): string[] {
  return names.map((_, i) => GROUP_PALETTE[i] ?? OTHER_GROUP_COLOR);
}
