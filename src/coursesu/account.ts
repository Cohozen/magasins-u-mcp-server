/**
 * The "Mon compte" pages of coursesu.com: shopping lists, recent purchases and drive orders.
 *
 * These pages are server-rendered. Products on them carry the same tracking JSON as search tiles,
 * so `parseTile` reads them; the rest (order headers, list names) is read from visible text.
 * Parsers are pure and tested; the `get…` functions only load a page and hand over its text.
 */

import type { Page } from "patchright";
import { ORIGIN, type Site, ToolError } from "../browser.ts";
import {
    euros,
    type Product,
    parseTile,
    productGridPage,
    type RawTile,
    readTiles,
    squash,
} from "./catalog.ts";
import { callController, csrfToken } from "./form.ts";

// --- Lists ------------------------------------------------------------------------------------

export type ShoppingList = { id: string; name: string; productCount: number | null };

const loadLists = async (site: Site): Promise<{ page: Page; lists: ShoppingList[] }> => {
    const page = await site.goto(`${ORIGIN}/mon-compte/mes-listes`);
    const lists = await page.evaluate(() =>
        [...document.querySelectorAll("li[data-listid]")].map((item) => {
            const count = Number(item.querySelector(".list-product-count")?.textContent);
            return {
                id: item.getAttribute("data-listid") ?? "",
                name: item.querySelector("a[title]")?.getAttribute("title")?.trim() ?? "",
                productCount: Number.isFinite(count) ? count : null,
            };
        }),
    );
    return { page, lists };
};

export const getLists = async (site: Site): Promise<ShoppingList[]> =>
    (await loadLists(site)).lists;

/** A list write, then the lists as the site shows them afterwards: the execution report. */
const listWrite = async (
    site: Site,
    write: (token: string, before: ShoppingList[]) => Promise<Record<string, unknown> | null>,
) => {
    const { page, lists: before } = await loadLists(site);
    const answer = await write(await csrfToken(page), before);
    const { lists: after } = await loadLists(site);
    const error = answer?.error;
    return {
        siteError: typeof error === "string" && error !== "" ? error : null,
        before,
        after,
    };
};

const requireList = (lists: ShoppingList[], listId: string): ShoppingList => {
    const list = lists.find((candidate) => candidate.id === listId);
    if (list === undefined)
        throw new ToolError(`No list ${listId} on the account (see get_lists).`);
    return list;
};

/** The site names a new list "Liste du <date>" unless given a name. */
export const createList = async (site: Site, name: string) => {
    const { siteError, before, after } = await listWrite(site, (token) =>
        callController(site, "Wishlist-CreateMyWishlistWeb", token, { listName: name }, "GET"),
    );
    const created = after.filter((list) => !before.some((old) => old.id === list.id));
    return { done: created.length === 1, created: created[0] ?? null, siteError };
};

export const deleteList = async (site: Site, listId: string) => {
    const { siteError, after } = await listWrite(site, (token, before) =>
        callController(site, "Wishlist-EditListV2", token, {
            listId,
            listName: requireList(before, listId).name,
            action: "remove",
        }),
    );
    return { done: !after.some((list) => list.id === listId), siteError, lists: after };
};

/** Renames a list, as the list page does when its title is edited. */
export const renameList = async (site: Site, listId: string, name: string) => {
    const { siteError, after } = await listWrite(site, (token, before) => {
        requireList(before, listId);
        return callController(site, "Wishlist-EditListV2", token, {
            listId,
            isPref: "false",
            listInfo: JSON.stringify({ items: [], listName: name }),
            action: "edit",
        });
    });
    const list = after.find((candidate) => candidate.id === listId) ?? null;
    return { done: list?.name === name, list, siteError };
};

const listInfo = (products: { pid: string; name: string }[]): string =>
    JSON.stringify({
        items: products.map(({ pid, name }) => ({
            codeUC: pid,
            pdtName: name.slice(0, 255),
            quantity: 1,
        })),
    });

/** Adds products to a list, or removes them. Reports the list's product count before and after. */
export const changeList = async (
    site: Site,
    listId: string,
    action: "add" | "remove",
    products: { pid: string; name: string }[],
) => {
    const { siteError, before, after } = await listWrite(site, (token, lists) => {
        requireList(lists, listId);
        return callController(
            site,
            action === "add" ? "Wishlist-AddToLists" : "Wishlist-RemoveFromLists",
            token,
            {
                listIds: listId,
                ...(action === "add" ? { isPref: "false" } : {}),
                listInfo: listInfo(products),
                action,
            },
        );
    });
    return {
        listId,
        productCountBefore: requireList(before, listId).productCount,
        productCountAfter: after.find((list) => list.id === listId)?.productCount ?? null,
        siteError,
    };
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
    /** For an order not collected yet: "05/11/2026 de 10h00 à 11h00". */
    pickup: string | null;
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
        pickup: null,
    };
};

const PICKUP = "Retrait prévu le ";
/** "Retrait prévu le 05/11/2026 de 10h00 à 11h00" → "05/11/2026 de 10h00 à 11h00". */
const pickupOf = (rows: string[]): string | null =>
    rows.find((row) => row.startsWith(PICKUP))?.slice(PICKUP.length) ?? null;

/**
 * The banner of an order not collected yet: "Votre commande Drive en cours Nº …", then the
 * pickup slot and the store. Its status is the highlighted step, read apart from the text.
 */
