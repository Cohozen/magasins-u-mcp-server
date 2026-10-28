import { describe, expect, it } from "vitest";
import { parseReceiptRows } from "./receipt.ts";
import { buildTextGrid, type TextFragment } from "./text-grid.ts";

// A synthetic receipt laid out like the real ones: same columns, same wording, invented store,
// products and amounts.
const GRID = [
    "                   VILLE EXEMPLE",
    "                     Magasin 12345",
    "                     *** VENTE ***",
    "EPICERIE",
    "PATES COQUILLETTES 500G                      1,20 €   11",
    "            2 x       0,60 EUR",
    "FRUITS ET LEGUMES",
    "KIWI JAUNE                                   2,40 €   11",
    "            2 x       1,20 EUR",
    "LOT PROMO KIWI JAUNE                        -0,40",
    "TOMATES GRAPPE                               1,50 €   11",
    "    Pesée manuelle",
    "     0,500 kg x       3,00   €/kg",
    "Nombre de lignes d'article 3",
    "                                             -----------",
    "TOTAL [5] Articles                                4,70 €",
    "SOUS-TOTAL                                        4,45 €",
    "TOTAL TVA                                         0,25 €",
    "*************  VOS REDUCTIONS IMMEDIATES ***************",
    "1 x    0.50€ LOT 2 PATES                         -0,50 €",
    "TOTAL REDUCTIONS IMMEDIATES                      -0,50 €",
    "********************************************************",
    "RESTE A PAYER                                     4,20 €",
    "CB SANS CONTACT                                   4,20 €",
    "                 001012345150326002000123",
    "       Date     Heure    Magasin Tpv  Util   Tick",
    "       15/03/26 10:05:42 12345   002  100    123",
    "                 MERCI DE VOTRE VISITE",
];

const replaced = (needle: RegExp, row: string): string[] =>
    GRID.map((line) => (needle.test(line) ? row : line));

const receipt = () => {
    const result = parseReceiptRows(GRID);
    if (!result.ok) throw new Error(result.reason);
    return result.receipt;
};

const rejection = (grid: readonly string[]): string => {
    const result = parseReceiptRows(grid);
    if (result.ok) throw new Error("the receipt should have been rejected");
    return result.reason;
};

describe("parseReceiptRows", () => {
    it("reads the receipt identity from its footer", () => {
        expect(receipt()).toMatchObject({
            ref: "12345-20260315-002-123",
            store: "12345",
            date: "2026-03-15",
            time: "10:05:42",
            total: 4.7,
            discounts: -0.5,
            amountPaid: 4.2,
        });
    });

    it("reads item lines with their department, quantity and unit price", () => {
        expect(receipt().lines).toEqual([
            {
                section: "EPICERIE",
                label: "PATES COQUILLETTES 500G",
                quantity: 2,
                unit: "piece",
                unitPrice: 0.6,
                total: 1.2,
                rebate: null,
                rebateLabel: null,
                vatCode: "11",
            },
            expect.objectContaining({
                label: "KIWI JAUNE",
                rebate: -0.4,
                rebateLabel: "LOT PROMO KIWI JAUNE",
            }),
            expect.objectContaining({
                section: "FRUITS ET LEGUMES",
                label: "TOMATES GRAPPE",
                quantity: 0.5,
                unit: "kg",
                unitPrice: 3,
                total: 1.5,
            }),
        ]);
    });

    it("reads the immediate discounts block", () => {
        expect(receipt().discountLines).toEqual([
            { label: "LOT 2 PATES", quantity: 1, unitAmount: 0.5, total: -0.5 },
        ]);
    });

    it("takes the total as the amount paid when there is no discount block", () => {
        const grid = GRID.filter(
            (row) =>
                !/REDUCTIONS IMMEDIATES|^1 x|RESTE A PAYER|^\*+$/.test(row) &&
                !row.startsWith("CB "),
        );
        const result = parseReceiptRows(grid);
        expect(result.ok && result.receipt).toMatchObject({ discounts: 0, amountPaid: 4.7 });
    });

    it("rejects a receipt whose lines do not add up to the total", () => {
        expect(rejection(replaced(/^PATES/, "PATES COQUILLETTES 500G   1,30 €   11"))).toMatch(
            /lines add up to/,
        );
    });

    it("rejects a receipt whose line count differs from the declared one", () => {
        expect(rejection(replaced(/^Nombre de lignes/, "Nombre de lignes d'article 4"))).toMatch(
            /3 line\(s\) read/,
        );
    });

    it("rejects a receipt whose amount paid does not follow the discounts", () => {
        expect(rejection(replaced(/^RESTE A PAYER/, "RESTE A PAYER    4,30 €"))).toMatch(
            /do not make RESTE A PAYER/,
        );
    });

    it("rejects a receipt whose barcode contradicts the footer", () => {
        expect(rejection(replaced(/^\s+0010/, "   001012345150326002000999"))).toMatch(
            /contradicts the footer/,
        );
    });

    it("rejects an unknown detail line rather than guessing", () => {
        expect(rejection(replaced(/2 x\s+0,60/, "            2 pour 0,60"))).toMatch(
            /unknown detail line/,
        );
    });

    it("rejects a document that is not a receipt", () => {
        expect(rejection(["Bonjour", "Ceci n'est pas un ticket"])).toMatch(/not found/);
    });
});

/** A fragment at `column` of `row`, with a 10-point pitch. */
const at = (column: number, row: number, str: string): TextFragment => ({
    str,
    x: column * 10,
    y: -row * 20,
    width: str.length * 10,
});

describe("buildTextGrid", () => {
    it("returns lines top to bottom, each fragment at its column", () => {
        expect(buildTextGrid([at(0, 1, "DEUX"), at(0, 0, "AB"), at(5, 0, "CD")])).toEqual([
            "AB   CD",
            "DEUX",
        ]);
    });

    it("keeps leading indentation and drops trailing spaces", () => {
        const trailing: TextFragment = { str: "   ", x: 100, y: 0, width: 30 };
        expect(buildTextGrid([at(0, 0, "ARTICLE"), at(4, 1, "detail"), trailing])).toEqual([
            "ARTICLE",
            "    detail",
        ]);
    });

    it("never lets a blank fragment erase text already placed", () => {
        const blank: TextFragment = { str: " ", x: 0, y: 0, width: 100 };
        expect(buildTextGrid([at(0, 0, "MONTANT"), blank])).toEqual(["MONTANT"]);
    });

    it("returns nothing when there is no pitch to measure", () => {
        expect(buildTextGrid([])).toEqual([]);
    });
});
