import { describe, expect, it } from "vitest";
import { decimalToCents, parsePackage } from "./package-label.ts";

describe("decimalToCents", () => {
    it("reads a decimal price without going through a float", () => {
        expect(decimalToCents("2.0")).toBe(200);
        expect(decimalToCents("0.69")).toBe(69);
        expect(decimalToCents("11.19")).toBe(1119);
        expect(decimalToCents("2")).toBe(200);
        expect(decimalToCents("1,25")).toBe(125);
    });

    it("returns null for a missing or non-numeric value", () => {
        expect(decimalToCents(null)).toBeNull();
        expect(decimalToCents("gratuit")).toBeNull();
    });
});

describe("parsePackage", () => {
    it("reads a plain weight, with or without a space", () => {
        expect(parsePackage("Patate douce 500 g")).toMatchObject({
            label: "500 g",
            netQuantity: 500,
            netUnit: "g",
        });
        expect(parsePackage("Ricotta CASA AZZURRA - 250g")).toMatchObject({
            netQuantity: 250,
            netUnit: "g",
        });
    });

    it("converts to the canonical unit", () => {
        expect(parsePackage("Crème épaisse - 50cl")).toMatchObject({
            netQuantity: 500,
            netUnit: "ml",
        });
        expect(parsePackage("Bouteille 1,25L")).toMatchObject({
            label: "1.25 L",
            netQuantity: 1250,
            netUnit: "ml",
        });
    });

    it("multiplies the net content by the pack multiplier", () => {
        expect(parsePackage("Skyr vanille SIGGI'S - 2x140g")).toMatchObject({
            label: "2 x 140 g",
            packCount: 2,
            unitNetQuantity: 140,
            netQuantity: 280,
            netUnit: "g",
        });
        expect(parsePackage("Lait UHT - 6 bouteilles de 1L")).toMatchObject({
            label: "6 x 1 L",
            packCount: 6,
            unitNetQuantity: 1000,
            netQuantity: 6000,
            netUnit: "ml",
        });
    });

    it("keeps the last expression when the label stacks several", () => {
        expect(parsePackage("Fromage pané PRESIDENT 6 panés de 25g - 150g")).toMatchObject({
            label: "150 g",
            netQuantity: 150,
        });
    });

    it("counts a pack with no weight or volume in pieces", () => {
        expect(parsePackage("Mouchoirs LOTUS, x80")).toMatchObject({
            label: "x80",
            packCount: 80,
            unitNetQuantity: 1,
            netQuantity: 80,
            netUnit: "piece",
        });
        expect(parsePackage("Oeufs Plein Air - Boîte de 12")).toMatchObject({
            label: "x12",
            packCount: 12,
            unitNetQuantity: 1,
            netQuantity: 12,
            netUnit: "piece",
        });
    });

    it("tells a count from a multiplier: x44 tablets weigh 510 g in total", () => {
        expect(parsePackage("Tablette vaisselle FINISH Quantum x44 510g")).toMatchObject({
            label: "x44 · 510 g",
            packCount: 44,
            netQuantity: 510,
            netUnit: "g",
        });
    });

    it("leaves the unit content empty when the total does not divide by the count", () => {
        // 510 / 44 is not an integer: an average would be made-up data.
        expect(parsePackage("Tablette vaisselle FINISH Quantum x44 510g").unitNetQuantity).toBe(
            null,
        );
    });

    it("reads a litre spelled out", () => {
        expect(parsePackage("Boisson végétale avoine sans sucres ALPRO 1 litre")).toMatchObject({
            label: "1 L",
            netQuantity: 1000,
            netUnit: "ml",
        });
        expect(parsePackage("Lait demi-écrémé 6 bouteilles de 1 litre")).toMatchObject({
            packCount: 6,
            netQuantity: 6000,
        });
    });

    it("counts a tray and a pack marked with a star", () => {
        expect(parsePackage("Oeufs Plein air Bleu blanc coeur - Plateau de 20")).toMatchObject({
            label: "x20",
            packCount: 20,
            netQuantity: 20,
            netUnit: "piece",
        });
        expect(parsePackage("elastiques magic noir *300 babyliss")).toMatchObject({
            label: "x300",
            netQuantity: 300,
            netUnit: "piece",
        });
    });

    it("counts fruit after its container, without being fooled by the size grade", () => {
        expect(parsePackage("Banane Cavendish - Bouquet 6 fruits")).toMatchObject({
            label: "x6",
            packCount: 6,
            unitNetQuantity: 1,
            netQuantity: 6,
            netUnit: "piece",
        });
        expect(parsePackage("Kiwi jaune Sungold - Barquette 4 fruits").netQuantity).toBe(4);
        const lemon = parsePackage(
            "Citron jaune Eureka  - calibre 4 - Catégorie 1 -  Sachet 4 fruits",
        );
        expect(lemon).toMatchObject({ netQuantity: 4, netUnit: "piece" });
        // The fragment removed from the name must be the count, not the size grade.
        expect(lemon.matched).toEqual(["Sachet 4 fruits"]);
    });

    it("counts rolls, not plies", () => {
        expect(parsePackage("Papier toilette doux blanc 2 plis  18 rouleaux")).toMatchObject({
            label: "x18",
            netQuantity: 18,
            netUnit: "piece",
        });
    });

    it("reads an item sold by the piece as a single piece, not a pack", () => {
        const expected = {
            label: "1 pièce",
            packCount: null,
            unitNetQuantity: null,
            netQuantity: 1,
            netUnit: "piece",
        };
        expect(parsePackage("Concombre - La pièce")).toMatchObject(expected);
        expect(parsePackage("Courgette à la pièce")).toMatchObject(expected);
        expect(parsePackage("CONCOMBRE LA PIECE")).toMatchObject(expected);
        expect(parsePackage("Courgette à la pièce").matched).toEqual(["à la pièce"]);
    });

    it("does not take a recipe for a count", () => {
        // The weight wins: counting words are a last resort only.
        expect(parsePackage("Confiture 4 fruits rouges 370g")).toMatchObject({
            label: "370 g",
            packCount: null,
            netQuantity: 370,
        });
        // No weight, no container: a truncated receipt line does not become a pack of four.
        expect(parsePackage("CONFIT.4 FRUITS ROUGES").netQuantity).toBeNull();
    });

    it("leaves empty what has no base unit", () => {
        for (const label of [
            // A length is neither grams, millilitres nor a count.
            "Film fraîcheur ALBAL 30M",
            "Film alimentaire 2 en 1 ALBAL, 20m",
            "Papier alimentaire cuisson ALBAL, rouleau de 8 mètres",
            // Slices without a weight: the count does not say how much is used.
            "Jambon supérieur sans couenne, sans sel nitrité ajouté, VPF, 4 tranches",
            "JAMBON VENDEE 4 FINES TRANCHES",
            "Gants ultra résistants en latex MAPA, taille M",
        ]) {
            expect(parsePackage(label).netQuantity, label).toBeNull();
        }
    });

    it("finds nothing when the label carries no pack size", () => {
        expect(parsePackage("Laitue Iceberg")).toMatchObject({
            label: null,
            packCount: null,
            unitNetQuantity: null,
            netQuantity: null,
            netUnit: null,
        });
    });
});