export const parseCurrentOrder = (
    id: string,
    text: string,
    status: string | null,
): OrderSummary => {
    const rows = lines(text);
    const pickupAt = rows.findIndex((row) => row.startsWith(PICKUP));
    return {
        id,
        date: null,
        mode: /^Votre commande (.+?) en cours/.exec(rows[0] ?? "")?.[1] ?? null,
        status: status === null ? null : squash(status),
        store: pickupAt === -1 ? null : (rows[pickupAt + 1] ?? null),
        total: null,
        pickup: pickupOf(rows),
    };
};

export const getOrders = async (site: Site): Promise<OrderSummary[]> => {
    const page = await site.goto(`${ORIGIN}/mon-compte/mes-commandes`);
    const { current, past } = await page.evaluate(() => ({
        current: [...document.querySelectorAll(".su-order-current")].map((block) => ({
            id: block.querySelector("[data-order-id]")?.getAttribute("data-order-id") ?? "",
            // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps one line per displayed block
            text: (block as HTMLElement).innerText,
            status: block.querySelector(".su-order-current-state-active")?.textContent ?? null,
        })),
        past: [...document.querySelectorAll(".su-order-block[data-order-id]")].map((card) => ({
            id: card.getAttribute("data-order-id") ?? "",
            // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps one line per displayed block
            text: (card as HTMLElement).innerText,
        })),
    }));
    return [
        ...current
            .filter((order) => order.id !== "")
            .map((order) => parseCurrentOrder(order.id, order.text, order.status)),
        ...past.map((card) => parseOrderCard(card.id, card.text)),
    ];
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
    /** The store could not supply some products, listed in `unavailable`. */
    someUnavailable: boolean;
    lines: OrderLine[];
    /** Ordered products the store could not supply. */
    unavailable: SubstitutionLine[];
    /** Products the picker added, as replacements or as asked; they can be refused at pickup. */
    added: SubstitutionLine[];
};

/** A product of the "Produits indisponibles" page. Quantity ordered, or prepared for an added one. */
export type SubstitutionLine = { pid: string | null; name: string; quantity: number | null };

/** "Quantité commandée : 2" or "Quantité préparée : 1" → 2 or 1. */
export const substitutionLine = (raw: {
    pid: string | null;
    name: string;
    quantity: string;
}): SubstitutionLine => {
    const quantity = Number(/:\s*(\d+)/.exec(raw.quantity)?.[1]);
    return {
        pid: raw.pid,
        name: squash(raw.name),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
    };
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

/**
 * Header of an order page: "Votre commande Drive du 23/10/2026 (Nº 123)", status, totals. Before
 * pickup the page lists every step ("Validée", "En préparation", "Prête") then the slot and the
 * store; `currentStep` is the highlighted one.
 */
export const parseOrderPage = (
    id: string,
    text: string,
    tiles: RawTile[],
    currentStep: string | null = null,
): Order => {
    const rows = lines(text);
    const pickupAt = rows.findIndex((row) => row.startsWith(PICKUP));
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
        status:
            currentStep !== null
                ? squash(currentStep)
                : titleAt === -1 || status === ""
                  ? null
                  : status,
        store:
            pickupAt !== -1
                ? (rows[pickupAt + 1] ?? null)
                : titleAt === -1
                  ? null
                  : (rows[titleAt + 2] ?? null),
        // "Reste à payer" once collected, "Total estimé" before.
        total: euros(
            /(\d+,\d{2})/.exec(after(/^Reste à payer$/) ?? after(/^Total estimé/) ?? "")?.[1],
        ),
        pickup: pickupOf(rows),
        itemCount: Number.isFinite(itemCount) ? itemCount : null,
        payment: rows.find((row) => /^Paiement /.test(row)) ?? null,
        preparationFee: after(/^Frais de préparation$/),
        someUnavailable: /certains produits étaient indisponibles/i.test(squash(text)),
        lines: tiles.flatMap((tile) => parseOrderLine(tile) ?? []),
        unavailable: [],
        added: [],
    };
};

/** The "Produits indisponibles" page of an order: what was missing, and what was added instead. */
const getSubstitutions = async (site: Site, orderId: string) => {
    const page = await site.goto(
        `${ORIGIN}/mon-compte/mes-commandes-encours/detail/info?orderId=${encodeURIComponent(orderId)}`,
    );
    const read = (block: string) =>
        page.evaluate(
            (scope) =>
                [...document.querySelectorAll(`.substitution-block.${scope} .su-product-tile`)].map(
                    (tile) => ({
                        pid:
                            tile.querySelector("[data-info-id]")?.getAttribute("data-info-id") ??
                            null,
                        name: tile.querySelector(".product-name-link")?.textContent ?? "",
                        quantity: tile.querySelector(".product-quantity-label")?.textContent ?? "",
                    }),
                ),
            block,
        );
    return {
        unavailable: (await read("unavailable-products")).map(substitutionLine),
        added: (await read("added-products")).map(substitutionLine),
    };
};

export const getOrder = async (site: Site, orderId: string): Promise<Order> => {
    const page = await site.goto(
        `${ORIGIN}/mon-compte/mes-commandes-encours/detail?orderId=${encodeURIComponent(orderId)}`,
    );
    const tiles = await readTiles(page, "[data-order-products] [data-tc-product-tile]", 500);
    const { text, step } = await page.evaluate(() => ({
        // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps one line per displayed block
        text: document.body.innerText,
        step: document.querySelector(".su-order-current-state-active")?.textContent ?? null,
    }));
    const order = parseOrderPage(orderId, text, tiles, step);
    return order.someUnavailable ? { ...order, ...(await getSubstitutions(site, orderId)) } : order;
};
