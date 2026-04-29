/**
 * NameShortener - Make Windows audio device names readable on a 72×72 key.
 *
 * Windows tacks the driver onto the device name in parentheses, e.g.:
 *   "Speakers (Realtek(R) Audio)"
 *   "Headphones (2- High Definition Audio Device)"
 *   "Headset Earphone (HyperX Cloud II Wireless)"
 *
 * The bit before the parentheses is the user-friendly part. We keep that,
 * but fall back to the full name if stripping leaves nothing useful.
 */

/** Words/markers we strip aggressively because they add noise without info. */
const NOISE_PATTERNS: RegExp[] = [
    /\(R\)/gi,
    /\(TM\)/gi,
    /®/g,
    /™/g,
    /\bHigh Definition Audio Device\b/gi,
    /\bAudio Device\b/gi,
];

/** Words we'll abbreviate when they appear at word boundaries. */
const ABBREVIATIONS: Array<[RegExp, string]> = [
    [/\bBluetooth\b/gi, "BT"],
    [/\bMicrophone\b/gi, "Mic"],
    [/\bHeadphones\b/gi, "Headphones"], // keep — it's clear
];

export interface ShortenOptions {
    /** Max characters in the final string. Defaults to 22 (≈3 lines × 7-8 chars on a Stream Deck key). */
    maxLength?: number;
    /** Whether to attempt aggressive abbreviation. Defaults to true. */
    aggressive?: boolean;
    /**
     * Which part of a "Friendly (Driver)" name to keep:
     *   - "role"  → "Speakers"            (default; the part before the parens)
     *   - "model" → "Realtek(R) Audio"    (the part inside the trailing parens)
     *   - "full"  → "Speakers (Realtek(R) Audio)"  (both, with only noise stripping)
     *
     * If the device name has no parenthesised group, all three styles return
     * the same string (it's already the role).
     */
    style?: "role" | "model" | "full";
}

/**
 * Take a Windows audio device name and produce something readable on a key.
 *
 * Strategy:
 *   1. Strip leading "1- " / "2- " enumeration prefixes Windows adds to duplicates.
 *   2. Split on the trailing parenthesised group: head = "Speakers",
 *      tail = "Realtek(R) Audio". (Walks paren depth so nested "(R)" is OK.)
 *   3. Clean each half independently (prefix-strip + noise-strip + abbrev).
 *      The tail may also have a "1-/2-" enumeration prefix Windows tucks
 *      inside the parens — we strip that too.
 *   4. Pick role / model / full per `style`; if the chosen half is empty
 *      after cleaning, fall back to the other half rather than show "Unknown".
 *   5. Collapse whitespace and truncate with ellipsis if needed.
 */
export function shortenDeviceName(raw: string, options: ShortenOptions = {}): string {
    const maxLength = options.maxLength ?? 22;
    const aggressive = options.aggressive ?? true;
    const style = options.style ?? "role";

    if (!raw || typeof raw !== "string") return "Unknown";

    let name = raw.trim();
    if (name.length === 0) return "Unknown";

    // 1. Strip outer "1- ", "2- " etc. prefix Windows adds to duplicate-named devices.
    name = name.replace(/^\d+-\s*/, "");

    // 2. Decompose into head / tail if a balanced trailing group exists.
    const split = splitTrailingParenGroup(name);

    if (!split) {
        // No parenthesised group — there's only one piece, just clean it.
        return finalize(cleanPiece(name, aggressive), maxLength);
    }

    // 3. Clean both halves independently. The tail can also have a "1-/2-"
    //    enumeration prefix (e.g. "Headphones (2- High Definition Audio Device)").
    const cleanedHead = cleanPiece(split.head, aggressive);
    const cleanedTail = cleanPiece(split.tail.replace(/^\d+-\s*/, ""), aggressive);

    // 4. Pick a half per `style`, falling back if the chosen half is empty.
    let chosen: string;
    if (style === "model") {
        chosen = cleanedTail || cleanedHead;
    } else if (style === "full") {
        if (cleanedHead && cleanedTail) {
            chosen = `${cleanedHead} (${cleanedTail})`;
        } else {
            chosen = cleanedHead || cleanedTail;
        }
    } else {
        // "role"
        chosen = cleanedHead || cleanedTail;
    }

    return finalize(chosen, maxLength);
}

/** Apply noise/abbreviation passes to a single string fragment. */
function cleanPiece(piece: string, aggressive: boolean): string {
    let s = piece.trim();
    if (!aggressive) return s.replace(/\s+/g, " ").trim();

    for (const pattern of NOISE_PATTERNS) {
        s = s.replace(pattern, "");
    }
    for (const [pattern, replacement] of ABBREVIATIONS) {
        s = s.replace(pattern, replacement);
    }
    return s.replace(/\s+/g, " ").trim();
}

/** Whitespace-collapse, fall back to "Unknown" if empty, then truncate to maxLength. */
function finalize(s: string, maxLength: number): string {
    s = s.replace(/\s+/g, " ").trim();
    if (s.length === 0) return "Unknown";

    if (s.length > maxLength) {
        const truncated = s.slice(0, maxLength - 1);
        const lastSpace = truncated.lastIndexOf(" ");
        if (lastSpace > maxLength * 0.6) {
            s = truncated.slice(0, lastSpace) + "…";
        } else {
            s = truncated + "…";
        }
    }
    return s;
}

/**
 * If `s` ends with a balanced parenthesised group, return its two halves:
 *   `{ head: "everything before", tail: "contents inside parens" }`.
 *
 * Returns `null` if `s` doesn't end with `)` or the parens are unbalanced.
 *
 * Walks depth-aware from the right, so nested groups like "Speakers (Realtek(R) Audio)"
 * are split as head="Speakers", tail="Realtek(R) Audio" — a naive regex with
 * `[^)]+` would stop at the inner `)` and return the wrong thing.
 */
function splitTrailingParenGroup(s: string): { head: string; tail: string } | null {
    if (!s.endsWith(")")) return null;

    let depth = 0;
    for (let i = s.length - 1; i >= 0; i--) {
        const ch = s[i];
        if (ch === ")") {
            depth++;
        } else if (ch === "(") {
            depth--;
            if (depth === 0) {
                const head = s.slice(0, i).trimEnd();
                const tail = s.slice(i + 1, s.length - 1).trim();
                return { head, tail };
            }
        }
    }
    // Unmatched parens — leave the string alone.
    return null;
}

/**
 * Insert soft line breaks so multi-word names wrap nicely on the key.
 * Stream Deck respects \n in setTitle.
 */
export function wrapForKey(text: string, charsPerLine = 8): string {
    if (text.length <= charsPerLine) return text;

    const words = text.split(" ");
    if (words.length === 1) return text; // single long word — let SD truncate

    const lines: string[] = [];
    let current = "";

    for (const word of words) {
        if (current.length === 0) {
            current = word;
        } else if (current.length + 1 + word.length <= charsPerLine) {
            current += " " + word;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current.length > 0) lines.push(current);

    // Cap at 3 lines max (Stream Deck keys are tiny).
    return lines.slice(0, 3).join("\n");
}
