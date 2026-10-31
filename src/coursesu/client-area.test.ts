import { describe, expect, it } from "vitest";
import { parseOffers, parseTransactions } from "./client-area.ts";
import { checkoutTime, isSameSlot, parseBookedSlot, parseSlots } from "./drive.ts";

// Answers shaped like the real ones, with invented ids, stores and amounts.

describe("parseTransactions", () => {
    it("flattens the months, newest first, and tells which have a till receipt", () => {
        const json = JSON.stringify({
            hasMoreTransactions: true,
            monthlyTransactions: {
                "2026-02": [
                    {
                        transactionId: "aaaa-1",
                        date: "2026-02-03T10:15:00",
                        amount: "12,30",
                        magasin: "Super U EXEMPLE",
                        etickets: [
                            { filename: "Ticket de caisse", attachmentIndex: "0" },
                            { filename: "Ticket de CB", attachmentIndex: "1" },
                        ],
                    },
                ],
                "2026-01": [
                    {
                        transactionId: "bbbb-2",
                        date: "2026-01-20T18:00:00",
                        amount: "4,50",
                        magasin: "Super U EXEMPLE",
                        etickets: [{ filename: "Ticket de CB", attachmentIndex: "0" }],
                    },
                ],
            },
        });
        expect(parseTransactions(json)).toEqual({
            hasMore: true,
            transactions: [
                {
                    id: "aaaa-1",
                    date: "2026-02-03T10:15:00Z",
                    amount: 12.3,
                    store: "Super U EXEMPLE",
                    hasReceipt: true,
                },
                {
                    id: "bbbb-2",
                    date: "2026-01-20T18:00:00Z",
                    amount: 4.5,
                    store: "Super U EXEMPLE",
                    hasReceipt: false,
                },
            ],
        });
    });
});

describe("parseTransactions with older answers", () => {
    it("merges the answers once each, and takes hasMore from the last one", () => {
        const recent = JSON.stringify({
            hasMoreTransactions: true,
            monthlyTransactions: {
                "2026-02": [{ transactionId: "aaaa-1", date: "2026-02-03T10:15:00" }],
            },
        });
        const older = JSON.stringify({
            hasMoreTransactions: false,
            monthlyTransactions: {
                "2026-02": [{ transactionId: "aaaa-1", date: "2026-02-03T10:15:00" }],
                "2025-06": [{ transactionId: "cccc-3", date: "2025-06-10T09:00:00" }],
            },
        });
        const { hasMore, transactions } = parseTransactions(recent, older);
        expect(hasMore).toBe(false);
        expect(transactions.map((transaction) => transaction.id)).toEqual(["aaaa-1", "cccc-3"]);
    });
});

describe("parseOffers", () => {
    it("keeps what matters and the earnings of used offers", () => {
        const json = JSON.stringify({
            offresDisponibles: [
                {
                    id: "CAT-1",
                    type: "PRODUIT",
                    titre: "Chicorée 85g.",
                    description: "Sur l'achat d'une boîte de chicorée 85g.",
                    montant: 0.4,
                    dateDebut: null,
                    dateFin: null,
                    imageUrl: "https://example.org/x.png",
                    isNouveau: false,
                },
            ],
            offresActivees: [],
            offresUtilisees: [
                {
                    id: "CLM-2",
                    type: "ENSEIGNE",
                    titre: null,
                    description: "sur le rayon Fruits & Légumes",
                    montant: null,
                    dateDebut: "2026-02-02",
                    dateFin: "2026-02-08",
                    montantCagnotte: 1.83,
                    datePaiement: "2026-02-04",
                    isNouveau: true,
                },
            ],
        });
        expect(parseOffers(json)).toEqual({
            available: [
                {
                    id: "CAT-1",
                    type: "PRODUIT",
                    title: "Chicorée 85g.",
                    description: "Sur l'achat d'une boîte de chicorée 85g.",
                    amount: 0.4,
                    from: null,
                    until: null,
                    isNew: false,
                },
            ],
            activated: [],
            used: [
                expect.objectContaining({
                    id: "CLM-2",
                    title: null,
                    until: "2026-02-08",
                    earned: 1.83,
                    paidOn: "2026-02-04",
                }),
            ],
        });
    });
});

describe("parseSlots", () => {
    it("turns the slot list into local start and end times", () => {
        const json = JSON.stringify({
            success: true,
            isFullBooked: false,
            slotList: [
                {
                    slotId: 1001,
                    dteBegin: "20260203 16:00:00",
                    dteEnd: "20260203 17:00:00",
                    capacityMax: -1,
                    capacityUsed: 2,
                    hourBegin: "16h00",
                    hourEnd: "17h00",
                },
            ],
        });
        expect(parseSlots(json)).toEqual({
            fullyBooked: false,
            slots: [{ id: "1001", start: "2026-02-03T16:00", end: "2026-02-03T17:00", booked: 2 }],
        });
    });

    it("refuses an answer without success", () => {
        expect(() => parseSlots('{"success":false}')).toThrow(/pickup slots/);
    });
});

describe("checkoutTime", () => {
    it("rebuilds the date format the checkout expects", () => {
        expect(checkoutTime("2026-02-03T16:00")).toBe("20260203 16:00:00");
    });
});

describe("parseBookedSlot", () => {
    it("reads the booked slot from the header fragment", () => {
        const html =
            '<div class="slot"> <span>super u</span>\n <span>\n Jeu. 05/02 de 12h00 à 13h00 \n</span></div>';
        const label = parseBookedSlot(html);
        expect(label).toBe("Jeu. 05/02 de 12h00 à 13h00");
        const slot = { id: "1", start: "2026-02-05T12:00", end: "2026-02-05T13:00", booked: 0 };
        expect(isSameSlot(label ?? "", slot)).toBe(true);
        expect(isSameSlot(label ?? "", { ...slot, start: "2026-02-05T13:00" })).toBe(false);
    });

    it("returns null when no slot is booked", () => {
        expect(parseBookedSlot("<div>Choisir un créneau</div>")).toBeNull();
    });
});
