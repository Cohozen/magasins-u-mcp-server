/**
 * Drive pickup slots of the selected store.
 *
 * `DeliverySlot-GetDeliverySlotsWeb` is the call the slot picker makes. It is a POST but reads
 * only; like every controller it wants the `csrf_token` of a page, hence one page load first.
 */

import { CONTROLLER, ORIGIN, type Site, ToolError } from "../browser.ts";
import { callController, csrfToken } from "./form.ts";

type RawSlot = {
    slotId?: number | string;
    dteBegin?: string;
    dteEnd?: string;
    capacityUsed?: number;
    capacityMax?: number;
};

export type Slot = {
    id: string;
    /** Local time, YYYY-MM-DDTHH:MM. */
    start: string;
    end: string;
    /** Orders already booked on the slot: a busy slot means a busier pickup. */
    booked: number | null;
};

/** "20261028 16:00:00" → "2026-10-28T16:00". */
const localTime = (value: string | undefined): string | null => {
    const match = /^(\d{4})(\d{2})(\d{2}) (\d{2}:\d{2})/.exec(value ?? "");
    return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}` : null;
};

export const parseSlots = (json: string): { fullyBooked: boolean; slots: Slot[] } => {
    const data = JSON.parse(json) as {
        success?: boolean;
        isFullBooked?: boolean;
        slotList?: RawSlot[];
    };
    if (data.success !== true) throw new Error("the site did not return pickup slots");
    return {
        fullyBooked: data.isFullBooked === true,
        slots: (data.slotList ?? []).flatMap((slot) => {
            const start = localTime(slot.dteBegin);
            const end = localTime(slot.dteEnd);
            if (slot.slotId === undefined || start === null || end === null) return [];
            return [
                {
                    id: String(slot.slotId),
                    start,
                    end,
                    booked: typeof slot.capacityUsed === "number" ? slot.capacityUsed : null,
                },
            ];
        }),
    };
};

const loadSlots = async (site: Site) => {
    const page = await site.goto(`${ORIGIN}/panier`);
    const token = await csrfToken(page);
    const answer = await site.fetchText(
        `${CONTROLLER}/DeliverySlot-GetDeliverySlotsWeb?csrf_token=${encodeURIComponent(token)}`,
        { method: "POST", body: "deliveryPoint=drive" },
    );
    return { token, ...parseSlots(answer) };
};

export const getSlots = async (site: Site) => {
    const { fullyBooked, slots } = await loadSlots(site);
    return { fullyBooked, slots };
};

/** "2026-10-28T16:00" → "20261028 16:00:00", the form the checkout expects. */
export const checkoutTime = (local: string): string =>
    `${local.replace(/-/g, "").replace("T", " ")}:00`;

/** The slot the header shows once one is booked: "Jeu. 29/10 de 12h00 à 13h00". */
export const parseBookedSlot = (html: string): string | null =>
    /([\p{L}]+\.? \d{2}\/\d{2} de \d{2}h\d{2} à \d{2}h\d{2})/u.exec(
        html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "),
    )?.[1] ?? null;

/** Whether the header's label is this slot: same day and month, same start hour. */
export const isSameSlot = (label: string, slot: Slot): boolean => {
    const [, month, day, hour, minute] =
        /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slot.start) ?? [];
    return label.includes(`${day}/${month} de ${hour}h${minute}`);
};

/** The booked pickup slot, as the site header shows it; null when none is booked. */
export const getBookedSlot = async (site: Site): Promise<string | null> => {
    const store = (await site.storeId()) ?? "";
    return parseBookedSlot(
        await site.fetchText(
            `${CONTROLLER}/Home-IncludeNavigationSlotTimeInfo?storeID=${encodeURIComponent(store)}&deliveryMethod=&slotId=`,
        ),
    );
};

/** Reserves a drive pickup slot for the current cart. Nothing is ordered or paid. */
export const bookSlot = async (site: Site, slotId: string) => {
    const { token, slots } = await loadSlots(site);
    const slot = slots.find((candidate) => candidate.id === slotId);
    if (slot === undefined) {
        throw new ToolError(`Slot ${slotId} is not offered any more; call get_slots again.`);
    }
    const answer = await callController(site, "Checkout-SetShipping", token, {
        dwfrm_shipping_shippingMethod: "drive",
        dwfrm_shipping_slotId: slot.id,
        dwfrm_shipping_slotDateBegin: checkoutTime(slot.start),
        dwfrm_shipping_slotDateEnd: checkoutTime(slot.end),
        dwfrm_shipping_drive_confirm: "x",
    });
    const error = answer?.error ?? answer?.errorMessage;
    // The report trusts what the site shows afterwards, not the answer alone.
    const booked = await getBookedSlot(site);
    return {
        done: booked !== null && isSameSlot(booked, slot),
        requested: slot,
        bookedSlot: booked,
        siteError: typeof error === "string" && error !== "" ? error : null,
    };
};
