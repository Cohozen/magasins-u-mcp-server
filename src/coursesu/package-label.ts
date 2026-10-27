/** Base units: grams, millilitres, pieces. */
export type CanonicalUnit = "g" | "ml" | "piece";

/**
 * Reads a pack size written out in a product label.
 *
 * Deliberately independent of any one source: the same "2x140g" appears on a coursesu tile, on a
 * till receipt ("BLED BOL TMT/PAT/BF 8M 2X200G") and wherever comes next. Keeping it next to the
 * code that knows one site's DOM would force every new source to depend on that code.
 *
 * Pure: a string goes in, integers come out. No floating point, not even as an intermediate value.
 */

export type ParsedPackage = {
    /** Human-readable rebuilt label: "2 x 140 g", "x12", "x44 · 510 g". */
    label: string | null;
    /** Number of units in the pack: "2 x 140 g" → 2, "x12" → 12. Null for a single container. */
    packCount: number | null;
    /**
     * Content of one unit, in base units. Null when the total does not divide evenly
     * ("x44 · 510 g"): something that needs "2 eggs" needs the count, not an invented average.
     */
    unitNetQuantity: number | null;
    /** Total net content, as an integer in base units. Null when unknown. */
    netQuantity: number | null;
    netUnit: CanonicalUnit | null;
};

/**
 * `2,00` → `200`. Parsed from the string rather than with `parseFloat`: the "no floats anywhere"
 * rule also covers intermediate values, and `19.99 * 100` is 1998.9999999999998.
 */
export const decimalToCents = (value: string | null): number | null => {
    if (value === null) return null;
    const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
    if (match?.[1] === undefined) return null;
    const cents =
        Number.parseInt(match[1], 10) * 100 + Number.parseInt((match[2] ?? "").padEnd(2, "0"), 10);
    return Number.isNaN(cents) ? null : cents;
};

/**
 * Net quantity: a number and a unit, optionally preceded by a multiplier in one of the two forms
 * seen in the wild ("2x140g", "6 bouteilles de 1L"). When several expressions coexist
 * ("6 panés de 25g - 150g"), the last one is the total content.
 */
const NET_QUANTITY =
    /(?:(\d+)\s*(?:[xX×*]|(?:bouteilles?|bo[îi]tes?|pots?|sachets?|briques?|plaquettes?|packs?|barquettes?|tablettes?)\s+de)\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|litres?|l)(?![\p{L}])/giu;

/**
 * Number of units in a pack: "x12", "*300", "Boîte de 12", "Plateau de 20". The lookahead
 * excludes "2x140g", already handled as a multiplier by `NET_QUANTITY`.
 */
const UNIT_COUNT =
    /(?:[xX×*]\s*(\d+)|(?:bo[îi]te|paquet|lot|pack|plateau)\s+de\s+(\d+))(?!\s*(?:kg|g|ml|cl|litres?|l)(?![\p{L}]))(?![\d.,])/iu;

/**
 * Last resort, when the label has no weight, volume or count: words that count pieces on their
 * own. Kept for that case only because elsewhere such a number does not count the pack —
 * "Confiture 4 fruits rouges 370g" is a recipe. For the same reason, fruit is only counted after
 * its container ("Bouquet 6 fruits"): a receipt truncated to "CONFIT.4 FRUITS ROUGES" has no
 * weight left to protect it.
 */
const PIECE_COUNT =
    /(?:(?:bouquet|barquette|sachet)\s+(\d+)\s+fruits?|(\d+)\s+rouleaux)(?![\p{L}])/iu;

/** Sold by the piece: "Concombre - La pièce", "Courgette à la pièce". */
const SINGLE_PIECE = /(?<![\p{L}])(?:à\s+)?la\s+pi[eè]ce(?![\p{L}])/iu;

const TO_CANONICAL: Record<string, { unit: CanonicalUnit; factor: number }> = {
    g: { unit: "g", factor: 1 },
    kg: { unit: "g", factor: 1000 },
    ml: { unit: "ml", factor: 1 },
    cl: { unit: "ml", factor: 10 },
    l: { unit: "ml", factor: 1000 },
};

