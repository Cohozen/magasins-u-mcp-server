/**
 * Placing and cancelling a drive order, paid at pickup.
 *
 * `prepareOrder` reads the cart, the booked slot and the checkout page (`/paiement`), and keeps a
 * fingerprint of them under a token valid 10 minutes. `placeOrder` submits the checkout form only
 * with that token and only if the fingerprint still matches: what the person confirmed is what
 * gets ordered. Payment is always "at pickup" (`OFFLINE_PAY`); the server never pays online.
 */

import { randomUUID } from "node:crypto";
import type { Page } from "patchright";
import { ORIGIN, type Site, ToolError } from "../browser.ts";
import { getOrder, getOrders } from "./account.ts";
import { type Cart, getCart } from "./cart.ts";

const TOKEN_TTL_MS = 10 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;

/** What the person confirms: the cart lines, the total and the slot, as one comparable string. */
export const orderFingerprint = (cart: Cart, slot: string | null): string =>
    JSON.stringify({
        lines: cart.lines.map((line) => `${line.pid}x${line.quantity}`).sort(),
        total: cart.estimatedTotal,
        slot,
    });

// One order at a time: a new prepare_order replaces the previous token.
let pending: { token: string; fingerprint: string; expires: number } | null = null;

const openCheckout = async (site: Site): Promise<Page> => {
    const page = await site.goto(`${ORIGIN}/paiement`);
    if (new URL(page.url()).pathname !== "/paiement") {
        throw new ToolError(`The site did not open the checkout (it went to ${page.url()}).`);
    }
    const payAtPickup = await page.evaluate(
        () =>
            document.querySelector('form[name="paymentForm"] input[value="OFFLINE_PAY"]') !== null,
    );
    if (!payAtPickup) {
        throw new ToolError(
            "The checkout offers no payment at pickup for this order. This server never pays online: order on the site instead.",
        );
    }
    return page;
};

export const prepareOrder = async (site: Site) => {
    const { bookedSlot, ...cart } = await getCart(site);
    if (cart.lines.length === 0) throw new ToolError("The cart is empty.");
    if (bookedSlot === null) {
        throw new ToolError("No pickup slot is booked: call get_slots, then book_slot.");
    }
    if (
        cart.estimatedTotal !== null &&
        cart.minimumOrder !== null &&
        cart.estimatedTotal < cart.minimumOrder
    ) {
        throw new ToolError(
            `The cart (${cart.estimatedTotal} €) is below the store's minimum order (${cart.minimumOrder} €).`,
        );
    }
    await openCheckout(site);
    const token = randomUUID();
    const expires = Date.now() + TOKEN_TTL_MS;
    pending = { token, fingerprint: orderFingerprint(cart, bookedSlot), expires };
    return {
        token,
        expiresAt: new Date(expires).toISOString(),
        slot: bookedSlot,
        payment: "at pickup",
        estimatedTotal: cart.estimatedTotal,
        savings: cart.savings,
        loyaltyEarned: cart.loyaltyEarned,
        itemCount: cart.itemCount,
        lines: cart.lines.map(({ pid, name, quantity, lineTotal }) => ({
            pid,
            name,
            quantity,
            lineTotal,
        })),
    };
};

/** Submits the checkout form as the page would, with payment at pickup and the terms accepted. */
const submitCheckout = async (page: Page): Promise<void> => {
    const loaded = page.waitForEvent("load", { timeout: SUBMIT_TIMEOUT_MS });
    await page.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>('form[name="paymentForm"]');
        const offline = form?.querySelector<HTMLInputElement>('input[value="OFFLINE_PAY"]');
        const terms = form?.querySelector<HTMLInputElement>('input[name="payment_checkbox"]');
        if (!form || !offline || !terms) throw new Error("checkout form not found");
        offline.checked = true;
        terms.checked = true;
        form.submit();
    });
    await loaded;
};

export const placeOrder = async (site: Site, token: string, allowed: boolean) => {
    if (!allowed) {
        throw new ToolError(
            "Placing orders is disabled on this server (ALLOW_PLACE_ORDER=false). The person can validate the cart on the site.",
        );
    }
    if (pending === null || pending.token !== token || Date.now() > pending.expires) {
        throw new ToolError("Unknown or expired token: call prepare_order again.");
    }
    const { fingerprint } = pending;
    // Single use, whatever happens next.
    pending = null;
    const { bookedSlot, ...cart } = await getCart(site);
    if (orderFingerprint(cart, bookedSlot) !== fingerprint) {
        throw new ToolError(
            "The cart, its total or the slot changed since prepare_order: call it again and show the new summary.",
        );
    }
    const before = new Set((await getOrders(site)).map((order) => order.id));
    const page = await openCheckout(site);
    let submitError: string | null = null;
    try {
        await submitCheckout(page);
    } catch (error) {
        submitError = String(error);
    }
    const landedOn = page.url();
    // The report trusts the order list afterwards, not the page the form led to.
    const created = (await getOrders(site)).filter((order) => !before.has(order.id));
    return {
        done: created.length === 1,
        order: created[0] ?? null,
        landedOn,
        submitError,
    };
};

export const cancelOrder = async (site: Site, orderId: string) => {
    const page = await site.goto(
        `${ORIGIN}/mon-compte/mes-commandes-encours/detail?orderId=${encodeURIComponent(orderId)}`,
    );
    const loaded = page.waitForEvent("load", { timeout: SUBMIT_TIMEOUT_MS });
    const found = await page.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>("form[data-cancel-order-form]");
        form?.submit();
        return form !== null;
    });
    if (!found) {
        throw new ToolError(
            "This order offers no online cancellation: the person has to contact the store.",
        );
    }
    await loaded;
    const order = await getOrder(site, orderId);
    return { done: /annul/i.test(order.status ?? ""), status: order.status, order };
};
