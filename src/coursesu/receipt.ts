/**
 * Reads a Super U / Hyper U till receipt from the text fragments of its PDF.
 *
 * The receipt is printed on a fixed-pitch grid: `text-grid.ts` rebuilds it, then this module
 * reads lines exactly as printed. Pure: no PDF, no I/O.
 *
 * **A receipt that fails one consistency check is rejected as a whole.** The checks matter more
 * than the parsing: they turn a shifted column on an unseen receipt layout into a loud refusal
 * instead of silently wrong figures. Amounts are handled in integer cents, then returned in euros.
 */

import { decimalToCents } from "./package-label.ts";
import { buildTextGrid, type TextFragment } from "./text-grid.ts";

export type ReceiptLine = {
    /** Store department heading printed above the line ("FROMAGE LS"). */
    section: string | null;
    /** Label exactly as printed, truncation included. */
    label: string;
    /** Number of items, or weight in kilos for a weighed line. */
    quantity: number;
    unit: "piece" | "kg";
    /** As printed: per item, or per kilo for a weighed line. */
    unitPrice: number | null;
    /** Printed amount, before the line rebate. */
    total: number;
    /**
     * Rebate printed right under the line ("LOT PROMO KIWI JAUNE  -0,96"), negative. Already
     * deducted from the receipt total, unlike the immediate discounts block.
     */
    rebate: number | null;
    rebateLabel: string | null;
    vatCode: string | null;
};

export type ReceiptDiscount = {
    label: string;
    quantity: number;
    unitAmount: number | null;
    /** Negative, as printed. */
    total: number;
};

export type Receipt = {
    /** `store-YYYYMMDD-till-ticket`: unique per receipt. */
    ref: string;
    store: string;
    /** Local date and time of purchase, as printed. */
    date: string;
    time: string;
    /** Sum of the lines, line rebates deducted ("TOTAL [n] Articles"). */
    total: number;
    /** Immediate discounts block, negative or zero. */
    discounts: number;
    amountPaid: number;
    lines: ReceiptLine[];
    discountLines: ReceiptDiscount[];
};

export type ReceiptResult = { ok: true; receipt: Receipt } | { ok: false; reason: string };

/** Working form of a line: cents, plus what the till counts in "TOTAL [n] Articles". */
type Line = Omit<ReceiptLine, "quantity" | "unitPrice" | "total" | "rebate"> & {
    quantity: number;
    unitPriceCents: number | null;
    totalCents: number;
    rebateCents: number | null;
    articleCount: number;
};

type Discount = Omit<ReceiptDiscount, "unitAmount" | "total"> & {
    unitAmountCents: number | null;
    totalCents: number;
};

const ARTICLE = /^(\S.*?)\s{2,}(-?\d+,\d{2})\s+€(?:\s+(\d+))?$/;
const UNIT_DETAIL = /^\s+(\d+)\s+x\s+(\d+[.,]\d{2})\s+EUR$/;
const WEIGHED_MARK = /^\s+Pesée manuelle$/;
const WEIGHED_DETAIL = /^\s+(\d+)[.,](\d{1,3})\s*kg\s+x\s+(\d+[.,]\d{2})\s*€\/kg$/;
/**
 * Line rebate: no "€", no VAT code, a negative amount. Without this pattern it would be read as a
 * department heading, and the sum check would fail without a readable reason.
 */
