/**
 * The cart, as the `/panier` page shows it: lines with quantities and amounts after multi-buy
 * discounts, and the estimated total.
 */

import type { Page } from "patchright";
import { ORIGIN, type Site } from "../browser.ts";
import { euros, type Product, parseTile, type RawTile, squash } from "./catalog.ts";
import { getBookedSlot } from "./drive.ts";
import { callController, csrfToken } from "./form.ts";

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

/** Loads the cart page: the cart as shown, and the page (its csrf token serves writes). */
const loadCart = async (site: Site): Promise<{ page: Page; cart: Cart }> => {
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
    return { page, cart: parseCart(text, lines) };
};

export const getCart = async (site: Site) => ({
    ...(await loadCart(site)).cart,
    /** "Jeu. 29/10 de 12h00 à 13h00", or null when no pickup slot is booked. */
    bookedSlot: await getBookedSlot(site),
});

// --- Writes -----------------------------------------------------------------------------------

export type CartChange = {
    pid: string;
    name: string | null;
    before: number;
    after: number;
    /** Requested quantity; null when the change came from adding a whole list. */
    requested: number | null;
    done: boolean;
    /** Why the cart differs from the request, when it does. */
    note: string | null;
};

const quantityIn = (cart: Cart, pid: string): number =>
    cart.lines.find((line) => line.pid === pid)?.quantity ?? 0;

/**
 * The execution report: what the cart holds now against what was asked. Built from the cart as
 * the site shows it afterwards, never from what was sent.
 */
export const cartChanges = (
    requests: { pid: string; quantity: number }[],
    before: Cart,
    after: Cart,
    messages: Map<string, string>,
): CartChange[] =>
    requests.map(({ pid, quantity }) => {
        const now = quantityIn(after, pid);
        const name =
            after.lines.find((line) => line.pid === pid)?.name ??
            before.lines.find((line) => line.pid === pid)?.name ??
            null;
        const message = messages.get(pid) ?? null;
        const note =
            now === quantity
                ? null
                : (message ??
                  (now === 0
                      ? "Not added: the product is unavailable, unknown or out of stock."
                      : now < quantity
                        ? "Capped by the site (maximum quantity or stock)."
                        : "The site kept a higher quantity."));
        return {
            pid,
            name,
            before: quantityIn(before, pid),
            after: now,
            requested: quantity,
            done: now === quantity,
            note,
        };
    });

/** Lines whose quantity changed between two reads of the cart. */
export const cartDiff = (before: Cart, after: Cart): CartChange[] => {
    const pids = new Set([...before.lines, ...after.lines].map((line) => line.pid));
    return [...pids].flatMap((pid) => {
        const was = quantityIn(before, pid);
        const now = quantityIn(after, pid);
        if (was === now) return [];
        const name =
            (
                after.lines.find((line) => line.pid === pid) ??
                before.lines.find((line) => line.pid === pid)
            )?.name ?? null;
        return [{ pid, name, before: was, after: now, requested: null, done: true, note: null }];
    });
};

const summary = (cart: Cart) => ({
    itemCount: cart.itemCount,
    estimatedTotal: cart.estimatedTotal,
    minimumOrder: cart.minimumOrder,
});

/** A site message worth passing on, from a controller's JSON answer. */
const messageOf = (answer: Record<string, unknown> | null): string | null => {
    for (const key of ["error", "errorMessage", "message"]) {
        const value = answer?.[key];
        if (typeof value === "string" && value.trim() !== "") return squash(value);
    }
    return null;
};

/** Sets absolute quantities; 0 removes the product. */
export const setCartItems = async (site: Site, items: { pid: string; quantity: number }[]) => {
    const { page, cart: before } = await loadCart(site);
    const token = await csrfToken(page);
    const messages = new Map<string, string>();
    for (const { pid, quantity } of items) {
        const inCart = quantityIn(before, pid) > 0;
        if (!inCart && quantity === 0) continue;
        // In the cart, `update=true` sets the quantity; otherwise the product is added.
        const answer = await callController(site, "Cart-AddProduct", token, {
            pid,
            Quantity: String(quantity),
            quantity: String(quantity),
            update: String(inCart),
        });
        const message = messageOf(answer);
        if (message !== null) messages.set(pid, message);
    }
    const { cart: after } = await loadCart(site);
    return { changes: cartChanges(items, before, after, messages), cart: summary(after) };
};

/** "Ajouter la liste au panier": adds every available product of a list. */
export const addListToCart = async (site: Site, listId: string) => {
    const { page, cart: before } = await loadCart(site);
    const answer = await callController(site, "Wishlist-AddToCartWeb", await csrfToken(page), {
        listID: listId,
        productsIDs: "",
        isPreferred: "false",
    });
    const { cart: after } = await loadCart(site);
    return {
        siteMessage: messageOf(answer),
        changes: cartDiff(before, after),
        cart: summary(after),
    };
};
