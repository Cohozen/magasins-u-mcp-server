import { describe, expect, it } from "vitest";
import { frenchDate, matches, parseCatalogueCard, parseCatalogueTile } from "./catalogues.ts";

describe("frenchDate", () => {
    it("reads a date written in French", () => {
        expect(frenchDate("mardi 3 novembre 2026")).toBe("2026-11-03");
        expect(frenchDate("dimanche 28 février 2027")).toBe("2027-02-28");
        expect(frenchDate("bientôt")).toBeNull();
    });
});

describe("parseCatalogueCard", () => {
    const card = {
        title: "\n Les prix bas de la semaine ",
        dates: ["mardi 3 novembre 2026", "dimanche 15 novembre 2026"],
        href: "https://www.magasins-u.com/promotions/tous-les-catalogues/les-prix-bas-abc123.m12345",
    };

    it("reads the id, title and dates, and tells an upcoming catalogue", () => {
        expect(parseCatalogueCard(card, "2026-10-31")).toEqual({
            id: "les-prix-bas-abc123",
            title: "Les prix bas de la semaine",
            from: "2026-11-03",
            until: "2026-11-15",
            upcoming: true,
        });
        expect(parseCatalogueCard(card, "2026-11-03")?.upcoming).toBe(false);
    });

    it("skips a card without a catalogue link", () => {
        expect(parseCatalogueCard({ ...card, href: "" }, "2026-10-31")).toBeNull();
    });
});

describe("parseCatalogueTile", () => {
    it("reads a multi-buy offer and keeps every price line", () => {
        expect(
            parseCatalogueTile({
                name: " YAOURT EXEMPLE BIO ",
                description: " Le pack de 4 pots (soit 500 g) ",
                banner: "PROMOTION du 03/11 au 15/11",
                offer: "LE 2EME A -60% DE REMISE IMMEDIATE",
                offerDetail: " ",
                price: "1,82 €",
                prices: "1,82 € Le 1er pack au choix\n soit 2,54 € les 2 packs au choix Le kg : 3,64 €.",
            }),
        ).toEqual({
            name: "YAOURT EXEMPLE BIO",
            description: "Le pack de 4 pots (soit 500 g)",
            banner: "PROMOTION du 03/11 au 15/11",
            offer: "LE 2EME A -60% DE REMISE IMMEDIATE",
            offerDetail: null,
            price: 1.82,
            prices: "1,82 € Le 1er pack au choix soit 2,54 € les 2 packs au choix Le kg : 3,64 €.",
        });
    });

    it("skips a tile without a name", () => {
        expect(
            parseCatalogueTile({
                name: "",
                description: "",
                banner: "",
                offer: "",
                offerDetail: "",
                price: "",
                prices: "",
            }),
        ).toBeNull();
    });
});

describe("matches", () => {
    const product = {
        name: "LESSIVE LIQUIDE EXEMPLE",
        description: "Variétés au choix, 30 lavages",
        banner: null,
        offer: null,
        offerDetail: null,
        price: null,
        prices: null,
    };

    it("finds every word, ignoring case and accents", () => {
        expect(matches(product, "lessive varietes")).toBe(true);
        expect(matches(product, "Lessive café")).toBe(false);
    });
});
