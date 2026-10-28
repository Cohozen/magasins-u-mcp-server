import { describe, expect, it } from "vitest";
import { parseProductPage, parseTile, washesOf } from "./catalog.ts";

// Texts captured from real search tiles ("lessive"), with a store selected.
const tracking = (fields: Record<string, unknown>): string =>
    JSON.stringify({
        promotion: { type: "unknown" },
        brand: "PERSIL",
        product_cat1: "Entretien et nettoyage",
        product_cat2: "Lessives et soin du linge",
        product_cat3: "Lessive liquide",
        ...fields,
    });

describe("parseTile", () => {
    it("reads price, unit price, banner and washes from a plain tile", () => {
        const product = parseTile({
            tracking: tracking({
                id: "3575775",
                name: "Lessive liquide bouquet de provence  PERSIL 3x43 lavages",
                EAN: "8720181672231",
                price: "12.25",
            }),
            text: "PRIX BAS Lessive liquide bouquet de provence PERSIL 3x43 lavages Lessive liquide bouquet de provence PERSIL 3x43 lavages 12 euros 25 centimes 2 euros 27 le litre 12,25 € 2,27 €/l Ajouter à une liste Ajouter au panier",
            href: "/p/lessive-liquide-bouquet-de-provence--persil-3x43-lavages/3575775.html",
        });
        expect(product).toMatchObject({
            pid: "3575775",
            ean: "8720181672231",
            name: "Lessive liquide bouquet de provence PERSIL 3x43 lavages",
            brand: "PERSIL",
            price: 12.25,
            unitPrice: { value: 2.27, per: "l" },
            oldPrice: null,
            offer: null,
            badge: "PRIX BAS",
            washes: 129,
            pricePerWash: 0.095,
            aisle: "Entretien et nettoyage > Lessives et soin du linge > Lessive liquide",
            url: "https://www.coursesu.com/p/lessive-liquide-bouquet-de-provence--persil-3x43-lavages/3575775.html",
        });
    });

    it("keeps the promotional unit price, not the struck-through one", () => {
        const product = parseTile({
            tracking: tracking({
                id: "3980337",
                name: "Lessive liquide BONUX l'Original bouteille 50 lavages 2,25L",
                brand: "BONUX",
                price: "5.74",
            }),
            text: "PROMOTION pour un retrait jusqu'au 01/11 Lessive liquide BONUX l'Original bouteille 50 lavages 2,25L Lessive liquide BONUX l'Original bouteille 50 lavages 2,25L ☆☆☆☆☆ ☆☆☆☆☆ 2 avis -34% 5 euros 74 au lieu de 8 euros 71 2 euros 56 le litre au lieu de 3 euros 88 le litre Ancien prix : 8,71 € 5,74 € 3,88 €/l 2,56 €/l Ajouter à une liste Ajouter au panier",
            href: null,
        });
        expect(product).toMatchObject({
            price: 5.74,
            unitPrice: { value: 2.56, per: "l" },
            oldPrice: 8.71,
            offer: "-34%",
            badge: "PROMOTION pour un retrait jusqu'au 01/11",
            washes: 50,
            url: null,
        });
    });

    it("reads a second-item offer and a price per kilo", () => {
        const product = parseTile({
            tracking: tracking({
                id: "3990917",
                name: "Lessive LE CHAT Discs Sensitive Animaux & Compagnie 23 lavages",
                brand: "LE CHAT",
                price: "7.97",
            }),
            text: "PROMOTION pour un retrait jusqu'au 01/11 Lessive LE CHAT Discs Sensitive Animaux & Compagnie 23 lavages Lessive LE CHAT Discs Sensitive Animaux & Compagnie 23 lavages -80% SUR LE 2ÈME 7 euros 97 centimes 20 euros 98 le kilogramme 7,97 € 20,98 €/kg Ajouter à une liste Ajouter promo Lessive LE CHAT Discs Sensitive Animaux & Compagnie 23 lavages au panier Ajouter au panier",
            href: null,
        });
        expect(product).toMatchObject({
            offer: "-80% SUR LE 2ÈME",
            unitPrice: { value: 20.98, per: "kg" },
            washes: 23,
            pricePerWash: 0.347,
        });
    });

    it('reads a store-brand "2+1" multi-buy and the promotion description', () => {
        const product = parseTile({
            tracking: tracking({
                id: "1234567",
                name: "Lessive liquide - Soin noir - 30 lavages - 1.5 l",
                brand: "PRODUIT U",
                price: "3.09",
                promotion: {
                    type: "XACYG_IMTCL",
                    name: "GROS VOLUMES 2 - 3,09 E/LOT 3 LESSIVE U X30 - 2 achetés + 1 offert <br><i>pour un retrait jusqu'au 08/11</i>",
                    endDate: "2026-11-08",
                },
            }),
            text: "PROMOTION pour un retrait jusqu'au 08/11 U Lessive liquide - Soin noir - 30 lavages - 1.5 l U Lessive liquide - Soin noir - 30 lavages - 1.5 l ☆☆☆☆☆ ☆☆☆☆☆ 2 avis 2+1 OFFERT 3 euros 09 centimes 2 euros 06 le litre 3,09 € 2,06 €/l Ajouter à une liste Ajouter promo Lessive liquide - Soin noir - 30 lavages - 1.5 l au panier Ajouter au panier",
            href: null,
        });
        expect(product).toMatchObject({
            badge: "PROMOTION pour un retrait jusqu'au 08/11",
            offer: "2+1 OFFERT",
            promotion: {
                description:
                    "GROS VOLUMES 2 - 3,09 E/LOT 3 LESSIVE U X30 - 2 achetés + 1 offert pour un retrait jusqu'au 08/11",
                until: "2026-11-08",
            },
            unitPrice: { value: 2.06, per: "l" },
            washes: 30,
        });
    });

    it("ignores a promotion the tracking does not describe", () => {
        const product = parseTile({
            tracking: tracking({
                id: "1",
                name: "Produit",
                promotion: { type: "REMUN_IMTCL", name: "unknown", endDate: "unknown" },
            }),
            text: "Produit",
            href: null,
        });
        expect(product?.promotion).toBeNull();
    });

    it("returns a null price until a store is selected", () => {
        const product = parseTile({
            tracking: tracking({
                id: "3540351",
                name: "Lessive liquide - Fraicheur - 30 lavages - 1.5 l",
                brand: "PRODUIT U",
                price: "unknown",
                notation: 4.4211,
            }),
            text: "En drive ou en livraison selon le magasin Lessive liquide - Fraicheur - 30 lavages - 1.5 l Afficher le prix",
            href: null,
        });
        expect(product).toMatchObject({
            price: null,
            unitPrice: null,
            pricePerWash: null,
            rating: 4.4,
        });
    });

    it("drops a tile without tracking or with unreadable JSON", () => {
        expect(parseTile({ tracking: null, text: "", href: null })).toBeNull();
        expect(parseTile({ tracking: "{", text: "", href: null })).toBeNull();
        expect(parseTile({ tracking: "{}", text: "", href: null })).toBeNull();
    });
});

