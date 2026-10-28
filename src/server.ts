/**
 * Entry point: an MCP server over HTTP (Streamable HTTP, stateless), protected by a token.
 *
 * Every HTTP request gets its own `McpServer`: that is the SDK's stateless mode, which avoids any
 * request-id collision between clients. The browser itself is single and shared.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Site, SiteUnavailableError } from "./browser.ts";
import { loadConfig } from "./config.ts";
import { getList, getLists, getOrder, getOrders, getRecentPurchases } from "./coursesu/account.ts";
import { getCart } from "./coursesu/cart.ts";
import { getProduct, getPromotions, searchProducts } from "./coursesu/catalog.ts";
import { getLoyalty, getReceipt, getReceipts } from "./coursesu/client-area.ts";
import { getSlots } from "./coursesu/drive.ts";
import { log } from "./log.ts";

const config = loadConfig();
const site = new Site(config);

// One source of truth for the version: package.json, bumped by release-please.
// `../package.json` resolves from both `src/` (development) and `dist/` (image).
const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

/** Sent to every client at connection time: how an agent should use this server. */
const INSTRUCTIONS = `This server acts on the user's own Courses U account (Super U / Hyper U grocery drive in France) through a real browser session, at a human pace.
- Product data (names, offers, aisles) is in French, as on the site. Search in French.
- Call only what the user's request needs. One well-chosen search beats several; never collect the catalogue in bulk. Site requests are capped per day.
- To find the cheapest product, compare unitPrice (or pricePerWash for laundry detergent), not price, and point out multi-buy offers.
- Never change the account (cart, lists, slots, orders) unless the user asked for that exact change. An order always needs the user's explicit confirmation.
- If a tool says a login or a Cloudflare check is needed, pass the link and the instructions on to the user, then stop: do not retry until they say it is done.`;

const authorized = (request: IncomingMessage): boolean => {
    const expected = Buffer.from(`Bearer ${config.mcpToken}`);
    const received = Buffer.from(request.headers.authorization ?? "");
    return received.length === expected.length && timingSafeEqual(received, expected);
};

const reply = (data: unknown): CallToolResult => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
});

/** An expected unavailability is told to the agent; anything else is logged and summarised. */
const failure = (error: unknown): CallToolResult => {
    if (error instanceof SiteUnavailableError) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    log.error("unexpected error", { error: String(error) });
    return {
        isError: true,
        content: [{ type: "text", text: "Unexpected server error; see the container log." }],
    };
};

