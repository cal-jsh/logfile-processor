/** Keys typed here keep their own meaning (Ctrl+arrows move by word in a text field, W is a letter) */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !["checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(t.type);
  // modal dialogs (log format, bug report, ...) and open dropdown lists
  return !!t.closest('[data-slot="dialog-content"], [role="listbox"], [role="menu"]');
}

/** A modal dialog (Settings, bug report, ...) is open, wherever the focus is */
export const dialogOpen = () => !!document.querySelector('[data-slot="dialog-content"]');

/** The user asked the system for less motion */
export const prefersReducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
