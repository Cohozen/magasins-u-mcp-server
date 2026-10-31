/**
 * The browser: the only thing that talks to the site.
 *
 * Everything goes through here so the rules hold whichever tool is called:
 * - **one site call at a time** (the `run` queue), with a **random pause** between two requests
 *   and a **daily cap**;
 * - **the session survives a restart**: session cookies (which Chromium drops on exit) are saved
 *   after every call and injected again at launch. Never Cloudflare's: injecting a stale
 *   `cf_clearance` triggered a challenge during prototyping;
 * - **a keep-alive visit** reloads a page every 18–26 minutes, day and night, because the site
 *   drops the session after 30 to 45 minutes of inactivity;
 * - **a Cloudflare challenge or an expired session stops everything** and opens noVNC so that a
 *   person can act. The server never ticks a box and never retries in a loop.
 */

import { randomInt } from "node:crypto";
import { appendFile, mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type BrowserContext, type Cookie, chromium, type Page, type Response } from "patchright";
import type { Config, Range } from "./config.ts";
import { log } from "./log.ts";
import { startVnc, type Vnc } from "./vnc.ts";

export const ORIGIN = "https://www.coursesu.com";
export const CONTROLLER = `${ORIGIN}/on/demandware.store/Sites-DigitalU-Site/fr_FR`;
const AUTH_URL = `${CONTROLLER}/Account-GetAuthenticationInfo?format=ajax`;
const HOME_URL = `${ORIGIN}/drive/home`;

/** Time left for the silent SSO re-login after a page load. */
const SILENT_SSO_MS = 5000;
/** An unused noVNC access closes itself; the next call opens a new one. */
const HUMAN_WINDOW_MS = 30 * 60_000;
const HUMAN_POLL_MS = 10_000;
/** Same size as the virtual screen: the window and the screen it reports must agree. */
const WINDOW = { width: 1280, height: 800 };

export type SessionState = "starting" | "ok" | "needs_login" | "needs_challenge" | "blocked";
type HumanState = "needs_login" | "needs_challenge";

/** An error whose message is meant for the agent as is: it says what went wrong or what to do. */
export class ToolError extends Error {}

/** The site cannot be used right now (login, Cloudflare check, refusal, daily cap). */
export class SiteUnavailableError extends ToolError {}

// --- Pure helpers -----------------------------------------------------------------------------

export const randomBetween = ([min, max]: Range): number => randomInt(min, max + 1);

/** `[23, 7]` covers 23:00 → 07:00; `[1, 5]` covers 01:00 → 05:00. */
export const isNight = (hour: number, [from, to]: Range): boolean =>
    from <= to ? hour >= from && hour < to : hour >= from || hour < to;

/** Cloudflare's interstitial, in French ("Un instant…") or English. */
export const isChallengeTitle = (title: string): boolean =>
    /^\s*(un instant|just a moment|attention required)/i.test(title);

const SITE_DOMAIN = /(^|\.)(coursesu\.com|magasins-u\.com|systeme-u\.com)$/;
const CLOUDFLARE_COOKIE = /^(cf_|__cf|_cfuvid)/;

/** What gets saved: session cookies of the site and of its SSO, never Cloudflare's. */
export const isSessionCookie = (cookie: Pick<Cookie, "name" | "domain" | "expires">): boolean =>
    cookie.expires === -1 &&
    SITE_DOMAIN.test(cookie.domain.replace(/^\./, "")) &&
    !CLOUDFLARE_COOKIE.test(cookie.name);

/**
 * Chrome locks its profile with a `SingletonLock` symlink to "hostname-pid". A container that is
 * recreated (an image update) gets a new hostname, so Chrome takes the old lock for another
 * machine's and refuses the profile. The lock is stale when it names another host or a dead
 * process: this server is the profile's only user.
 */
export const isStaleLock = (
    target: string,
    hostname: string,
    isAlive: (pid: number) => boolean,
): boolean => {
    const dash = target.lastIndexOf("-");
    const pid = Number(target.slice(dash + 1));
    return target.slice(0, dash) !== hostname || !Number.isInteger(pid) || !isAlive(pid);
};

const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

const clearStaleLock = async (profile: string): Promise<void> => {
    const target = await readlink(join(profile, "SingletonLock")).catch(() => null);
    if (target === null || !isStaleLock(target, hostname(), isAlive)) return;
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        await rm(join(profile, name), { force: true });
    }
    log.warn("stale browser profile lock removed");
};

