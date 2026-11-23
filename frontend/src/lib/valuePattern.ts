// Field filter patterns, the same rules as the backend (backend/src/parsing/value_pattern.rs):
// `*` stands for any run of characters, and a pattern ending in `.*` also matches the name
// before the dot, so `ui.*` selects `ui`, `ui.button` and `ui.peripheral.usb`.

export const isPattern = (value: string) => value.includes("*");

function globMatch(parts: string[], v: string): boolean {
    const [first, ...rest] = parts;
    if (!v.startsWith(first)) return false;
    v = v.slice(first.length);
    if (rest.length === 0) return v.length === 0;
    const last = rest.pop()!;
    for (const m of rest) {
        const i = v.indexOf(m);
        if (i < 0) return false;
        v = v.slice(i + m.length);
    }
    return v.length >= last.length && v.endsWith(last);
}

/** A test for the values a filter entry (exact value or pattern) selects. */
export function valueMatcher(pattern: string): (value: string) => boolean {
    if (!isPattern(pattern)) return (v) => v === pattern;
    const parts = pattern.split("*");
    const parent = pattern.endsWith(".*") && pattern.length > 2 ? pattern.slice(0, -2).split("*") : null;
    return (v) => globMatch(parts, v) || (parent != null && globMatch(parent, v));
}
