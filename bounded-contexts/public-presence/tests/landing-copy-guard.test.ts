import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "@chase-sets/localization/locales/en/public-presence";
import {
  BANNED_LANDING_TERMS,
  findLandingCopyViolations,
  landingCopyEntries,
  LANDING_COPY_NAMESPACE_PREFIXES,
} from "../features/waitlist/ui/landing-copy-guard";

describe("landing copy banned-vocabulary guard", () => {
  it("scans real landing namespaces, not a filename or a fixture", () => {
    const entries = landingCopyEntries(publicPresenceEnglishTranslations);
    // A real, current-content assertion: if this drops to zero the namespace
    // prefixes below stopped matching real keys and the guard is inert.
    expect(entries.length).toBeGreaterThan(50);
    for (const [key] of entries) {
      expect(LANDING_COPY_NAMESPACE_PREFIXES.some((prefix) => key.startsWith(prefix))).toBe(true);
    }
  });

  it("finds zero banned-vocabulary hits in the current landing copy", () => {
    const violations = findLandingCopyViolations(publicPresenceEnglishTranslations);
    expect(violations).toEqual([]);
  });

  it("flags every seeded banned term when it appears in an in-scope key", () => {
    for (const bannedTerm of BANNED_LANDING_TERMS) {
      const probePhrase = bannedTerm.term.replace(/\(s\)$/, "");
      const probe = { "publicPresence.home.title": `This mentions ${probePhrase} in a sentence.` };
      const violations = findLandingCopyViolations(probe, [bannedTerm]);
      expect(violations, `expected "${bannedTerm.term}" to be flagged`).toHaveLength(1);
      expect(violations[0]?.term).toBe(bannedTerm.term);
    }
  });

  it("ignores banned terms outside the landing-visible namespaces", () => {
    // publicPresence.info.founders.buyerEconomics.body legitimately uses
    // "shipping allowance" — it is out of #5618's scope (not a landing
    // namespace) and must stay untouched. The guard must not reach it.
    const probe = { "publicPresence.info.founders.buyerEconomics.body": "funded through the shipping allowance" };
    expect(findLandingCopyViolations(probe)).toEqual([]);
  });

  it("fails through the real guard path when a banned term is inserted into real landing copy", () => {
    // Demonstrates the guard is live against the actual translations object,
    // not a copy that only ever passes.
    const withInsertedTerm = {
      ...publicPresenceEnglishTranslations,
      "publicPresence.home.title": "The marketplace with a projection engine.",
    };
    const violations = findLandingCopyViolations(withInsertedTerm);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key: "publicPresence.home.title", term: "projection(s)" });
  });
});
