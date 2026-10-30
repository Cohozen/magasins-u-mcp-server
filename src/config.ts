/**
 * Configuration, read once from the environment. An invalid value stops the startup: a loud
 * refusal beats a server running with a setting other than the one you think.
 */

export type Range = readonly [min: number, max: number];

export type Config = {
    mcpToken: string;
    host: string;
    port: number;
    dataDir: string;
    storeId: string | null;
    browserChannel: "chromium" | "chrome";
    /** Random pause between two site requests, in milliseconds. */
    delayMs: Range;
    dailyCap: number;
    blockCooldownHours: number;
    /** Interval between two keep-alive visits, in minutes. */
    keepaliveDayMin: Range;
    keepaliveNightMin: Range;
    /** Start and end hours of the night ("23-07"). */
    nightHours: Range;
    pageTimeoutMs: number;
    vncHost: string;
    vncPort: number;
};

/** Longest allowed gap between two keep-alive visits, in minutes. */
const KEEPALIVE_CEILING_MIN = 30;

const raw = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value === "" ? undefined : value;
};

const integer = (name: string, fallback: number): number => {
    const value = raw(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid: "${value}"`);
    return parsed;
};

/** "20-30" → [20, 30]. */
export const parseRange = (name: string, value: string): Range => {
    const match = /^(\d+)\s*-\s*(\d+)$/.exec(value);
    if (match?.[1] === undefined || match[2] === undefined) {
        throw new Error(`${name} is invalid: "${value}" (expected "min-max")`);
    }
    return [Number(match[1]), Number(match[2])];
};

const range = (name: string, fallback: string): Range => parseRange(name, raw(name) ?? fallback);

/** An ordered range under an optional ceiling: checked here rather than at use. */
const ordered = (name: string, [min, max]: Range, ceiling?: number): Range => {
    if (min > max) throw new Error(`${name}: the minimum is above the maximum`);
    if (ceiling !== undefined && max > ceiling)
        throw new Error(`${name}: ${max} is above ${ceiling}`);
    return [min, max];
};

export const loadConfig = (): Config => {
    const mcpToken = raw("MCP_TOKEN");
    if (mcpToken === undefined || mcpToken.length < 24) {
        throw new Error("MCP_TOKEN is missing or too short (24 characters at least)");
    }

    const channel = raw("BROWSER_CHANNEL") ?? "chromium";
    if (channel !== "chromium" && channel !== "chrome") {
        throw new Error(`BROWSER_CHANNEL is invalid: "${channel}" (chromium or chrome)`);
    }

    const nightHours = range("NIGHT_HOURS", "23-07");
    if (nightHours[0] > 23 || nightHours[1] > 23)
        throw new Error("NIGHT_HOURS: hours from 0 to 23");

    return {
        mcpToken,
        host: raw("HOST") ?? "0.0.0.0",
        port: integer("PORT", 8000),
        dataDir: raw("DATA_DIR") ?? "./data",
        storeId: raw("STORE_ID") ?? null,
        browserChannel: channel,
        delayMs: ordered("DELAY_MS", range("DELAY_MS", "3000-8000")),
        dailyCap: integer("DAILY_REQUEST_CAP", 300),
        blockCooldownHours: integer("BLOCK_COOLDOWN_H", 24),
        // Capped at 30 minutes: the site drops the session after 30 to 45 minutes without a
        // visit (measured: every 30-minute gap held, both 44-minute gaps lost the session).
        keepaliveDayMin: ordered(
            "KEEPALIVE_DAY_MIN",
            range("KEEPALIVE_DAY_MIN", "18-26"),
            KEEPALIVE_CEILING_MIN,
        ),
        keepaliveNightMin: ordered(
            "KEEPALIVE_NIGHT_MIN",
            range("KEEPALIVE_NIGHT_MIN", "18-26"),
            KEEPALIVE_CEILING_MIN,
        ),
        nightHours,
        pageTimeoutMs: integer("PAGE_TIMEOUT_MS", 30_000),
        vncHost: raw("VNC_HOST") ?? "<docker-host-ip>",
        vncPort: integer("VNC_PORT", 6080),
    };
};
