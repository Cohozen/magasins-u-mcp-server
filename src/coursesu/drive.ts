/**
 * Drive pickup slots of the selected store.
 *
 * `DeliverySlot-GetDeliverySlotsWeb` is the call the slot picker makes. It is a POST but reads
 * only; like every controller it wants the `csrf_token` of a page, hence one page load first.
 */

import { CONTROLLER, ORIGIN, type Site } from "../browser.ts";

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

export const getSlots = async (site: Site) => {
    const page = await site.goto(`${ORIGIN}/panier`);
    const token = await page.evaluate(
        () => document.querySelector<HTMLInputElement>('input[name="csrf_token"]')?.value ?? null,
    );
    if (token === null) throw new Error("no csrf_token on the cart page");
    return parseSlots(
        await site.fetchText(
            `${CONTROLLER}/DeliverySlot-GetDeliverySlotsWeb?csrf_token=${encodeURIComponent(token)}`,
            { method: "POST", body: "deliveryPoint=drive" },
        ),
    );
};
