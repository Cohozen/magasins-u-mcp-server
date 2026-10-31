import { describe, expect, it } from "vitest";
import {
    parseCurrentOrder,
    parseOrderCard,
    parseOrderLine,
    parseOrderPage,
    substitutionLine,
} from "./account.ts";

// Texts shaped like the real pages, with invented order numbers, stores and amounts.
const tile = (fields: Record<string, unknown>, text: string) => ({
    tracking: JSON.stringify({ promotion: { type: "unknown" }, brand: "CHARAL", ...fields }),
    text,
    href: null,
});

describe("parseOrderCard", () => {
    it("reads date, mode, status, store and total", () => {
        const text =
            "Commande Drive du 05/02/2026\n\nRetirée\n\nNº 11112222 - Super U Exemple\n\n98,40 €\nVoir le détail\n+\n12\nCommander à nouveau";
        expect(parseOrderCard("11112222", text)).toEqual({
            id: "11112222",
            date: "2026-02-05",
            mode: "Drive",
            status: "Retirée",
            store: "Super U Exemple",
            total: 98.4,
            pickup: null,
        });
    });
});

describe("parseCurrentOrder", () => {
    it("reads mode, pickup slot and store of an order not collected yet", () => {
        const text =
            "Votre commande Drive en cours Nº 33334444\nValidée\nEn préparation\nPrête\nRetrait prévu le 05/02/2026 de 10h00 à 11h00\nSuper U Exemple\n1 rue de l'Exemple\nVoir sur la carte\nModifier\nVoir le détail";
        expect(parseCurrentOrder("33334444", text, " Validée ")).toEqual({
            id: "33334444",
            date: null,
            mode: "Drive",
            status: "Validée",
            store: "Super U Exemple",
            total: null,
            pickup: "05/02/2026 de 10h00 à 11h00",
        });
    });
});

describe("parseOrderLine", () => {
    it("reads the ordered quantity and the line total, not the unit price", () => {
        const line = parseOrderLine(
            tile(
                { id: "1735067", name: "Steak haché pur boeuf 5%MG - 2x130g", price: "3.62" },
                "Qté : 2\nSteak haché pur boeuf 5%MG - 2x130g\n7,24 €\n27,85 €/kg\nAjouter à une liste",
            ),
        );
        expect(line).toMatchObject({
            pid: "1735067",
            price: 3.62,
            badge: null,
            quantity: 2,
            lineTotal: 7.24,
            unitPrice: { value: 27.85, per: "kg" },
        });
    });

    it("leaves the line total empty when none is shown", () => {
        const line = parseOrderLine(
            tile(
                { id: "1714641", name: "Escalope de porc, 2 pièces", price: "3.99" },
                "Qté : 1\nEscalope de porc, 2 pièces 300 g environ\nAjouter à une liste",
            ),
        );
        expect(line).toMatchObject({ quantity: 1, lineTotal: null });
    });
});

describe("parseOrderPage", () => {
    it("reads the order header and its lines", () => {
        const text = [
            "Mes commandes",
            "Votre commande Drive du 05/02/2026 (Nº 11112222)",
            "",
            "Retirée Télécharger le récapitulatif",
            "Super U Exemple",
            "",
            "Lors de la préparation de votre commande, certains produits étaient",
            "indisponibles. Voir le détail de ces produits",
            "Reste à payer",
            "",
            "98,40 €",
            "",
            "31 articles",
            "",
            "Dont 6,12 € de TVA",
            "Frais de préparation",
            "",
            "OFFERTS",
            "",
            "Paiement à la réception",
        ].join("\n");
        const order = parseOrderPage("11112222", text, [
            tile({ id: "1", name: "Produit", price: "1.00" }, "Qté : 1\nProduit\n1,00 €"),
        ]);
        expect(order).toMatchObject({
            id: "11112222",
            date: "2026-02-05",
            mode: "Drive",
            status: "Retirée",
            store: "Super U Exemple",
            total: 98.4,
            itemCount: 31,
            payment: "Paiement à la réception",
            preparationFee: "OFFERTS",
            someUnavailable: true,
        });
        expect(order.lines).toHaveLength(1);
    });
});

describe("substitutionLine", () => {
    it("reads the quantity ordered or prepared", () => {
        expect(
            substitutionLine({
                pid: "1234567",
                name: "\n  Escalope de dinde, 2 pièces  \n",
                quantity: " Quantité commandée : 2 ",
            }),
        ).toEqual({ pid: "1234567", name: "Escalope de dinde, 2 pièces", quantity: 2 });
        expect(
            substitutionLine({ pid: null, name: "Produit", quantity: "Quantité préparée : 1" }),
        ).toEqual({ pid: null, name: "Produit", quantity: 1 });
    });

    it("leaves an unreadable quantity empty", () => {
        expect(substitutionLine({ pid: null, name: "Produit", quantity: "" }).quantity).toBeNull();
    });
});
