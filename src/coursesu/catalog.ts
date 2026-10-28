/**
 * Product search.
 *
 * A search costs **a single page load**: every result tile carries a tracking JSON in
 * `data-tc-product-tile` (id, EAN, brand, price, aisles, promotion). The rest — unit price,
 * displayed offer — is read from the tile's visible text. Nothing depends on the site's CSS
 * classes, only on that attribute and on the text.
 *
 * `parseTile` is pure and tested; only `searchProducts` touches the browser.
 */

import type { Page } from "patchright";
import { CONTROLLER, ORIGIN, type Site } from "../browser.ts";
import { decimalToCents, parsePackage } from "./package-label.ts";

/** What the page gives for one tile, uninterpreted. */
export type RawTile = { tracking: string | null; text: string; href: string | null };

type Tracking = {
    id?: string;
    name?: string;
    EAN?: string;
    brand?: string;
    price?: string;
    notation?: number | string;
    promotion?: { name?: string; endDate?: string };
    product_cat1?: string;
    product_cat2?: string;
    product_cat3?: string;
};

export type Product = {
    pid: string;
    ean: string | null;
    name: string;
    brand: string | null;
    /** In euros. Null until a store is selected. */
    price: number | null;
    /** Price per kilo, per litre…, as displayed. The promotional one when there is one. */
    unitPrice: { value: number; per: string } | null;
    /** Struck-through price, in euros, when the product is on promotion. */
    oldPrice: number | null;
    /** Displayed offer: "-34%", "-80% SUR LE 2ÈME", "2+1 OFFERT", "20% EN €"… */
    offer: string | null;
    /** Banner above the name: "PRIX BAS", "PROMOTION pour un retrait jusqu'au 01/11"… */
    badge: string | null;
    /**
     * Promotional operation, when the site describes it: "3,09 E/LOT 3 LESSIVE U X30 - 2 achetés
     * + 1 offert", valid until `until` (YYYY-MM-DD). Plain discounts often have no description:
     * `offer` and `oldPrice` are enough then.
     */
    promotion: { description: string; until: string | null } | null;
    /** Pack size read from the name: "2 x 140 g", "x12"… */
    package: string | null;
    /** Number of washes (laundry detergent), to compare per wash rather than per litre. */
    washes: number | null;
    pricePerWash: number | null;
    rating: number | null;
    aisle: string | null;
    url: string | null;
};

/** What the site shows when a product has no brand (loose produce). */
const NO_BRAND = "SANS MARQUE";

export const squash = (value: string): string => value.replace(/\s+/g, " ").trim();

export const euros = (value: string | null | undefined): number | null => {
    const cents = decimalToCents(value ?? null);
    return cents === null ? null : cents / 100;
};

/** "3x43 lavages" → 129, "50 lavages" → 50. */
export const washesOf = (name: string): number | null => {
    const match = /(?:(\d+)\s*x\s*)?(\d+)\s*lavages?\b/i.exec(name);
    if (match?.[2] === undefined) return null;
    return Number(match[2]) * (match[1] === undefined ? 1 : Number(match[1]));
};

export const parseTile = (raw: RawTile): Product | null => {
    if (raw.tracking === null) return null;
    let tracking: Tracking;
    try {
        tracking = JSON.parse(raw.tracking) as Tracking;
    } catch {
        return null;
    }
    if (tracking.id === undefined) return null;

    const name = squash(tracking.name ?? "");
    const text = squash(raw.text);
    const price = euros(tracking.price);
    const washes = washesOf(name);

    // A tile on promotion shows the old then the new unit price: the last one counts.
    const unitPrices = [...text.matchAll(/(\d+,\d{2}) €\/\s?([\p{L}.]+)/gu)];
    const lastUnit = unitPrices.at(-1);
    const unitValue = euros(lastUnit?.[1]);

    // Store-brand products display as "U Lessive…" while tracking says "Lessive…": the "U" is
    // part of the displayed name, not of the banner.
    const shown = text.includes(`U ${name}`) ? `U ${name}` : name;
    const nameAt = name === "" ? -1 : text.indexOf(shown);
    const badge = nameAt > 0 ? text.slice(0, nameAt).trim() : null;

    const promotionName = tracking.promotion?.name;
    const promotion =
        promotionName === undefined || promotionName === "unknown"
            ? null
            : {
                  description: squash(promotionName.replace(/<[^>]*>/g, " ")),
                  until: /^\d{4}-\d{2}-\d{2}$/.test(tracking.promotion?.endDate ?? "")
                      ? (tracking.promotion?.endDate ?? null)
                      : null,
              };

    const rating = Number(tracking.notation);
    const aisle = [tracking.product_cat1, tracking.product_cat2, tracking.product_cat3]
        .filter((part) => part !== undefined && part !== "")
        .join(" > ");

    return {
        pid: tracking.id,
        ean: tracking.EAN ?? null,
        name,
        brand: tracking.brand && tracking.brand !== NO_BRAND ? tracking.brand : null,
        price,
        unitPrice:
            lastUnit?.[2] !== undefined && unitValue !== null
                ? { value: unitValue, per: lastUnit[2] }
                : null,
        oldPrice: euros(/Ancien prix : (\d+,\d{2}) €/.exec(text)?.[1]),
        offer:
            /(-\d+ ?%(?: SUR LE \d+\S*)?|\d+ ?% EN €|\d+ ?\+ ?\d+ OFFERTS?)/i.exec(text)?.[1] ??
            null,
        badge: badge === "" ? null : badge,
        promotion,
        package: parsePackage(name).label,
        washes,
        pricePerWash:
            price !== null && washes !== null && washes > 0
                ? Math.round((price / washes) * 1000) / 1000
                : null,
        rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
        aisle: aisle === "" ? null : aisle,
        url: raw.href === null ? null : new URL(raw.href, ORIGIN).toString(),
    };
};