describe("washesOf", () => {
    it("multiplies a pack and ignores a label without washes", () => {
        expect(washesOf("PERSIL 3x43 lavages")).toBe(129);
        expect(washesOf("Ariel 40 Lavages")).toBe(40);
        expect(washesOf("Lessive 1,8L")).toBeNull();
    });
});

describe("parseProductPage", () => {
    it("adds the Nutri-Score and the product sheet sections to the tile", () => {
        const product = parseProductPage({
            tile: {
                tracking: tracking({
                    id: "1177338",
                    name: "Pâtes Coquillettes qualité supérieure, 1kg",
                    EAN: "3256221111613",
                    brand: "PRODUIT U",
                    price: "1.42",
                }),
                text: "1 euros 42 centimes 1,42 € 1,42 €/kg Ajouter à mon panier",
                href: "https://www.coursesu.com/p/pates-coquillettes-qualite-superieure-1kg/1177338.html",
            },
            nutriscore: "Nutriscore A",
            sections: [
                ["Informations complémentaires", "Dénomination légale : Pâtes alimentaires"],
                ["Ingrédients", "Semoule de BLÉ dur de qualité supérieure"],
                [
                    "Informations nutritionnelles",
                    "Le Nutri-score est un logo qui informe sur la qualité nutritionnelle d'un produit.\nEn savoir plus sur le Nutriscore",
                ],
                ["Valeurs nutritionnelles", "(100 g) Energie : 1500 kJ/354kcal, Sel : 0.02 g."],
                ["Conseils", "Idéal avec du fromage"],
            ],
        });
        expect(product).toMatchObject({
            pid: "1177338",
            price: 1.42,
            unitPrice: { value: 1.42, per: "kg" },
            nutriscore: "A",
            details: {
                "Informations complémentaires": "Dénomination légale : Pâtes alimentaires",
                Ingrédients: "Semoule de BLÉ dur de qualité supérieure",
                "Valeurs nutritionnelles": "(100 g) Energie : 1500 kJ/354kcal, Sel : 0.02 g.",
            },
        });
        expect(Object.keys(product?.details ?? {})).toHaveLength(3);
    });
});
