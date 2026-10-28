/**
 * Writes to the site go through its own controllers, as its scripts call them: form fields, the
 * page's `csrf_token`, `format=ajax`. Nothing here knows what a cart or a list is.
 */

import type { Page } from "patchright";
import { CONTROLLER, type Site } from "../browser.ts";

/** The token every page carries in a hidden input; writes are refused without it. */
export const csrfToken = async (page: Page): Promise<string> => {
    const token = await page.evaluate(
        () =>
            document.querySelector<HTMLInputElement>("input[data-csrf-token-met]")?.value ??
            document.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value ??
            null,
    );
    if (token === null) throw new Error("no csrf_token on the page");
    return token;
};

/** Calls `Controller-Action` with form fields and returns its JSON answer, or null for HTML. */
export const callController = async (
    site: Site,
    action: string,
    token: string,
    fields: Record<string, string>,
    method: "GET" | "POST" = "POST",
): Promise<Record<string, unknown> | null> => {
    const query = new URLSearchParams({ format: "ajax", csrf_token: token });
    const body = new URLSearchParams(fields);
    const url =
        method === "GET"
            ? `${CONTROLLER}/${action}?${query}&${body}`
            : `${CONTROLLER}/${action}?${query}`;
    const text = await site.fetchText(
        url,
        method === "GET" ? undefined : { method, body: body.toString() },
    );
    if (/CSRF Token Mismatch/i.test(text)) throw new Error(`${action}: CSRF token refused`);
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }
};