/** Grid tiles; product sheets and order lines carry the same JSON on other elements. */
export const GRID_TILE = "li[data-tc-product-tile]";

/** Reads the product tiles matching `selector`, uninterpreted. */
export const readTiles = (page: Page, selector: string, limit: number): Promise<RawTile[]> =>
    page.evaluate(
        ([scope, max]) =>
            [...document.querySelectorAll(scope)].slice(0, max).map((tile) => ({
                tracking: tile.getAttribute("data-tc-product-tile"),
                // biome-ignore lint/performance/useDomNodeTextContent: textContent glues neighbouring elements together ("12,25 €2,27 €/l"); innerText keeps the displayed separation
                text: (tile as HTMLElement).innerText,
                href: tile.querySelector('a[href*="/p/"]')?.getAttribute("href") ?? null,
            })),
        [selector, limit] as const,
    );

export const searchProducts = async (
    site: Site,
    query: string,
    limit: number,
): Promise<Product[]> => {
    const page = await site.goto(`${ORIGIN}/recherche?q=${encodeURIComponent(query)}`);
    const tiles = await readTiles(page, GRID_TILE, limit);
    return tiles.flatMap((tile) => parseTile(tile) ?? []);
};

/** Size of one results page on product grids (promotions, lists, recent purchases). */
export const PAGE_SIZE = 20;

/** One page of a product grid: `start` and `sz` work on every grid of the site. */
export const productGridPage = async (
    site: Site,
    url: string,
    page: number,
): Promise<{ page: number; hasMore: boolean; products: Product[] }> => {
    const target = new URL(url);
    target.searchParams.set("start", String((page - 1) * PAGE_SIZE));
    target.searchParams.set("sz", String(PAGE_SIZE));
    const loaded = await site.goto(target.toString());
    const products = (await readTiles(loaded, GRID_TILE, PAGE_SIZE)).flatMap(
        (tile) => parseTile(tile) ?? [],
    );
    return { page, hasMore: products.length === PAGE_SIZE, products };
};

/** Store promotions ("Promotions" menu), as a product grid. */
export const getPromotions = (site: Site, page: number) =>
    productGridPage(site, `${ORIGIN}/c/promotions?promos=cardu-promo`, page);

export type ProductDetails = Product & {
    nutriscore: string | null;
    /** Product sheet sections as displayed: "Ingrédients", "Valeurs nutritionnelles"… */
    details: Record<string, string>;
};

/** Raw product sheet: the main tile, the Nutri-Score label and the sections, uninterpreted. */
export type RawProductPage = {
    tile: RawTile | null;
    nutriscore: string | null;
    sections: [heading: string, text: string][];
};

/** Sections that carry no product information. */
const NOISE_SECTION = /^(conseils|idéal avec)$/i;

export const parseProductPage = (raw: RawProductPage): ProductDetails | null => {
    const product = raw.tile === null ? null : parseTile(raw.tile);
    if (product === null) return null;
    const details: Record<string, string> = {};
    for (const [heading, text] of raw.sections) {
        const key = squash(heading);
        const value = squash(text)
            // The Nutri-Score explanation is site boilerplate.
            .replace(/Le Nutri-score est un logo.*?(En savoir plus sur le Nutriscore)?$/i, "")
            .trim();
        if (key === "" || value === "" || NOISE_SECTION.test(key) || key in details) continue;
        details[key] = value;
    }
    return {
        ...product,
        nutriscore: /Nutriscore ([A-E])\b/i.exec(raw.nutriscore ?? "")?.[1]?.toUpperCase() ?? null,
        details,
    };
};

/** `1177338` or a product URL. */
export const productUrl = (product: string): string =>
    /^\d+$/.test(product)
        ? `${CONTROLLER}/Product-Show?pid=${product}`
        : new URL(product, ORIGIN).toString();

export const getProduct = async (site: Site, product: string): Promise<ProductDetails | null> => {
    const page = await site.goto(productUrl(product));
    const raw = await page.evaluate((): RawProductPage => {
        const content = document.querySelector("#product-content");
        const tracking = content?.querySelector("[data-tc-product-tile]");
        const sections: [string, string][] = [];
        for (const heading of document.querySelectorAll("h3.tab-label")) {
            const body = heading.closest("li")?.nextElementSibling as HTMLElement | null;
            // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps line breaks between paragraphs
            sections.push([heading.textContent ?? "", body?.innerText ?? ""]);
        }
        return {
            tile:
                content && tracking
                    ? {
                          tracking: tracking.getAttribute("data-tc-product-tile"),
                          // biome-ignore lint/performance/useDomNodeTextContent: see readTiles
                          text: (content as HTMLElement).innerText,
                          href: location.href,
                      }
                    : null,
            nutriscore:
                document.querySelector(".icon-nutriscore-pdp")?.getAttribute("aria-label") ?? null,
            sections,
        };
    });
    return parseProductPage(raw);
};
