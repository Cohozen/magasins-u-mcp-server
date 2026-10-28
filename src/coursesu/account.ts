/**
 * The "Mon compte" pages of coursesu.com: shopping lists, recent purchases and drive orders.
 *
 * These pages are server-rendered. Products on them carry the same tracking JSON as search tiles,
 * so `parseTile` reads them; the rest (order headers, list names) is read from visible text.
 * Parsers are pure and tested; the `get…` functions only load a page and hand over its text.
 */

import { ORIGIN, type Site } from "../browser.ts";
import {
    euros,
    type Product,
    parseTile,
    productGridPage,
    type RawTile,
    readTiles,
    squash,
} from "./catalog.ts";

// --- Lists ------------------------------------------------------------------------------------

export type ShoppingList = { id: string; name: string; productCount: number | null };

export const getLists = async (site: Site): Promise<ShoppingList[]> => {
    const page = await site.goto(`${ORIGIN}/mon-compte/mes-listes`);
    return page.evaluate(() =>
        [...document.querySelectorAll("li[data-listid]")].map((item) => {
            const count = Number(item.querySelector(".list-product-count")?.textContent);
            return {
                id: item.getAttribute("data-listid") ?? "",
                name: item.querySelector("a[title]")?.getAttribute("title")?.trim() ?? "",
                productCount: Number.isFinite(count) ? count : null,
            };
        }),
    );
};

export const getList = (site: Site, listId: string, page: number) =>
    productGridPage(
        site,
        `${ORIGIN}/mon-compte/mes-listes?listID=${encodeURIComponent(listId)}&isPref=false`,
        page,
    );

/** "Mes achats récents": products bought before, most relevant first. */
export const getRecentPurchases = (site: Site, page: number) =>
    productGridPage(site, `${ORIGIN}/mon-compte/mes-listes?isPref=true`, page);

// --- Orders -----------------------------------------------------------------------------------

export type OrderSummary = {
    id: string;
    /** YYYY-MM-DD. */
    date: string | null;
    /** "Drive", "Livraison"… */
    mode: string | null;
    /** "Retirée", "En préparation"… as displayed. */
    status: string | null;
    store: string | null;
    total: number | null;
};

const DATE = /(\d{2})\/(\d{2})\/(\d{4})/;
const isoDate = (text: string): string | null => {
    const match = DATE.exec(text);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
};
const lines = (text: string): string[] =>
    text
        .split("\n")
        .map((line) => squash(line))
        .filter((line) => line !== "");

/** One card of "Mes commandes": "Commande Drive du 23/10/2026 / Retirée / Nº … - store / 198,04 €". */
export const parseOrderCard = (id: string, text: string): OrderSummary => {
    const rows = lines(text);
    const headingAt = rows.findIndex((row) => /^Commande .* du /.test(row));
    const heading = rows[headingAt] ?? "";
    return {
        id,
        date: isoDate(heading),
        mode: /^Commande (.+?) du /.exec(heading)?.[1] ?? null,
        status: rows[headingAt + 1] ?? null,
        store:
            /^Nº\s*\d+\s*-\s*(.+)$/.exec(rows.find((row) => row.startsWith("Nº")) ?? "")?.[1] ??
            null,
        total: euros(/(\d+,\d{2})\s*€/.exec(text)?.[1]),
    };
};

export const getOrders = async (site: Site): Promise<OrderSummary[]> => {
    const page = await site.goto(`${ORIGIN}/mon-compte/mes-commandes`);
    const cards = await page.evaluate(() =>
        [...document.querySelectorAll(".su-order-block[data-order-id]")].map((card) => ({
            id: card.getAttribute("data-order-id") ?? "",
            // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps one line per displayed block
            text: (card as HTMLElement).innerText,
        })),
    );
    return cards.map((card) => parseOrderCard(card.id, card.text));
};

export type OrderLine = Product & {
    quantity: number | null;
    /** What the line cost in this order. Null when the site shows none (weighed item). */
    lineTotal: number | null;
};

export type Order = OrderSummary & {
    itemCount: number | null;
    payment: string | null;
    /** "OFFERTS" or an amount, as displayed. */
    preparationFee: string | null;
    /** The store could not supply some products; the site lists them on another page. */
    someUnavailable: boolean;
    lines: OrderLine[];
};

export const parseOrderLine = (raw: RawTile): OrderLine | null => {
    const product = parseTile(raw);
    if (product === null) return null;
    const quantity = Number(/Qté\s*:\s*(\d+)/.exec(raw.text)?.[1]);
    return {
        ...product,
        // On order lines the text above the name is the quantity, not a banner.
        badge: product.badge?.replace(/^Qté\s*:\s*\d+\s*/, "") || null,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
        // The first amount that is not a price per unit.
        lineTotal: euros(/(\d+,\d{2}) €(?!\s*\/)/.exec(raw.text)?.[1]),
    };
};

/** Header of an order page: "Votre commande Drive du 23/10/2026 (Nº 123)", status, totals. */
export const parseOrderPage = (id: string, text: string, tiles: RawTile[]): Order => {
    const rows = lines(text);
    const titleAt = rows.findIndex((row) => /^Votre commande .* du /.test(row));
    const title = rows[titleAt] ?? "";
    const status = (rows[titleAt + 1] ?? "").replace(/\s*Télécharger le récapitulatif$/, "");
    const after = (label: RegExp): string | null => {
        const at = rows.findIndex((row) => label.test(row));
        return at === -1 ? null : (rows[at + 1] ?? null);
    };
    const itemCount = Number(/^(\d+) articles?$/m.exec(rows.join("\n"))?.[1]);
    return {
        id,
        date: isoDate(title),
        mode: /^Votre commande (.+?) du /.exec(title)?.[1] ?? null,
        status: titleAt === -1 || status === "" ? null : status,
        store: titleAt === -1 ? null : (rows[titleAt + 2] ?? null),
        total: euros(/(\d+,\d{2})/.exec(after(/^Reste à payer$/) ?? "")?.[1]),
        itemCount: Number.isFinite(itemCount) ? itemCount : null,
        payment: rows.find((row) => /^Paiement /.test(row)) ?? null,
        preparationFee: after(/^Frais de préparation$/),
        someUnavailable: /certains produits étaient indisponibles/i.test(squash(text)),
        lines: tiles.flatMap((tile) => parseOrderLine(tile) ?? []),
    };
};

export const getOrder = async (site: Site, orderId: string): Promise<Order> => {
    const page = await site.goto(
        `${ORIGIN}/mon-compte/mes-commandes-encours/detail?orderId=${encodeURIComponent(orderId)}`,
    );
    const tiles = await readTiles(page, "[data-order-products] [data-tc-product-tile]", 500);
    // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps one line per displayed block
    const text = await page.evaluate(() => document.body.innerText);
    return parseOrderPage(orderId, text, tiles);
};
