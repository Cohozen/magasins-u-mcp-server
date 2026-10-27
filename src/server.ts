/**
 * Entry point: an MCP server over HTTP (Streamable HTTP, stateless), protected by a token.
 *
 * Every HTTP request gets its own `McpServer`: that is the SDK's stateless mode, which avoids any
 * request-id collision between clients. The browser itself is single and shared.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Site, SiteUnavailableError } from "./browser.ts";
import { loadConfig } from "./config.ts";
import { searchProducts } from "./coursesu/catalog.ts";
import { log } from "./log.ts";

const config = loadConfig();
const site = new Site(config);

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
    const server = new McpServer({ name: "magasins-u", version: "0.1.0" });

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

    server.registerTool(
        "search_products",
        {
            title: "Search products",
            description:
                'Searches Courses U products in the selected store and returns the first results: price, price per kilo or litre, promotion, pack size and, for laundry detergent, price per wash. Product data is in French, as on the site. To find the cheapest, compare unitPrice (or pricePerWash), not price. These are single-item prices: a multi-buy offer (offer "2+1 OFFERT", "-80% SUR LE 2ÈME", details in promotion) lowers the real price when buying several, which is worth pointing out. Returns the first results page only (about twenty products).',
            inputSchema: {
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
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ query, limit }) => {
            try {
                const products = await site.run("search_products", () =>
                    searchProducts(site, query, limit),
                );
                return reply({ query, count: products.length, products });
            } catch (error) {
                return failure(error);
            }
        },
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
