/**
 * The store's catalogues ("prospectus") on magasins-u.com: current and upcoming promotions, with
 * their dates. magasins-u.com uses the same store id as coursesu.com, appended to its paths
 * (`….m12345`). A catalogue page holds all its products in its HTML and pages them in the browser,
 * so one load is enough; the tool hands them out 20 at a time.
 */

import type { Page } from "patchright";
import { type Site, ToolError } from "../browser.ts";
import { euros, squash } from "./catalog.ts";

const MAGASINS_U = "https://www.magasins-u.com";
const CATALOGUES = "/promotions/tous-les-catalogues";
const PAGE_SIZE = 20;
const SWITCH_TIMEOUT_MS = 30_000;

const MONTHS = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
];

/** "mardi 3 novembre 2026" → "2026-11-03". */
export const frenchDate = (text: string): string | null => {
    const match = /(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u.exec(text);
    const month = MONTHS.indexOf(match?.[2]?.toLowerCase() ?? "");
    if (match === null || month === -1) return null;
    return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1]?.padStart(2, "0")}`;
};

export type Catalogue = {
    /** For `get_catalogue`. */
    id: string;
    title: string;
    /** YYYY-MM-DD. */
    from: string | null;
    until: string | null;
    /** Starts after today: its prices are not on coursesu.com yet. */
    upcoming: boolean;
};

export const parseCatalogueCard = (
    raw: { title: string; dates: string[]; href: string },
    today: string,
): Catalogue | null => {
    const id = /\/tous-les-catalogues\/([^/.?]+)/.exec(raw.href)?.[1];
    if (id === undefined) return null;
    const from = frenchDate(raw.dates[0] ?? "");
    return {
        id,
        title: squash(raw.title),
        from,
        until: frenchDate(raw.dates[1] ?? ""),
        upcoming: from !== null && from > today,
    };
};

export type CatalogueProduct = {
    name: string;
    /** Pack size and variants: "Le paquet de 500 g". */
    description: string | null;
    /** "PROMOTION du 03/11 au 15/11", "AVANTAGES CARTE U du 03/11 au 15/11"… */
    banner: string | null;
    /** "LE 2EME A -60% DE REMISE IMMEDIATE", "20 % VERSÉS EN € CARTE U"… */
    offer: string | null;
    /** "SOIT 1€03 LE PRODUIT AVEC MA CARTE U". */
    offerDetail: string | null;
    /** The first price shown, in euros. */
    price: number | null;
    /** Every price line as displayed, with what each one buys and the price per kilo or litre. */
    prices: string | null;
};

type RawCatalogueTile = {
    name: string;
    description: string;
    banner: string;
    offer: string;
    offerDetail: string;
    price: string;
    prices: string;
};

const orNull = (text: string): string | null => {
    const value = squash(text);
    return value === "" ? null : value;
};

export const parseCatalogueTile = (raw: RawCatalogueTile): CatalogueProduct | null => {
    const name = squash(raw.name);
    if (name === "") return null;
    return {
        name,
        description: orNull(raw.description),
        banner: orNull(raw.banner),
        offer: orNull(raw.offer),
        offerDetail: orNull(raw.offerDetail),
        price: euros(/(\d+,\d{2})/.exec(raw.price)?.[1]),
        prices: orNull(raw.prices),
    };
};

/** Lowercase, without accents, for a forgiving search. */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export const matches = (product: CatalogueProduct, query: string): boolean => {
    const haystack = fold(`${product.name} ${product.description ?? ""}`);
    return fold(query)
        .split(/\s+/)
        .filter((word) => word !== "")
        .every((word) => haystack.includes(word));
};

/**
 * Opens a magasins-u.com page for the store selected on coursesu.com. The site remembers one store
 * in a cookie and redirects to it; when it remembers another one, its own landing page switches it.
 */
const openStorePage = async (site: Site, path: string): Promise<Page> => {
    const store = await site.storeId();
    if (store === null || !/^\d+$/.test(store)) {
        throw new ToolError("No store is selected on coursesu.com: select one on the site first.");
    }
    const suffix = `.m${store}`;
    const page = await site.goto(`${MAGASINS_U}${path}${suffix}`);
    if (new URL(page.url()).pathname.endsWith(suffix)) return page;
    await site.goto(`${MAGASINS_U}/landing/setMagasinContext${suffix}${path}`);
    await page.waitForURL((url) => url.pathname.endsWith(suffix), { timeout: SWITCH_TIMEOUT_MS });
    return page;
};

const parisToday = (): string => new Date().toLocaleDateString("sv", { timeZone: "Europe/Paris" });

export const getCatalogues = async (site: Site): Promise<Catalogue[]> => {
    const page = await openStorePage(site, CATALOGUES);
    const cards = await page.evaluate(() =>
        [...document.querySelectorAll(".u-c-tuile")].map((card) => ({
            title: card.querySelector(".u-c-tuile__link")?.textContent ?? "",
            dates: [...card.querySelectorAll("time")].map((time) => time.textContent ?? ""),
            href: card.querySelector(".u-c-tuile__link")?.getAttribute("href") ?? "",
        })),
    );
    const today = parisToday();
    return cards.flatMap((card) => parseCatalogueCard(card, today) ?? []);
};

export const getCatalogue = async (
    site: Site,
    catalogueId: string,
    query: string | undefined,
    pageNumber: number,
) => {
    const page = await openStorePage(site, `${CATALOGUES}/${catalogueId}`);
    const tiles = await page.evaluate(() => {
        const text = (tile: Element, selector: string) =>
            tile.querySelector(selector)?.textContent ?? "";
        return [...document.querySelectorAll(".u-tuile-produit[id]")].map((tile) => ({
            name: text(tile, ".product-description__name"),
            description: text(tile, ".product-description__description"),
            banner: text(tile, ".top-header .h4"),
            offer: text(tile, ".promotion__txt"),
            offerDetail: text(tile, ".description-economie-carte-u"),
            price: text(tile, ".product-price .selling-price"),
            prices: text(tile, ".product-price"),
        }));
    });
    if (tiles.length === 0) {
        throw new ToolError(`No catalogue ${catalogueId} for this store (see get_catalogues).`);
    }
    const products = tiles
        .flatMap((tile) => parseCatalogueTile(tile) ?? [])
        .filter((product) => !query || matches(product, query));
    const start = (pageNumber - 1) * PAGE_SIZE;
    return {
        catalogueId,
        matching: products.length,
        page: pageNumber,
        hasMore: start + PAGE_SIZE < products.length,
        products: products.slice(start, start + PAGE_SIZE),
    };
};