const buildServer = (): McpServer => {
    const server = new McpServer({ name: "magasins-u", version }, { instructions: INSTRUCTIONS });

    server.registerTool(
        "session_status",
        {
            title: "Courses U session status",
            description:
                "Tells whether the server is signed in to the Courses U account, which store is selected and how many site requests were made today. When a human action is needed (login, Cloudflare check), returns the link to pass on to the person.",
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async () => {
            const blocking = site.unavailableMessage();
            const base = {
                state: site.state,
                loginAt: site.loginAt,
                requestsToday: site.requestsToday,
                dailyCap: config.dailyCap,
                expectedStoreId: config.storeId,
            };
            if (blocking !== null) {
                return reply({
                    ...base,
                    authenticated: false,
                    humanActionUrl: site.humanActionUrl(),
                    message: blocking,
                });
            }
            try {
                const authenticated = await site.run("session_status", () => site.authenticated());
                const storeId = await site.storeId();
                const mismatch = config.storeId !== null && storeId !== config.storeId;
                return reply({
                    ...base,
                    state: site.state,
                    authenticated,
                    storeId,
                    message: mismatch
                        ? `The selected store (${storeId ?? "none"}) is not the expected one (${config.storeId}): prices will be another store's.`
                        : null,
                });
            } catch (error) {
                return failure(error);
            }
        },
    );

    /** A read-only tool: one queued site task, its result as JSON, failures told to the agent. */
    const readTool = <Shape extends z.ZodRawShape>(
        name: string,
        title: string,
        description: string,
        inputSchema: Shape,
        task: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
    ): void => {
        const callback = async (args: unknown): Promise<CallToolResult> => {
            try {
                return reply(await site.run(name, () => task(args as z.infer<z.ZodObject<Shape>>)));
            } catch (error) {
                return failure(error);
            }
        };
        server.registerTool(
            name,
            {
                title,
                description,
                inputSchema,
                annotations: { readOnlyHint: true, openWorldHint: true },
            },
            // The SDK validates `args` against `inputSchema`; its callback type does not follow a
            // generic shape, hence the cast.
            callback as never,
        );
    };

    const page = z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(1)
        .describe("Results page, 20 products per page");

    readTool(
        "search_products",
        "Search products",
        'Searches Courses U products in the selected store and returns the first results: price, price per kilo or litre, promotion, pack size and, for laundry detergent, price per wash. Product data is in French, as on the site. To find the cheapest, compare unitPrice (or pricePerWash), not price. These are single-item prices: a multi-buy offer (offer "2+1 OFFERT", "-80% SUR LE 2ÈME", details in promotion) lowers the real price when buying several, which is worth pointing out. Returns the first results page only (about twenty products).',
        {
            query: z
                .string()
                .trim()
                .min(2)
                .max(100)
                .describe('Search terms, in French, e.g. "lessive liquide"'),
            limit: z
                .number()
                .int()
                .min(1)
                .max(30)
                .default(15)
                .describe("Number of results (30 at most)"),
        },
        async ({ query, limit }) => {
            const products = await searchProducts(site, query, limit);
            return { query, count: products.length, products };
        },
    );

    readTool(
        "get_product",
        "Product sheet",
        "Returns a product's sheet: price and promotion as in search results, plus Nutri-Score, ingredients, nutrition values, legal name, storage and other sections as displayed (in French).",
        {
            product: z
                .string()
                .trim()
                .min(1)
                .max(300)
                .describe("Product id (pid) from another tool, or the product URL"),
        },
        async ({ product }) =>
            (await getProduct(site, product)) ?? { error: "No product found at this address." },
    );

    readTool(
        "get_promotions",
        "Store promotions",
        "Lists the products on promotion in the selected store, 20 per page, with the offer and its end date. Several hundred products are on promotion: prefer search_products for a given need, and browse a page or two at most.",
        { page },
        ({ page }) => getPromotions(site, page),
    );

    readTool(
        "get_cart",
        "Cart",
        "Returns the cart: each line with quantity, amount after multi-buy discount and what it puts on the Carte U, then the estimated total, savings and the minimum order amount. The total is an estimate: promotions depend on the pickup date.",
        {},
        () => getCart(site),
    );

    readTool(
        "get_lists",
        "Shopping lists",
        "Lists the account's shopping lists on the site: id, name and number of products.",
        {},
        () => getLists(site),
    );

    readTool(
        "get_list",
        "Shopping list content",
        "Returns the products of one shopping list, 20 per page, with current prices.",
        {
            listId: z.string().regex(/^\d+$/).describe("List id, from get_lists"),
            page,
        },
        ({ listId, page }) => getList(site, listId, page),
    );

    readTool(
        "get_recent_purchases",
        "Recently bought products",
        'Returns the products the account bought before ("Mes achats récents"), 20 per page, with current prices. Useful to reorder usual products.',
        { page },
        ({ page }) => getRecentPurchases(site, page),
    );

    readTool(
        "get_orders",
        "Drive orders",
        "Lists the account's drive orders: id, date, status, store and total.",
        {},
        () => getOrders(site),
    );

    readTool(
        "get_order",
        "Drive order detail",
        "Returns one drive order: status, total, payment, and every line with the quantity ordered and what it cost.",
        { orderId: z.string().regex(/^\d+$/).describe("Order id, from get_orders") },
        ({ orderId }) => getOrder(site, orderId),
    );

    readTool(
        "get_slots",
        "Pickup slots",
        "Lists the drive pickup slots of the selected store for the coming days, with how many orders are already booked on each. Reading slots books nothing.",
        {},
        () => getSlots(site),
    );

    readTool(
        "get_receipts",
        "Till receipts",
        "Lists the purchases made with the Carte U over the last months (in store or drive): transaction id, date, amount, store, and whether a till receipt can be read with get_receipt.",
        {},
        () => getReceipts(site),
    );

    readTool(
        "get_receipt",
        "Till receipt detail",
        "Reads one till receipt: every line as printed (label, quantity or weight, unit price, amount, line rebate), immediate discounts and totals. The receipt is checked for consistency; one that does not add up is refused rather than returned wrong.",
        {
            transactionId: z
                .string()
                .regex(/^[\w-]{8,64}$/)
                .describe("Transaction id, from get_receipts"),
        },
        ({ transactionId }) => getReceipt(site, transactionId),
    );

    readTool(
        "get_loyalty",
        "Carte U balance and offers",
        "Returns the Carte U balance (euros to spend in store) and the digital offers: available to activate, activated, and used with what they earned.",
        {},
        () => getLoyalty(site),
    );

    return server;
};

const http = createServer(async (request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
        response.writeHead(404).end();
        return;
    }
    if (!authorized(request)) {
        response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
        return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
        void transport.close();
        void server.close();
    });
    try {
        await server.connect(transport);
        await transport.handleRequest(request, response);
    } catch (error) {
        log.error("MCP request", { error: String(error) });
        if (!response.headersSent) response.writeHead(500).end();
    }
});

const shutdown = async (signal: string): Promise<void> => {
    log.info("shutting down", { signal });
    http.close();
    await site.stop().catch(() => undefined);
    process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

http.listen(config.port, config.host, () =>
    log.info("MCP server ready", { host: config.host, port: config.port }),
);
await site.start();