// --- Browser ----------------------------------------------------------------------------------

type SavedSession = { loginAt: string | null; cookies: Cookie[] };

export class Site {
    state: SessionState = "starting";
    loginAt: string | null = null;
    blockedUntil = 0;
    requestsToday = 0;

    private readonly config: Config;
    private context: BrowserContext | null = null;
    private page: Page | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private day = "";
    private lastRequestAt = 0;
    private lastPageLoadAt = Date.now();
    private lastKeepaliveAt = 0;
    private nextGapMs = 0;
    private keepaliveTimer: NodeJS.Timeout | undefined;
    private vnc: Vnc | null = null;
    private humanPoll: NodeJS.Timeout | undefined;
    private humanDeadline = 0;

    constructor(config: Config) {
        this.config = config;
    }

    private get sessionFile(): string {
        return join(this.config.dataDir, "session.json");
    }

    async start(): Promise<void> {
        await mkdir(this.config.dataDir, { recursive: true });
        const profile = join(this.config.dataDir, "profile");
        await clearStaleLock(profile);
        this.context = await chromium.launchPersistentContext(profile, {
            channel: this.config.browserChannel,
            headless: false,
            viewport: null,
            args: ["--window-position=0,0", `--window-size=${WINDOW.width},${WINDOW.height}`],
        });
        const saved = await this.readSession();
        this.loginAt = saved.loginAt;
        if (saved.cookies.length > 0) await this.context.addCookies(saved.cookies);
        this.page = this.context.pages()[0] ?? (await this.context.newPage());
        log.info("browser started", { channel: this.config.browserChannel });

        await this.run("probe", () => this.visit("probe")).catch((error: unknown) =>
            log.warn("startup probe", { error: String(error) }),
        );
        this.scheduleKeepalive();
    }

    async stop(): Promise<void> {
        clearTimeout(this.keepaliveTimer);
        this.stopHuman();
        await this.saveSession().catch(() => undefined);
        await this.context?.close();
    }

    /**
     * The queue: one task at a time, whatever its origin (tool, keep-alive, probe). After a
     * successful task the session cookies are written again, to follow their renewal by the site.
     */
    run<T>(label: string, task: () => Promise<T>): Promise<T> {
        const next = this.queue.then(async () => {
            this.assertAvailable();
            const started = Date.now();
            try {
                const result = await task();
                await this.saveSession();
                log.info("task", { label, ms: Date.now() - started });
                return result;
            } catch (error) {
                log.warn("task failed", { label, ms: Date.now() - started, error: String(error) });
                throw error;
            }
        });
        this.queue = next.catch(() => undefined);
        return next;
    }

