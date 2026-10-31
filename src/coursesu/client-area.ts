/**
 * The "Espace client" of coursesu.com: till receipts and the Carte U loyalty account.
 *
 * This area is a separate app that fetches its data from an account API with a bearer token held
 * by the page. The server never stores that token: it loads the page and reads the answers the
 * page's own calls get. Only the receipt download reuses the page's request headers, in memory,
 * for one more call of the same API.
 */

import type { Response } from "patchright";
import { ORIGIN, type Site } from "../browser.ts";
import { euros, squash } from "./catalog.ts";
import { readPdfText } from "./pdf-text.ts";
import { parseReceipt, type Receipt } from "./receipt.ts";

const API = "https://ext-api.systeme-u.com/espaceclient-comptes-process-api/v1";
const CLIENT_AREA = `${ORIGIN}/espace-client`;

// --- Receipts ---------------------------------------------------------------------------------

type RawTransaction = {
    transactionId?: string;
    date?: string;
    amount?: string;
    magasin?: string;
    etickets?: { filename?: string; attachmentIndex?: string }[];
};

export type Transaction = {
    id: string;
    /** ISO date and time, UTC. */
    date: string | null;
    amount: number | null;
    store: string | null;
    /** A till receipt can be read with `get_receipt`; card slips cannot. */
    hasReceipt: boolean;
};

const isReceipt = (document: { filename?: string }): boolean =>
    /ticket de caisse/i.test(document.filename ?? "");

type TransactionAnswer = {
    hasMoreTransactions?: boolean;
    monthlyTransactions?: Record<string, RawTransaction[]>;
};

/** Every transaction of the answers, once each (a later answer may repeat the first months). */
const rawTransactions = (answers: string[]): RawTransaction[] => {
    const seen = new Set<string>();
    return answers
        .flatMap((json) =>
            Object.values((JSON.parse(json) as TransactionAnswer).monthlyTransactions ?? {}).flat(),
        )
        .filter((raw) => {
            if (raw.transactionId === undefined || seen.has(raw.transactionId)) return false;
            seen.add(raw.transactionId);
            return true;
        });
};

const hasMore = (json: string): boolean =>
    (JSON.parse(json) as TransactionAnswer).hasMoreTransactions === true;

/**
 * Answers of `POST /moncompte/etickets`: transactions grouped by month, newest first. The page
 * asks for the last three months, then for older ones when "Voir plus" is clicked.
 */
export const parseTransactions = (
    ...answers: string[]
): { hasMore: boolean; transactions: Transaction[] } => {
    const transactions = rawTransactions(answers)
        .flatMap((raw) =>
            raw.transactionId === undefined
                ? []
                : [
                      {
                          id: raw.transactionId,
                          // The API sends UTC without a zone ("2026-10-28T09:54:00" for 10:54 in Paris).
                          date: raw.date ? raw.date.replace(/^([^Z+]*)$/, "$1Z") : null,
                          amount: euros(raw.amount),
                          store: raw.magasin ?? null,
                          hasReceipt: (raw.etickets ?? []).some(isReceipt),
                      },
                  ],
        )
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
    return { hasMore: hasMore(answers.at(-1) ?? "{}"), transactions };
};

const isTransactionList = (answer: Response): boolean =>
    answer.request().method() === "POST" && answer.url() === `${API}/moncompte/etickets`;

/**
 * Opens the receipts page and returns the answers its calls got: the last three months, then,
 * when asked and when there are more, the older ones the "Voir plus" button loads (about two years).
 */
const loadTransactions = async (site: Site, older: boolean) => {
    const { page, response } = await site.gotoAndWait(
        `${CLIENT_AREA}?ec-page=e-tickets`,
        isTransactionList,
    );
    const answers = [await response.text()];
    if (older) await addOlder(site, answers);
    return { page, response, answers };
};

/** Clicks "Voir plus" when the last answer says there are more, and keeps the new answer. */
const addOlder = async (site: Site, answers: string[]): Promise<void> => {
    if (!hasMore(answers.at(-1) ?? "{}")) return;
    const more = await site.clickAndWait("[data-ec-load-more-tickets]", isTransactionList);
    answers.push(await more.text());
};

/** Till receipts and card slips of the last three months, or of about two years with `older`. */
export const getReceipts = async (site: Site, older: boolean) =>
    parseTransactions(...(await loadTransactions(site, older)).answers);

export type ReceiptAnswer = { ok: true; receipt: Receipt } | { ok: false; reason: string };

