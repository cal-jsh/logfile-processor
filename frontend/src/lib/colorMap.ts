export const LEVEL_ORDER = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

export const colorMap: Record<string, string> = {
  TRACE: "#888",
  DEBUG: "#ADD8E6",
  INFO: "#d6f8acff",
  WARN: "orange",
  ERROR: "red",
};

export type LogLevel = (typeof LEVEL_ORDER)[number];
