import { describe, expect, it } from "vitest";
import { isChallengeTitle, isNight, isSessionCookie, randomBetween } from "./browser.ts";
import { parseRange } from "./config.ts";

describe("isNight", () => {
    it("handles a night across midnight", () => {
        expect(isNight(23, [23, 7])).toBe(true);
        expect(isNight(3, [23, 7])).toBe(true);
        expect(isNight(7, [23, 7])).toBe(false);
        expect(isNight(12, [23, 7])).toBe(false);
    });

    it("handles a night within one day", () => {
        expect(isNight(1, [1, 5])).toBe(true);
        expect(isNight(5, [1, 5])).toBe(false);
    });
});

describe("isSessionCookie", () => {
    const cookie = (name: string, domain: string, expires = -1) => ({ name, domain, expires });

    it("keeps the session cookies of the site and of the SSO", () => {
        expect(isSessionCookie(cookie("dwsid", "www.coursesu.com"))).toBe(true);
        expect(isSessionCookie(cookie("amlbcookie", ".magasins-u.com"))).toBe(true);
    });

    it("drops Cloudflare, persistent cookies and other domains", () => {
        expect(isSessionCookie(cookie("cf_clearance", ".coursesu.com"))).toBe(false);
        expect(isSessionCookie(cookie("__cf_bm", ".coursesu.com"))).toBe(false);
        expect(isSessionCookie(cookie("_cfuvid", ".coursesu.com"))).toBe(false);
        expect(isSessionCookie(cookie("storeId", "www.coursesu.com", 1_800_000_000))).toBe(false);
        expect(isSessionCookie(cookie("sid", ".evilcoursesu.com"))).toBe(false);
    });
});

describe("isChallengeTitle", () => {
    it("recognises the Cloudflare interstitial in French and English", () => {
        expect(isChallengeTitle("Un instant…")).toBe(true);
        expect(isChallengeTitle("Just a moment...")).toBe(true);
        expect(isChallengeTitle("Drive, Courses en ligne et Livraison à Domicile")).toBe(false);
    });
});

describe("randomBetween", () => {
    it("stays within the bounds, inclusive", () => {
        for (let i = 0; i < 200; i++) {
            const value = randomBetween([3, 5]);
            expect(value).toBeGreaterThanOrEqual(3);
            expect(value).toBeLessThanOrEqual(5);
        }
    });
});

describe("parseRange", () => {
    it('reads "min-max" and rejects anything else', () => {
        expect(parseRange("X", "20-30")).toEqual([20, 30]);
        expect(parseRange("X", "23 - 7")).toEqual([23, 7]);
        expect(() => parseRange("X", "20")).toThrow("X is invalid");
    });
});
