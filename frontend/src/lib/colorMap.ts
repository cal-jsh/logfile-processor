export const LEVEL_ORDER = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

export const colorMap: Record<string, string> = {
  TRACE: "#888",
  DEBUG: "#94bbc8ff",
  INFO: "#8cc644ff",
  WARN: "orange",
  ERROR: "red",
};

export type LogLevel = (typeof LEVEL_ORDER)[number];