/** Downloads a till receipt's PDF from the account API and reads it. */
export const getReceipt = async (site: Site, transactionId: string): Promise<ReceiptAnswer> => {
    const { page, response, answers } = await loadTransactions(site, false);
    const find = () => rawTransactions(answers).find((raw) => raw.transactionId === transactionId);
    if (find() === undefined) await addOlder(site, answers);
    const transaction = find();
    if (transaction === undefined) {
        return { ok: false, reason: "No such transaction (see get_receipts)." };
    }
    const receipt = (transaction.etickets ?? []).find(isReceipt);
    if (receipt === undefined) {
        return { ok: false, reason: "This transaction has no till receipt, only card slips." };
    }

    // The same headers as the page's own call (bearer token, client id), kept in memory only.
    const headers = await response.request().allHeaders();
    const keep = Object.fromEntries(
        Object.entries(headers).filter(([name]) =>
            ["authorization", "clientid", "versionfront"].includes(name.toLowerCase()),
        ),
    );
    const url = `${API}/moncompte/etickets/${encodeURIComponent(transactionId)}/${receipt.attachmentIndex ?? "0"}/download`;
    const { status, bytes } = await page.evaluate(
        async ([target, sent]) => {
            const answer = await fetch(target, { headers: sent });
            return {
                status: answer.status,
                bytes: Array.from(new Uint8Array(await answer.arrayBuffer())),
            };
        },
        [url, keep] as const,
    );
    if (status !== 200) throw new Error(`receipt download answered HTTP ${status}`);
    const parsed = parseReceipt(await readPdfText(Uint8Array.from(bytes)));
    return parsed.ok
        ? parsed
        : { ok: false, reason: `The receipt could not be read reliably: ${parsed.reason}.` };
};

// --- Loyalty ----------------------------------------------------------------------------------

type RawOffer = {
    id?: string;
    type?: string;
    titre?: string | null;
    description?: string | null;
    dateDebut?: string | null;
    dateFin?: string | null;
    montant?: number | null;
    montantCagnotte?: number | null;
    datePaiement?: string | null;
    isNouveau?: boolean | null;
};

export type Offer = {
    id: string;
    /** "PRODUIT" (a brand's product) or "ENSEIGNE" (store-wide, often a department). */
    type: string | null;
    title: string | null;
    description: string | null;
    /** Euros credited to the Carte U, when fixed. */
    amount: number | null;
    from: string | null;
    until: string | null;
    isNew: boolean;
    /** Used offers: euros earned and when they were credited. */
    earned?: number | null;
    paidOn?: string | null;
};

const offer = (raw: RawOffer, used: boolean): Offer[] =>
    raw.id === undefined
        ? []
        : [
              {
                  id: raw.id,
                  type: raw.type ?? null,
                  title: raw.titre ? squash(raw.titre) : null,
                  description: raw.description ? squash(raw.description) : null,
                  amount: raw.montant ?? null,
                  from: raw.dateDebut ?? null,
                  until: raw.dateFin ?? null,
                  isNew: raw.isNouveau === true,
                  ...(used
                      ? { earned: raw.montantCagnotte ?? null, paidOn: raw.datePaiement ?? null }
                      : {}),
              },
          ];

/** Answer of `GET /mesoffres/v2`: digital offers to activate, activated and used. */
export const parseOffers = (json: string) => {
    const data = JSON.parse(json) as {
        offresDisponibles?: RawOffer[];
        offresActivees?: RawOffer[];
        offresUtilisees?: RawOffer[];
    };
    return {
        available: (data.offresDisponibles ?? []).flatMap((raw) => offer(raw, false)),
        activated: (data.offresActivees ?? []).flatMap((raw) => offer(raw, false)),
        used: (data.offresUtilisees ?? []).flatMap((raw) => offer(raw, true)),
    };
};

/** Carte U balance and digital offers ("Mes offres"). */
export const getLoyalty = async (site: Site) => {
    const { page, response } = await site.gotoAndWait(
        `${CLIENT_AREA}?ec-page=fidelite&ec-section=offres`,
        (answer) => answer.url().startsWith(`${API}/mesoffres/v2?`),
    );
    const balance = await page.evaluate(
        () => document.querySelector("[data-fake-ark-cardu-value]")?.textContent ?? null,
    );
    return {
        balance: euros(/(\d+,\d{2})/.exec(balance ?? "")?.[1]),
        offers: parseOffers(await response.text()),
    };
};
