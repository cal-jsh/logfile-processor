/* Light and dark theme.

   The choice ("system", "light" or "dark") is kept in localStorage and applied to <html>:
   - `.dark` switches the app's chrome (sidebar, filter bar, dialogs: the shadcn tokens),
   - `.log-dark` switches the log surface (rows, minimap, thread lanes: the --log-* tokens
     in index.css),
   and the level and domain colours in `colorMap` are swapped to the matching palette, since
   the canvases draw with them directly. "system" follows the OS (prefers-color-scheme) and
   changes along with it while the app runs. The window's title bar is told too, so it
   matches when the choice differs from the OS. */
import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setPalette } from "./colorMap";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "logviewer.theme";
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let choice: ThemeChoice = readChoice();
let systemTheme: Theme = media?.matches ? "dark" : "light";
let theme: Theme = resolve();
const listeners = new Set<() => void>();

function resolve(): Theme {
  return choice === "system" ? systemTheme : choice;
}

function apply() {
  theme = resolve();
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("log-dark", theme === "dark");
  root.style.colorScheme = theme;
  setPalette(theme);
  for (const l of listeners) l();
}

function tellWindow() {
  if (!isTauri()) return;
  // null = follow the OS again
  getCurrentWindow()
    .setTheme(choice === "system" ? null : choice)
    .catch(() => {});
}

/** Applies the stored choice; call once before the first render, so nothing flashes. */
export function initTheme() {
  apply();
  // The title bar only needs telling when the choice is not "system"
  if (choice !== "system") tellWindow();
  media?.addEventListener("change", (e) => {
    systemTheme = e.matches ? "dark" : "light";
    // While the window's theme is forced, the webview reports that instead of the OS
    if (choice === "system") apply();
  });
  // Another window of the app changed it
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    choice = readChoice();
    if (choice === "system") systemTheme = media?.matches ? "dark" : "light";
    apply();
  });
}

export function getThemeChoice(): ThemeChoice {
  return choice;
}

export function setThemeChoice(next: ThemeChoice) {
  if (next === choice) return;
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* not kept, still applied */
  }
  if (next === "system") {
    // Let go of the forced title bar theme first, so the webview reports the OS again
    tellWindow();
    systemTheme = media?.matches ? "dark" : "light";
    // The media query may only update after the window has let go; it then fires "change"
  }
  apply();
  if (next !== "system") tellWindow();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The theme in effect ("light" or "dark"); re-renders when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => theme);
}

/** The user's choice ("system", "light" or "dark"); re-renders when it changes. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice);
}
