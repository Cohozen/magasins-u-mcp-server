import { describe, expect, it } from "vitest";
import type { Cart } from "./cart.ts";
import { orderFingerprint } from "./order.ts";

const line = (pid: string, quantity: number) => ({ pid, quantity }) as Cart["lines"][number];
const cart = (lines: Cart["lines"], estimatedTotal: number) => ({ lines, estimatedTotal }) as Cart;

describe("orderFingerprint", () => {
    const slot = "Jeu. 05/02 de 12h00 à 13h00";
    const base = orderFingerprint(cart([line("1", 2), line("2", 1)], 53.52), slot);

    it("ignores the order of the lines", () => {
        expect(orderFingerprint(cart([line("2", 1), line("1", 2)], 53.52), slot)).toBe(base);
    });

    it("changes with a quantity, the total or the slot", () => {
        expect(orderFingerprint(cart([line("1", 3), line("2", 1)], 53.52), slot)).not.toBe(base);
        expect(orderFingerprint(cart([line("1", 2), line("2", 1)], 54.1), slot)).not.toBe(base);
        expect(orderFingerprint(cart([line("1", 2), line("2", 1)], 53.52), null)).not.toBe(base);
    });
});