    /** Loads a site page after the pause. Throws when the page is a challenge or a refusal. */
    async goto(url: string): Promise<Page> {
        const page = this.requirePage();
        await this.pace();
        const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: this.config.pageTimeoutMs,
        });
        this.lastPageLoadAt = Date.now();
        if (isChallengeTitle(await page.title())) throw this.needHuman("needs_challenge");
        const status = response?.status() ?? 200;
        if (status === 403 || status === 429)
            throw this.block(`HTTP ${status} on ${new URL(url).pathname}`);
        return page;
    }

    /**
     * Loads a page and waits for a call its own scripts make (the account area fetches its data
     * from an API with a token only the page holds). Returns that response as the page got it.
     */
    async gotoAndWait(
        url: string,
        match: (response: Response) => boolean,
    ): Promise<{ page: Page; response: Response }> {
        const waiting = this.requirePage().waitForResponse(match, {
            timeout: this.config.pageTimeoutMs,
        });
        waiting.catch(() => undefined);
        const page = await this.goto(url);
        return { page, response: await waiting };
    }

    /** Clicks an element of the current page after the pause, and waits for a call it triggers. */
    async clickAndWait(
        selector: string,
        match: (response: Response) => boolean,
    ): Promise<Response> {
        const page = this.requirePage();
        await this.pace();
        const waiting = page.waitForResponse(match, { timeout: this.config.pageTimeoutMs });
        waiting.catch(() => undefined);
        await page.click(selector, { timeout: this.config.pageTimeoutMs });
        return waiting;
    }

    /** Calls a site route from the page, with its cookies, after the pause. */
    async fetchText(url: string, init?: { method?: string; body?: string }): Promise<string> {
        const page = this.requirePage();
        await this.pace();
        const { status, text } = await page.evaluate(
            async ([target, options]) => {
                const response = await fetch(target, {
                    method: options?.method ?? "GET",
                    body: options?.body,
                    credentials: "include",
                    headers: {
                        "X-Requested-With": "XMLHttpRequest",
                        ...(options?.body
                            ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
                            : {}),
                    },
                });
                return { status: response.status, text: await response.text() };
            },
            [url, init] as const,
        );
        if (/<title>\s*(un instant|just a moment)/i.test(text))
            throw this.needHuman("needs_challenge");
        if (status === 403 || status === 429)
            throw this.block(`HTTP ${status} on ${new URL(url).pathname}`);
        return text;
    }

    async authenticated(): Promise<boolean> {
        const text = await this.fetchText(AUTH_URL);
        try {
            return (JSON.parse(text) as { authenticated?: boolean }).authenticated === true;
        } catch {
            throw new Error("unexpected answer from the login check");
        }
    }

    async storeId(): Promise<string | null> {
        const cookies = (await this.context?.cookies(ORIGIN)) ?? [];
        return cookies.find((cookie) => cookie.name === "storeId")?.value ?? null;
    }

    /** For `session_status`, without touching the site while it is unavailable. */
    humanActionUrl(): string | null {
        return this.vnc?.url ?? null;
    }

    unavailableMessage(): string | null {
        switch (this.state) {
            case "needs_login":
            case "needs_challenge": {
                this.ensureHuman();
                const where = this.vnc?.url
                    ? `Open ${this.vnc.url} from the local network`
                    : "Use the browser window open on the server machine";
                return this.state === "needs_login"
                    ? `Courses U login required (no session, or the session expired). ${where}, then click "Se connecter" and sign in. The server resumes on its own once signed in.`
                    : `Cloudflare asks for a manual check. ${where} and tick the box. The server resumes on its own afterwards.`;
            }
            case "blocked":
                return Date.now() < this.blockedUntil
                    ? `The site refused access. Paused until ${new Date(this.blockedUntil).toISOString()}; do not retry before then.`
                    : null;
            default:
                return null;
        }
    }

    // --- Internals ------------------------------------------------------------------------

    private assertAvailable(): void {
        const message = this.unavailableMessage();
        if (message !== null) throw new SiteUnavailableError(message);
        if (this.state === "blocked") this.state = "starting";
    }

    private requirePage(): Page {
        if (this.page === null) throw new Error("browser not started");
        return this.page;
    }

    private async pace(): Promise<void> {
        const today = new Date().toLocaleDateString("sv");
        if (today !== this.day) {
            this.day = today;
            this.requestsToday = 0;
        }
        if (this.requestsToday >= this.config.dailyCap) {
            throw new SiteUnavailableError(
                `Daily cap reached (${this.config.dailyCap} site requests). Try again tomorrow.`,
            );
        }
        const wait = this.lastRequestAt + randomBetween(this.config.delayMs) - Date.now();
        if (wait > 0) await sleep(wait);
        this.requestsToday += 1;
        this.lastRequestAt = Date.now();
    }

    /** A visit: load the home page, let the silent SSO run, check the session. */
    private async visit(kind: "probe" | "keepalive"): Promise<void> {
        const page = await this.goto(HOME_URL);
        await page.waitForTimeout(SILENT_SSO_MS);
        const ok = await this.authenticated();
        await this.logVisit(kind, ok);
        if (!ok) throw this.needHuman("needs_login");
        this.state = "ok";
    }

    private block(reason: string): SiteUnavailableError {
        this.state = "blocked";
        this.blockedUntil = Date.now() + this.config.blockCooldownHours * 3_600_000;
        log.warn("access refused, pausing", {
            reason,
            until: new Date(this.blockedUntil).toISOString(),
        });
        return new SiteUnavailableError(this.unavailableMessage() ?? reason);
    }

    private needHuman(state: HumanState): SiteUnavailableError {
        if (this.state !== state) log.warn("human action required", { state });
        this.state = state;
        void this.logVisit(state, false);
        return new SiteUnavailableError(this.unavailableMessage() ?? state);
    }

    private ensureHuman(): void {
        if (this.vnc !== null) return;
        this.vnc = startVnc(this.config);
        this.humanDeadline = Date.now() + HUMAN_WINDOW_MS;
        this.humanPoll = setInterval(() => void this.checkHuman(), HUMAN_POLL_MS);
        // The URL carries the noVNC password: it goes to the local log and to the agent, nowhere else.
        log.warn("noVNC access opened", { url: this.vnc.url ?? "local window" });
    }

    private stopHuman(): void {
        clearInterval(this.humanPoll);
        this.vnc?.stop();
        this.vnc = null;
    }

    /**
     * Polls while a person acts, outside the queue: no tool runs while the state asks for a
     * human. Nothing is clicked here; it only looks.
     */
    private async checkHuman(): Promise<void> {
        if (Date.now() > this.humanDeadline) {
            this.stopHuman();
            log.warn("noVNC access closed unused; the next call opens it again");
            return;
        }
        const page = this.page;
        if (page === null || !page.url().startsWith(ORIGIN)) return;
        const title = await page.title().catch(() => "un instant");
        if (isChallengeTitle(title)) return;
        const text = await page
            .evaluate(
                (url) => fetch(url, { credentials: "include" }).then((r) => r.text()),
                AUTH_URL,
            )
            .catch(() => "");
        if (!text.includes('"authenticated"')) return;
        if (!text.includes('"authenticated":true')) {
            // Challenge cleared, but the session died meanwhile: a login is needed too.
            this.state = "needs_login";
            return;
        }
        if (this.state === "needs_login") this.loginAt = new Date().toISOString();
        this.state = "ok";
        this.stopHuman();
        this.lastPageLoadAt = Date.now();
        await this.saveSession();
        await this.logVisit("human", true);
        log.info("session restored");
    }

    private pickGap(): number {
        const range = isNight(new Date().getHours(), this.config.nightHours)
            ? this.config.keepaliveNightMin
            : this.config.keepaliveDayMin;
        return randomBetween([range[0] * 60_000, range[1] * 60_000]);
    }

    /** The deadline counts from the last page load: a tool call postpones the keep-alive. */
    private scheduleKeepalive(): void {
        clearTimeout(this.keepaliveTimer);
        if (this.nextGapMs === 0) this.nextGapMs = this.pickGap();
        const due = Math.max(this.lastPageLoadAt, this.lastKeepaliveAt) + this.nextGapMs;
        this.keepaliveTimer = setTimeout(
            () => void this.keepalive(),
            Math.max(due - Date.now(), 0),
        );
    }

    private async keepalive(): Promise<void> {
        const due = Math.max(this.lastPageLoadAt, this.lastKeepaliveAt) + this.nextGapMs;
        if (Date.now() >= due) {
            this.lastKeepaliveAt = Date.now();
            this.nextGapMs = this.pickGap();
            // No keep-alive while a person has to act: it would reopen noVNC unasked.
            const usable =
                this.state === "ok" ||
                this.state === "starting" ||
                (this.state === "blocked" && Date.now() >= this.blockedUntil);
            if (usable) {
                await this.run("keepalive", () => this.visit("keepalive")).catch(() => undefined);
            }
        }
        this.scheduleKeepalive();
    }

    private async readSession(): Promise<SavedSession> {
        try {
            return JSON.parse(await readFile(this.sessionFile, "utf8")) as SavedSession;
        } catch {
            return { loginAt: null, cookies: [] };
        }
    }

    private async saveSession(): Promise<void> {
        if (this.context === null) return;
        const cookies = (await this.context.cookies()).filter(isSessionCookie);
        const session: SavedSession = { loginAt: this.loginAt, cookies };
        const temporary = `${this.sessionFile}.tmp`;
        await writeFile(temporary, JSON.stringify(session), { mode: 0o600 });
        await rename(temporary, this.sessionFile);
    }

    /** The log that tells whether the session has a maximum lifetime or only an idle timeout. */
    private async logVisit(kind: string, authenticated: boolean): Promise<void> {
        const minutesSinceLogin =
            this.loginAt === null
                ? null
                : Math.round((Date.now() - Date.parse(this.loginAt)) / 60_000);
        const line = {
            at: new Date().toISOString(),
            kind,
            authenticated,
            state: this.state,
            minutesSinceLogin,
        };
        await appendFile(
            join(this.config.dataDir, "visits.jsonl"),
            `${JSON.stringify(line)}\n`,
        ).catch(() => undefined);
    }
}
