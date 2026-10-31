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
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Site, ToolError } from "./browser.ts";
import { loadConfig } from "./config.ts";
import {
    changeList,
    createList,
    deleteList,
    getList,
    getLists,
    getOrder,
    getOrders,
    getRecentPurchases,
} from "./coursesu/account.ts";
import { addListToCart, getCart, setCartItems } from "./coursesu/cart.ts";
import { getProduct, getPromotions, searchProducts } from "./coursesu/catalog.ts";
import { getLoyalty, getReceipt, getReceipts } from "./coursesu/client-area.ts";
import { bookSlot, getSlots } from "./coursesu/drive.ts";
import { cancelOrder, placeOrder, prepareOrder } from "./coursesu/order.ts";
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
    if (error instanceof ToolError) {
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

    /** A tool: one queued site task, its result as JSON, failures told to the agent. */
    const tool = <Shape extends z.ZodRawShape>(
        name: string,
        title: string,
        description: string,
        inputSchema: Shape,
        task: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
        annotations: ToolAnnotations = { readOnlyHint: true, openWorldHint: true },
    ): void => {
        const callback = async (args: unknown): Promise<CallToolResult> => {
            try {
                return reply(await site.run(name, () => task(args as z.infer<z.ZodObject<Shape>>)));
            } catch (error) {
                return failure(error);
            }
        };
        // The SDK validates `args` against `inputSchema`; its callback type does not follow a
        // generic shape, hence the cast.
        server.registerTool(
            name,
            { title, description, inputSchema, annotations },
            callback as never,
        );
    };
    const WRITE: ToolAnnotations = {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
    };
    const DESTRUCTIVE: ToolAnnotations = {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
    };

    const page = z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(1)
        .describe("Results page, 20 products per page");

    tool(
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

    tool(
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

    tool(
        "get_promotions",
        "Store promotions",
        "Lists the products on promotion in the selected store, 20 per page, with the offer and its end date. Several hundred products are on promotion: prefer search_products for a given need, and browse a page or two at most.",
        { page },
        ({ page }) => getPromotions(site, page),
    );

    tool(
        "get_cart",
        "Cart",
        "Returns the cart: each line with quantity, amount after multi-buy discount and what it puts on the Carte U, then the estimated total, savings, the minimum order amount and the booked pickup slot. The total is an estimate: promotions depend on the pickup date.",
        {},
        () => getCart(site),
    );

    tool(
        "get_lists",
        "Shopping lists",
        "Lists the account's shopping lists on the site: id, name and number of products.",
        {},
        () => getLists(site),
    );

    tool(
        "get_list",
        "Shopping list content",
        "Returns the products of one shopping list, 20 per page, with current prices.",
        {
            listId: z.string().regex(/^\d+$/).describe("List id, from get_lists"),
            page,
        },
        ({ listId, page }) => getList(site, listId, page),
    );

    tool(
        "get_recent_purchases",
        "Recently bought products",
        'Returns the products the account bought before ("Mes achats récents"), 20 per page, with current prices. Useful to reorder usual products.',
        { page },
        ({ page }) => getRecentPurchases(site, page),
    );

    tool(
        "get_orders",
        "Drive orders",
        "Lists the account's drive orders: id, date, status, store and total.",
        {},
        () => getOrders(site),
    );

    tool(
        "get_order",
        "Drive order detail",
        "Returns one drive order: status, total, payment, and every line with the quantity ordered and what it cost. When the store could not supply some products, also lists them (unavailable) and the products the picker added instead or as asked (added), which can be refused at pickup.",
        { orderId: z.string().regex(/^\d+$/).describe("Order id, from get_orders") },
        ({ orderId }) => getOrder(site, orderId),
    );

    tool(
        "get_slots",
        "Pickup slots",
        "Lists the drive pickup slots of the selected store for the coming days, with how many orders are already booked on each. Reading slots books nothing.",
        {},
        () => getSlots(site),
    );

    tool(
        "get_receipts",
        "Till receipts",
        "Lists the purchases made with the Carte U over the last months (in store or drive): transaction id, date, amount, store, and whether a till receipt can be read with get_receipt.",
        {},
        () => getReceipts(site),
    );

    tool(
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

    tool(
        "get_loyalty",
        "Carte U balance and offers",
        "Returns the Carte U balance (euros to spend in store) and the digital offers: available to activate, activated, and used with what they earned.",
        {},
        () => getLoyalty(site),
    );

    const pid = z.string().regex(/^\d+$/).describe("Product id (pid), from another tool");
    const listId = z.string().regex(/^\d+$/).describe("List id, from get_lists");
    const listProducts = z
        .array(
            z.object({
                pid,
                name: z
                    .string()
                    .trim()
                    .min(1)
                    .max(255)
                    .describe("Product name, as returned by the site"),
            }),
        )
        .min(1)
        .max(30);

    tool(
        "set_cart_items",
        "Set cart quantities",
        "Sets the quantity of products in the cart: adds them, changes their quantity, or removes them with quantity 0. Quantities are absolute, not added to what the cart holds. Returns an execution report built from the cart afterwards: for each product the quantity before, after, and why it differs from the request (unavailable, capped). Only change the cart as the user asked.",
        {
            items: z
                .array(
                    z.object({
                        pid,
                        quantity: z
                            .number()
                            .int()
                            .min(0)
                            .max(24)
                            .describe("Quantity wanted; 0 removes"),
                    }),
                )
                .min(1)
                .max(30),
        },
        ({ items }) => setCartItems(site, items),
        WRITE,
    );

    tool(
        "add_list_to_cart",
        "Add a list to the cart",
        'Adds every available product of a shopping list to the cart, as the site\'s "Ajouter la liste au panier" button does. Returns the cart lines that changed and the new total.',
        { listId },
        ({ listId }) => addListToCart(site, listId),
        WRITE,
    );

    tool(
        "create_list",
        "Create a shopping list",
        "Creates an empty shopping list on the account. Returns the new list and its id.",
        { name: z.string().trim().min(1).max(60).describe("List name") },
        ({ name }) => createList(site, name),
        WRITE,
    );

    tool(
        "delete_list",
        "Delete a shopping list",
        "Deletes a shopping list and its products, for good. Ask the user for an explicit confirmation naming the list first, then call with confirm: true.",
        {
            listId,
            confirm: z.literal(true).describe("true once the user confirmed this deletion"),
        },
        ({ listId }) => deleteList(site, listId),
        DESTRUCTIVE,
    );

    tool(
        "add_to_list",
        "Add products to a list",
        "Adds products to a shopping list. Returns the list's product count before and after.",
        { listId, products: listProducts },
        ({ listId, products }) => changeList(site, listId, "add", products),
        WRITE,
    );

    tool(
        "remove_from_list",
        "Remove products from a list",
        "Removes products from a shopping list. Returns the list's product count before and after.",
        { listId, products: listProducts },
        ({ listId, products }) => changeList(site, listId, "remove", products),
        DESTRUCTIVE,
    );

    tool(
        "book_slot",
        "Book a pickup slot",
        "Reserves a drive pickup slot (from get_slots) for the current cart. It orders and pays nothing; the reservation lasts a limited time and promotions may depend on the pickup date. Book only the slot the user chose.",
        { slotId: z.string().regex(/^\d+$/).describe("Slot id, from get_slots") },
        ({ slotId }) => bookSlot(site, slotId),
        WRITE,
    );

    tool(
        "prepare_order",
        "Prepare the order",
        "Checks that the cart can be ordered (booked slot, minimum amount, payment at pickup offered) and returns the summary to show the user: lines, estimated total, slot, payment at pickup. Returns a token valid 10 minutes for place_order. Orders nothing.",
        {},
        () => prepareOrder(site),
    );

    tool(
        "place_order",
        "Place the order",
        "Places the drive order prepared by prepare_order, paid at pickup. Call it only after showing the user the prepare_order summary and getting an explicit yes. Refused if the cart, its total or the slot changed since, or if the server does not allow orders. Returns the new order as the order list shows it.",
        {
            token: z.string().uuid().describe("Token from prepare_order"),
            confirm: z.literal(true).describe("true once the user confirmed this order"),
        },
        ({ token }) => placeOrder(site, token, config.allowPlaceOrder),
        WRITE,
    );

    tool(
        "cancel_order",
        "Cancel an order",
        "Cancels an order not yet collected, when the site allows it online. Ask the user for an explicit confirmation naming the order first, then call with confirm: true. Returns the order status afterwards.",
        {
            orderId: z.string().regex(/^\d+$/).describe("Order id, from get_orders"),
            confirm: z.literal(true).describe("true once the user confirmed this cancellation"),
        },
        ({ orderId }) => cancelOrder(site, orderId),
        DESTRUCTIVE,
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