const LINE_REBATE = /^(\S.*?)\s{2,}(-\d+,\d{2})$/;
const DECLARED_LINES = /^Nombre de lignes d'article\s+(\d+)$/;
const TOTAL_ARTICLES = /^TOTAL\s+\[(\d+)\]\s+Articles\s+(\d+,\d{2})\s+€$/;
const SUB_TOTAL = /^SOUS-TOTAL\s+(\d+,\d{2})\s+€$/;
const TOTAL_VAT = /^TOTAL TVA\s+(\d+,\d{2})\s+€$/;
const TOTAL_DISCOUNTS = /^TOTAL REDUCTIONS IMMEDIATES\s+(-?\d+,\d{2})\s+€$/;
const AMOUNT_PAID = /^RESTE A PAYER\s+(\d+,\d{2})\s+€$/;
const DISCOUNTS_BANNER = /VOS REDUCTIONS IMMEDIATES/;
const DISCOUNT = /^(\d+)\s+x\s+(\d+[.,]\d{2})€?\s+(\S.*?)\s{2,}(-?\d+,\d{2})\s+€$/;
const SALE_BANNER = /\*{3}\s*VENTE\s*\*{3}/;
const FOOTER_HEADER = /^\s*Date\s+Heure\s+Magasin\s+Tpv\s+Util\s+Tick$/;
const FOOTER =
    /^\s*(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/;
const BARCODE = /^\s*(\d{20,})$/;

const fail = (reason: string): ReceiptResult => ({ ok: false, reason });

/** `decimalToCents` ignores signs: negative amounts are printed "-1,24". */
const signedCents = (value: string): number | null => {
    const negative = value.startsWith("-");
    const cents = decimalToCents(negative ? value.slice(1) : value);
    return cents === null ? null : negative ? -cents : cents;
};

const amountIn = (grid: readonly string[], pattern: RegExp): number | null => {
    for (const row of grid) {
        const match = pattern.exec(row);
        if (match?.[1] !== undefined) return signedCents(match[1]);
    }
    return null;
};

const euros = (cents: number): number => cents / 100;

const readLines = (region: readonly string[]): { lines: Line[] } | { reason: string } => {
    const lines: Line[] = [];
    let section: string | null = null;

    for (const row of region) {
        if (row.trim() === "") continue;

        // Indentation, not case, tells a detail from an item: item labels are uppercase too.
        if (/^\s/.test(row)) {
            const last = lines.at(-1);
            if (last === undefined) return { reason: `orphan detail line: "${row.trim()}"` };
            if (WEIGHED_MARK.test(row)) continue;

            const weighed = WEIGHED_DETAIL.exec(row);
            if (weighed?.[1] && weighed[2] && weighed[3]) {
                const grams =
                    Number.parseInt(weighed[1], 10) * 1000 +
                    Number.parseInt(weighed[2].padEnd(3, "0"), 10);
                last.quantity = grams / 1000;
                last.unit = "kg";
                last.unitPriceCents = decimalToCents(weighed[3]);
                last.articleCount = 1;
                continue;
            }

            const detail = UNIT_DETAIL.exec(row);
            if (detail?.[1] && detail[2]) {
                last.quantity = Number.parseInt(detail[1], 10);
                last.unit = "piece";
                last.unitPriceCents = decimalToCents(detail[2]);
                last.articleCount = last.quantity;
                continue;
            }

            return { reason: `unknown detail line: "${row.trim()}"` };
        }

        const article = ARTICLE.exec(row);
        if (!article?.[1] || !article[2]) {
            const rebate = LINE_REBATE.exec(row);
            if (rebate?.[1] && rebate[2]) {
                const last = lines.at(-1);
                const cents = signedCents(rebate[2]);
                if (last === undefined || cents === null)
                    return { reason: `unreadable rebate: "${row.trim()}"` };
                // Two rebates on one line were never seen; adding them hides nothing, since the
                // sum check below still verifies the arithmetic.
                last.rebateCents = (last.rebateCents ?? 0) + cents;
                last.rebateLabel ??= rebate[1].trimEnd();
                continue;
            }
            // Neither detail, item nor rebate: a department heading.
            section = row.trim();
            continue;
        }

        const totalCents = signedCents(article[2]);
        if (totalCents === null) return { reason: `unreadable amount: "${row.trim()}"` };
        lines.push({
            section,
            label: article[1].trimEnd(),
            // Defaults for a line without a printed detail.
            quantity: 1,
            unit: "piece",
            unitPriceCents: totalCents,
            totalCents,
            rebateCents: null,
            rebateLabel: null,
            vatCode: article[3] ?? null,
            articleCount: 1,
        });
    }
    return { lines };
};

const readDiscounts = (
    region: readonly string[],
): { discounts: Discount[] } | { reason: string } => {
    const discounts: Discount[] = [];
    for (const row of region) {
        if (row.trim() === "") continue;
        const match = DISCOUNT.exec(row);
        const totalCents = match?.[4] === undefined ? null : signedCents(match[4]);
        if (!match?.[1] || !match[2] || !match[3] || totalCents === null) {
            return { reason: `unknown discount line: "${row.trim()}"` };
        }
        discounts.push({
            label: match[3].trimEnd(),
            quantity: Number.parseInt(match[1], 10),
            unitAmountCents: decimalToCents(match[2]),
            totalCents,
        });
    }
    return { discounts };
};

/** Parses an already rebuilt grid. Separate so that tests can alter one printed line. */
export const parseReceiptRows = (grid: readonly string[]): ReceiptResult => {
    if (grid.length === 0) return fail("no readable text in the PDF");

    const declaredLinesAt = grid.findIndex((row) => DECLARED_LINES.test(row));
    if (declaredLinesAt === -1) return fail(`"Nombre de lignes d'article" not found`);
    const declaredLines = Number(DECLARED_LINES.exec(grid[declaredLinesAt] ?? "")?.[1]);

    const saleAt = grid.findIndex((row) => SALE_BANNER.test(row));
    const read = readLines(grid.slice(saleAt + 1, declaredLinesAt));
    if ("reason" in read) return fail(read.reason);
    const { lines } = read;

    const discountsAt = grid.findIndex((row) => DISCOUNTS_BANNER.test(row));
    const discountTotalAt = grid.findIndex((row) => TOTAL_DISCOUNTS.test(row));
    let discounts: Discount[] = [];
    if (discountsAt !== -1 && discountTotalAt > discountsAt) {
        const block = readDiscounts(grid.slice(discountsAt + 1, discountTotalAt));
        if ("reason" in block) return fail(block.reason);
        discounts = block.discounts;
    }

    const totalArticles = TOTAL_ARTICLES.exec(grid.find((row) => TOTAL_ARTICLES.test(row)) ?? "");
    const totalCents = totalArticles?.[2] === undefined ? null : signedCents(totalArticles[2]);
    if (totalArticles?.[1] === undefined || totalCents === null)
        return fail(`"TOTAL [n] Articles" not found`);
    const declaredArticles = Number(totalArticles[1]);

    // Trap: SOUS-TOTAL is not a subtotal but the amount before VAT. Only used by a check.
    const excludingVatCents = amountIn(grid, SUB_TOTAL);
    const vatCents = amountIn(grid, TOTAL_VAT);
    const discountTotalCents = discountTotalAt === -1 ? 0 : (amountIn(grid, TOTAL_DISCOUNTS) ?? 0);

    // Without discounts, the receipt prints neither the discount total nor "RESTE A PAYER": the
    // total is what was paid. With discounts, a missing "RESTE A PAYER" is a reading failure.
    const amountPaidCents =
        amountIn(grid, AMOUNT_PAID) ?? (discountTotalAt === -1 ? totalCents : null);
    if (amountPaidCents === null) return fail(`"RESTE A PAYER" not found`);

    const footerHeaderAt = grid.findIndex((row) => FOOTER_HEADER.test(row));
    if (footerHeaderAt === -1) return fail("footer (Date Heure Magasin…) not found");
    const footerRow = grid.slice(footerHeaderAt + 1).find((row) => row.trim() !== "");
    const footer = FOOTER.exec(footerRow ?? "");
    if (!footer) return fail(`unreadable footer: "${footerRow?.trim() ?? ""}"`);
    const [, day, month, year, time, store, till, , ticket] = footer as unknown as string[];
    const date = `20${year}-${month}-${day}`;
    const ref = `${store}-20${year}${month}${day}-${till}-${ticket}`;

    // --- Consistency checks ---------------------------------------------------------------
    if (lines.length !== declaredLines) {
        return fail(`${lines.length} line(s) read, the receipt declares ${declaredLines}`);
    }
    const articleCount = lines.reduce((sum, line) => sum + line.articleCount, 0);
    if (articleCount !== declaredArticles) {
        return fail(`${articleCount} item(s) counted, the receipt declares ${declaredArticles}`);
    }
    // Line rebates count here and only here: the receipt total is already net of them.
    const linesCents = lines.reduce(
        (sum, line) => sum + line.totalCents + (line.rebateCents ?? 0),
        0,
    );
    if (linesCents !== totalCents) {
        return fail(`lines add up to ${euros(linesCents)} €, TOTAL says ${euros(totalCents)} €`);
    }
    const discountsCents = discounts.reduce((sum, discount) => sum + discount.totalCents, 0);
    if (discountsCents !== discountTotalCents) {
        return fail(
            `discounts add up to ${euros(discountsCents)} €, the receipt says ${euros(discountTotalCents)} €`,
        );
    }
    if (totalCents + discountTotalCents !== amountPaidCents) {
        return fail(
            `TOTAL ${euros(totalCents)} € and discounts ${euros(discountTotalCents)} € do not make RESTE A PAYER ${euros(amountPaidCents)} €`,
        );
    }
    if (
        excludingVatCents !== null &&
        vatCents !== null &&
        excludingVatCents + vatCents !== totalCents
    ) {
        return fail(
            `SOUS-TOTAL ${euros(excludingVatCents)} € and VAT ${euros(vatCents)} € do not make TOTAL ${euros(totalCents)} €`,
        );
    }
    // The barcode repeats the footer: a free confirmation of the reference, when it is readable.
    const barcode = grid.map((row) => BARCODE.exec(row)?.[1]).find((digits) => digits);
    if (
        barcode !== undefined &&
        (!barcode.endsWith(`${day}${month}${year}${till}${ticket?.padStart(6, "0")}`) ||
            !barcode.includes(store ?? ""))
    ) {
        return fail(`the barcode ${barcode} contradicts the footer ${ref}`);
    }

    return {
        ok: true,
        receipt: {
            ref,
            store: store ?? "",
            date,
            time: time ?? "",
            total: euros(totalCents),
            discounts: euros(discountTotalCents),
            amountPaid: euros(amountPaidCents),
            lines: lines.map((line) => ({
                section: line.section,
                label: line.label,
                quantity: line.quantity,
                unit: line.unit,
                unitPrice: line.unitPriceCents === null ? null : euros(line.unitPriceCents),
                total: euros(line.totalCents),
                rebate: line.rebateCents === null ? null : euros(line.rebateCents),
                rebateLabel: line.rebateLabel,
                vatCode: line.vatCode,
            })),
            discountLines: discounts.map((discount) => ({
                label: discount.label,
                quantity: discount.quantity,
                unitAmount:
                    discount.unitAmountCents === null ? null : euros(discount.unitAmountCents),
                total: euros(discount.totalCents),
            })),
        },
    };
};

export const parseReceipt = (fragments: readonly TextFragment[]): ReceiptResult =>
    parseReceiptRows(buildTextGrid(fragments));
