import { describe, expect, it } from "vitest";
import { parseCart, parseCartLine } from "./cart.ts";

// Texts shaped like the real cart page, with invented amounts.
const line = (fields: Record<string, unknown>, text: string, quantity: string) => ({
    tracking: JSON.stringify({ promotion: { type: "unknown" }, quantity: 1, ...fields }),
    text,
    href: null,
    quantity,
});

const MULTI_BUY = line(
    { id: "7480450", name: "Pur jus 5 fruits - Bouteille 90cl", brand: "TROPICANA", price: "2.75" },
    "Pur jus 5 fruits - Bouteille 90cl\nSupprimer le produit\n-68% SUR LE 2ÈME\npour un retrait jusqu'au 01/11\n5 euros 50 centimes\n3 euros 06 le litre\n5,50 €\n3,63 €\n3,06 €/l\nAjouter à une liste\nAjouter au panier\n\n1,87 €\nd'économie !\n\n1 lot réalisé",
    "2",
);

const CARTE_U = line(
    { id: "6609553", name: "Amandes grillées - Sachet 250g", brand: "DACO BELLO", price: "4.79" },
    "Amandes grillées - Sachet 250g\nSupprimer le produit\n20% EN € CARTE U\npour un retrait jusqu'au 01/11\n4,79 €\n19,16 €/kg\nAjouter à une liste\nAjouter au panier\n\n0,96 €\ncagnottés !",
    "1",
);

describe("parseCartLine", () => {
    it("reads the quantity from the input and the discounted line total", () => {
        expect(parseCartLine(MULTI_BUY)).toMatchObject({
            pid: "7480450",
            price: 2.75,
            quantity: 2,
            offer: "-68% SUR LE 2ÈME",
            lineTotal: 3.63,
            lineTotalBeforeDiscount: 5.5,
            loyaltyEarned: null,
            unitPrice: { value: 3.06, per: "l" },
        });
    });

    it("reads what a Carte U offer puts on the card", () => {
        expect(parseCartLine(CARTE_U)).toMatchObject({
            quantity: 1,
            lineTotal: 4.79,
            lineTotalBeforeDiscount: null,
            loyaltyEarned: 0.96,
        });
    });
});

describe("parseCart", () => {
    it("reads the cart totals", () => {
        const text =
            "Mon panier (3)\n...\nTotal estimé*\n8,42 €\n3 articles\nDont 0,44 € de TVA\nJe cagnotte 0,96 € Carte U !\nJ’économise 1,87 €\nValider mon panier\nMontant minimum de commande : 50 €";
        expect(parseCart(text, [MULTI_BUY, CARTE_U])).toMatchObject({
            itemCount: 3,
            estimatedTotal: 8.42,
            savings: 1.87,
            loyaltyEarned: 0.96,
            minimumOrder: 50,
            lines: [{ pid: "7480450" }, { pid: "6609553" }],
        });
    });

    it("reads an empty cart", () => {
        expect(parseCart("Votre panier est vide...", [])).toMatchObject({
            itemCount: null,
            estimatedTotal: null,
            lines: [],
        });
    });
});
