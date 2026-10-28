/**
 * The cart, as the `/panier` page shows it: lines with quantities and amounts after multi-buy
 * discounts, and the estimated total.
 */

import { ORIGIN, type Site } from "../browser.ts";
import { euros, type Product, parseTile, type RawTile, squash } from "./catalog.ts";

export type RawCartLine = RawTile & { quantity: string | null };

export type CartLine = Product & {
    quantity: number | null;
    /** What the line costs, multi-buy discount deducted. */
    lineTotal: number | null;
    /** What the line would cost without the multi-buy discount, when one applies. */
    lineTotalBeforeDiscount: number | null;
    /** Euros the line puts on the Carte U ("0,96 € cagnottés"). */
    loyaltyEarned: number | null;
};

const amount = (text: string, pattern: RegExp): number | null => euros(pattern.exec(text)?.[1]);

export const parseCartLine = (raw: RawCartLine): CartLine | null => {
    const product = parseTile(raw);
    if (product === null) return null;
    // Amounts of the line come before its buttons; savings and Carte U earnings come after.
    const head = raw.text.split("Ajouter à une liste")[0] ?? raw.text;
    const totals = [...head.matchAll(/(\d+,\d{2}) €(?!\s*\/)/g)].map((match) => euros(match[1]));
    const last = totals.at(-1) ?? null;
    const first = totals[0] ?? null;
    const quantity = Number(raw.quantity);
    return {
        ...product,
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : null,
        lineTotal: last,
        lineTotalBeforeDiscount: first !== null && first !== last ? first : null,
        loyaltyEarned: amount(raw.text, /(\d+,\d{2}) €\s*cagnott/),
    };
};

export type Cart = {
    itemCount: number | null;
    /** Estimated: promotions depend on the pickup date, the final amount may differ. */
    estimatedTotal: number | null;
    savings: number | null;
    loyaltyEarned: number | null;
    minimumOrder: number | null;
    lines: CartLine[];
};

export const parseCart = (text: string, lines: RawCartLine[]): Cart => {
    const flat = squash(text);
    const count = Number(/(\d+) articles?\b/.exec(flat)?.[1]);
    return {
        itemCount: Number.isInteger(count) ? count : null,
        estimatedTotal: amount(flat, /Total estimé\*? (\d+,\d{2}) €/),
        savings: amount(flat, /J.économise (\d+,\d{2}) €/),
        loyaltyEarned: amount(flat, /Je cagnotte (\d+,\d{2}) €/),
        minimumOrder: amount(flat, /Montant minimum de commande : (\d+(?:,\d{2})?) €/),
        lines: lines.flatMap((line) => parseCartLine(line) ?? []),
    };
};

export const getCart = async (site: Site): Promise<Cart> => {
    const page = await site.goto(`${ORIGIN}/panier`);
    const { text, lines } = await page.evaluate(() => ({
        // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps one line per displayed block
        text: document.body.innerText,
        lines: [...document.querySelectorAll("li.cart-row[data-tc-product-tile]")].map((row) => ({
            tracking: row.getAttribute("data-tc-product-tile"),
            // biome-ignore lint/performance/useDomNodeTextContent: see readTiles
            text: (row as HTMLElement).innerText,
            href: row.querySelector('a[href*="/p/"]')?.getAttribute("href") ?? null,
            quantity: row.querySelector<HTMLInputElement>('input[name="Quantity"]')?.value ?? null,
        })),
    }));
    return parseCart(text, lines);
};
