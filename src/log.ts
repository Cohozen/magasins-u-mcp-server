/**
 * Minimal log: one JSON line per event, on stderr.
 *
 * Rule: never a cookie, a token, receipt contents or an address in a log line. Log the tool, the
 * duration, the state.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level | undefined) ?? "info"] ?? LEVELS.info;

const write = (level: Level, msg: string, extra?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return;
    console.error(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
};

export const log = {
    debug: (msg: string, extra?: Record<string, unknown>) => write("debug", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => write("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
};
