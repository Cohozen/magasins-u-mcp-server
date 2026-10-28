/**
 * Rebuilds fixed-pitch text from positioned fragments.
 *
 * A till receipt is printed on a grid: every character has the same width and columns carry the
 * meaning (label on the left, amount on the right, VAT code at the end). A PDF only gives pieces
 * of text with their coordinates; gluing them left to right would lose the spacing, which is the
 * very thing that matters. So each fragment goes back to its column and the result is the text as
 * printed, which later parsing can slice exactly.
 *
 * Pure and generic: nothing here knows about receipts.
 */

/** What the grid needs from a text fragment. `y` grows upwards, as in PDF. */
export type TextFragment = { str: string; x: number; y: number; width: number };

/**
 * The pitch is measured on fragments without spaces only, and the median is taken: a PDF reader
 * merges a run of spaces into one wide fragment, and a barcode's human-readable line uses its own
 * font. The median ignores such outliers.
 */
const pitchOf = (fragments: readonly TextFragment[]): number | null => {
    const pitches = fragments
        .filter((fragment) => fragment.width > 0 && fragment.str.length > 0)
        .filter((fragment) => !/\s/.test(fragment.str))
        .map((fragment) => fragment.width / fragment.str.length)
        .sort((a, b) => a - b);
    return pitches[Math.floor(pitches.length / 2)] ?? null;
};

/**
 * Returns the document line by line, top to bottom. Leading spaces are kept (indentation tells a
 * detail line from an item line), trailing ones are dropped. Empty when there is nothing to
 * measure a pitch on.
 */
export const buildTextGrid = (fragments: readonly TextFragment[]): string[] => {
    const pitch = pitchOf(fragments);
    if (pitch === null) return [];

    const originX = Math.min(...fragments.map((fragment) => fragment.x));
    const rows = new Map<number, TextFragment[]>();
    for (const fragment of fragments) {
        // Lines sit on clear-cut ordinates: rounding to the pitch groups them without merging two.
        const row = Math.round(fragment.y / pitch);
        const bucket = rows.get(row);
        if (bucket === undefined) rows.set(row, [fragment]);
        else bucket.push(fragment);
    }

    return [...rows.keys()]
        .sort((a, b) => b - a)
        .map((key) => {
            const cells: string[] = [];
            for (const fragment of rows.get(key) ?? []) {
                const column = Math.round((fragment.x - originX) / pitch);
                for (let index = 0; index < fragment.str.length; index++) {
                    const char = fragment.str[index];
                    // A space never erases a character already placed: blank fragments often
                    // overlap the text that follows them.
                    if (char === undefined || char === " ") continue;
                    cells[column + index] = char;
                }
            }
            let line = "";
            for (let column = 0; column < cells.length; column++) line += cells[column] ?? " ";
            return line.trimEnd();
        });
};