/** `"1,25"` → `125` (hundredths). Same reason as elsewhere: no floats. */
const toHundredths = (value: string): number => {
    const [whole = "0", decimals = ""] = value.replace(",", ".").split(".");
    return (
        Number.parseInt(whole, 10) * 100 + Number.parseInt(decimals.slice(0, 2).padEnd(2, "0"), 10)
    );
};

/** "1 litre" and "1L" are the same unit. */
const normalizeUnit = (unit: string): string => unit.toLowerCase().replace(/^litres?$/, "l");

const formatUnit = (unit: string): string => (unit === "l" ? "L" : unit);

/**
 * The content of one unit is derived from the total, never the other way round: the total is
 * what the label states. A division that does not come out even ("x44 · 510 g") returns `null`
 * rather than an average, which would be made-up data.
 */
const perUnit = (netQuantity: number, packCount: number | null): number | null =>
    packCount !== null && packCount > 0 && netQuantity % packCount === 0
        ? netQuantity / packCount
        : null;

type MatchedPackage = ParsedPackage & { matched: string[] };

const pieceLot = (count: number, matched: string[]): MatchedPackage => ({
    label: `x${count}`,
    packCount: count,
    unitNetQuantity: 1,
    netQuantity: count,
    netUnit: "piece",
    matched,
});

const parsePieces = (label: string): MatchedPackage => {
    const lot = PIECE_COUNT.exec(label);
    const rawCount = lot?.[1] ?? lot?.[2];
    if (lot && rawCount !== undefined) return pieceLot(Number.parseInt(rawCount, 10), [lot[0]]);

    // An item sold on its own is not a pack: no count, just like a 500 g jar.
    const single = SINGLE_PIECE.exec(label);
    return {
        label: single ? "1 pièce" : null,
        packCount: null,
        unitNetQuantity: null,
        netQuantity: single ? 1 : null,
        netUnit: single ? "piece" : null,
        matched: single ? [single[0]] : [],
    };
};

export const parsePackage = (label: string): MatchedPackage => {
    const matches = [...label.matchAll(NET_QUANTITY)];
    const last = matches.at(-1);
    const countMatch = UNIT_COUNT.exec(label);
    const rawCount = countMatch?.[1] ?? countMatch?.[2];
    const count = rawCount === undefined ? null : Number.parseInt(rawCount, 10);
    const matched = matches.map((m) => m[0]);
    if (countMatch) matched.push(countMatch[0]);

    if (last === undefined) {
        // No weight or volume: a counted pack ("x80 mouchoirs") is counted in pieces.
        return count === null ? parsePieces(label) : pieceLot(count, matched);
    }

    const [, rawMultiplier, rawValue = "0", rawUnit = "g"] = last;
    const multiplier = rawMultiplier === undefined ? null : Number.parseInt(rawMultiplier, 10);
    const unit = normalizeUnit(rawUnit);
    const conversion = TO_CANONICAL[unit] ?? { unit: "g" as const, factor: 1 };
    const perUnitX100 = toHundredths(rawValue) * conversion.factor;
    const value = `${rawValue.replace(",", ".")} ${formatUnit(unit)}`;

    // A multiplier is part of the net content (2x140g = 280 g); a plain count describes the pack
    // without multiplying it (x44 tablets weighing 510 g in total).
    const parts: string[] = [];
    if (multiplier !== null) parts.push(`${multiplier} x ${value}`);
    else {
        if (count !== null) parts.push(`x${count}`);
        parts.push(value);
    }

    // Hundredths are useless for grams and millilitres and add a conversion to never forget:
    // the net content is an integer in base units.
    const netQuantity = Math.round((perUnitX100 * (multiplier ?? 1)) / 100);
    const packCount = multiplier ?? count;

    return {
        label: parts.join(" · "),
        packCount,
        unitNetQuantity: perUnit(netQuantity, packCount),
        netQuantity,
        netUnit: conversion.unit,
        matched,
    };
};
