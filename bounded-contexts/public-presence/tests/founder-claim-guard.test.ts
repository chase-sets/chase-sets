import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicPresenceEnglishTranslations } from "@chase-sets/localization/locales/en/public-presence";
import { describe, expect, it } from "vitest";
import {
  collectFounderClaimCorpus,
  evaluateFounderClaimCorpus,
  findFounderClaimViolations,
  founderLocaleClaimSources,
  type FounderClaimTextSource,
} from "../features/policies/domain/founder-claim-guard";
import { foundersOfferTermsPolicyArtifact } from "../features/policies/domain/founders-offer-terms";
import { termsOfServicePolicyArtifact } from "../features/policies/domain/terms-of-service";
import { canonicalClaimIds } from "../features/policies/domain/canonical-claims";
import {
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "../features/policies/domain/policy-artifact";
import { publicPolicyRegistry } from "../features/policies/domain/policy-registry";

const articlesDirectory = join(dirname(fileURLToPath(import.meta.url)), "../features/help/domain/articles");
const helpArticleSources = readdirSync(articlesDirectory)
  .filter((fileName) => fileName.endsWith(".md"))
  .sort()
  .map((fileName) => ({ fileName, source: readFileSync(join(articlesDirectory, fileName), "utf8") }));
const mutantKey = "publicPresence.home.foundersOffer.syntheticControl.body";

function evaluateRealCorpus(translations: Readonly<Record<string, string>> = publicPresenceEnglishTranslations) {
  return evaluateFounderClaimCorpus(collectFounderClaimCorpus(translations, helpArticleSources, publicPolicyRegistry));
}

function realPolicyDraftContaining(fragment: string): FounderClaimTextSource {
  for (const { artifact } of publicPolicyRegistry) {
    for (const section of artifact.sections) {
      if (section.draftText.includes(fragment)) {
        return {
          id: `policy:${artifact.metadata.policyKey}:${section.id}`,
          text: section.draftText,
          founderScoped: false,
        };
      }
    }
  }
  throw new Error(`Expected a registered policy draft containing '${fragment}'.`);
}

describe("founder badge permanence claim guard", () => {
  it("reports zero violations across the real locale, help-article, and registered-policy corpus", () => {
    expect(evaluateRealCorpus()).toEqual([]);
  });

  it("keeps the real scan live with non-trivial source counts", () => {
    const corpus = collectFounderClaimCorpus(
      publicPresenceEnglishTranslations,
      helpArticleSources,
      publicPolicyRegistry,
    );
    expect(corpus.localeEntries.length).toBeGreaterThanOrEqual(10);
    expect(corpus.helpArticles.length).toBeGreaterThanOrEqual(2);
    expect(corpus.registeredArtifacts.length).toBeGreaterThanOrEqual(6);
    expect(corpus.localeEntries).toHaveLength(12);
    expect(corpus.helpArticles).toHaveLength(17);
    expect(corpus.registeredArtifacts).toHaveLength(7);
    expect(corpus.policyDrafts.filter((source) => source.founderScoped)).toHaveLength(6);
    expect(corpus.policyDrafts.filter((source) => source.founderScoped).map((source) => source.text)).toEqual(
      foundersOfferTermsPolicyArtifact.sections.map((section) => section.draftText),
    );
  });

  it.each([
    ["permanent", "Your founder badge is permanent."],
    ["permanently", "Your founder badge is displayed permanently."],
    ["never expire", "Your founder badge will never expire."],
    ["never expires", "Your founder badge never expires."],
    ["forever", "Your founder badge is displayed forever."],
    ["cannot be revoked", "Your founder badge cannot be revoked."],
    ["cannot be changed", "Your founder badge cannot be changed."],
    ["permanent", "Your founder badge is publicly displayed. It remains permanent."],
  ] as const)("flags the '%s' founder-badge mutant through the real corpus path", (term, text) => {
    const translations = { ...publicPresenceEnglishTranslations, [mutantKey]: text };
    const violations = evaluateRealCorpus(translations);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ sourceId: mutantKey, term });
  });

  it("accepts the ratified publicly-displayed wording through the real corpus path", () => {
    const translations = {
      ...publicPresenceEnglishTranslations,
      [mutantKey]:
        "The first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed.",
    };
    expect(evaluateRealCorpus(translations)).toEqual([]);
  });

  it.each([
    ["wallet adjustment entry", realPolicyDraftContaining("single, permanent Wallet ledger entry")],
    ["wallet history", realPolicyDraftContaining("recorded permanently")],
    ["privacy retention", realPolicyDraftContaining("permanent records that are never edited or deleted")],
    [
      "promo-bar deletion",
      {
        id: "publicPresence.promoBar.delete.confirm.description",
        text: publicPresenceEnglishTranslations["publicPresence.promoBar.delete.confirm.description"],
        founderScoped: false,
      },
    ],
    [
      "synthetic fee-lock question",
      {
        id: "synthetic-fee-lock-question",
        text: "Is this forever?",
        founderScoped: true,
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, FounderClaimTextSource]>)(
    "leaves legitimate non-founder permanence copy out of reach: %s",
    (_label, source) => {
      expect(findFounderClaimViolations([source])).toEqual([]);
    },
  );

  it("preserves the ratified locked-rate-until-sale promise", () => {
    const feeLockPromise = "Listings you locked at 0% keep that rate until they sell.";
    expect(findFounderClaimViolations([{ id: "fee-lock-control", text: feeLockPromise, founderScoped: true }])).toEqual(
      [],
    );
    expect(publicPresenceEnglishTranslations["publicPresence.home.foundersOffer.point.expiry"]).toContain(
      feeLockPromise,
    );
    expect(
      foundersOfferTermsPolicyArtifact.sections.find((section) => section.id === "offer-window-and-fee-lock")!
        .draftText,
    ).toContain(feeLockPromise);
  });

  it("does not bind true fee-lock permanence in one clause to a badge displayed in the next clause", () => {
    const source = {
      id: "fee-lock-and-badge-control",
      text: "Listings you locked at 0% keep that rate forever, and your founder badge is publicly displayed.",
      founderScoped: true,
    };
    expect(findFounderClaimViolations([source])).toEqual([]);
  });

  it("scopes locale scanning to founder claim namespaces", () => {
    const localeSources = founderLocaleClaimSources(publicPresenceEnglishTranslations);
    expect(localeSources.some(({ id }) => id === "publicPresence.promoBar.delete.confirm.description")).toBe(false);
    expect(localeSources.some(({ id }) => id === "publicPresence.info.founders.eyebrow")).toBe(true);
  });
});

function withFoundersDraft(sectionId: string, draftText: string) {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === "founders-offer-terms"
      ? {
          ...entry,
          artifact: {
            ...entry.artifact,
            sections: entry.artifact.sections.map((section) =>
              section.id === sectionId ? { ...section, draftText } : section,
            ),
          },
        }
      : entry,
  );
}

function assertVisibleCounselScope(artifact: PublicPolicyArtifact, subjectId: string) {
  const section = artifact.sections.find((section) => section.id === subjectId)!;
  expect(section.reviewStatus).toBe("counsel-required");
  expect(section.reviewManifest.openQuestions.length).toBeGreaterThan(0);
  expect(section.draftText, `${subjectId}: visible unresolved scope`).toMatch(/awaits? counsel review/);
  expect(section.draftText, `${subjectId}: visible unratified scope`).toMatch(/(?:has|have) not been ratified/);
  const forbidden =
    subjectId === "no-cash-value"
      ? /(?:offer has no cash value|offer is cash-equivalent|offer is transferable)/i
      : /(?:may terminate at any time|may forfeit existing locks|without notice|30 days.? notice)/i;
  expect(section.draftText, `${subjectId}: no settled legal assertion`).not.toMatch(forbidden);
}

describe("registered founders artifact claim controls", () => {
  it.each([
    ["permanent", "is permanent"],
    ["permanently", "is displayed permanently"],
    ["never expire", "will never expire"],
    ["never expires", "never expires"],
    ["forever", "is displayed forever"],
    ["cannot be revoked", "cannot be revoked"],
    ["cannot be changed", "cannot be changed"],
  ] as const)(
    "rejects '%s' directly and through adjacent-sentence anaphora in the real registered artifact",
    (term, phrase) => {
      for (const text of [`Your founder badge ${phrase}.`, `Your founder badge is publicly displayed. It ${phrase}.`]) {
        const corpus = collectFounderClaimCorpus(
          publicPresenceEnglishTranslations,
          helpArticleSources,
          withFoundersDraft("what-the-badge-means", text),
        );
        const violations = evaluateFounderClaimCorpus(corpus);
        expect(violations).toHaveLength(1);
        expect(violations[0]).toMatchObject({ sourceId: "policy:founders-offer-terms:what-the-badge-means", term });
      }
    },
  );

  it("keeps badge display and separate fee-lock durability green in the real registry", () => {
    const registry = withFoundersDraft(
      "what-the-badge-means",
      "Listings you locked at 0% keep that rate forever, and your founder badge is publicly displayed.",
    );
    expect(
      evaluateFounderClaimCorpus(
        collectFounderClaimCorpus(publicPresenceEnglishTranslations, helpArticleSources, registry),
      ),
    ).toEqual([]);
  });

  it.each([
    ["changes-and-termination", "Chase Sets may terminate at any time and may forfeit existing locks without notice."],
    ["no-cash-value", "The founders offer has no cash value."],
  ])(
    "keeps %s visibly unresolved and rejects settled copy even with an intact valid manifest",
    (subjectId, settled) => {
      assertVisibleCounselScope(foundersOfferTermsPolicyArtifact, subjectId);
      for (const append of [false, true]) {
        const original = foundersOfferTermsPolicyArtifact.sections.find((section) => section.id === subjectId)!;
        const registry = withFoundersDraft(subjectId, append ? `${original.draftText} ${settled}` : settled);
        const mutant = registry.find((entry) => entry.artifact.metadata.policyKey === "founders-offer-terms")!.artifact;
        expect(mutant.sections.find((section) => section.id === subjectId)!.reviewManifest).toEqual(
          original.reviewManifest,
        );
        expect(validatePublicPolicyArtifactStructure(mutant)).toEqual([]);
        expect(() => assertVisibleCounselScope(mutant, subjectId)).toThrow(
          append ? "no settled legal assertion" : "visible unresolved scope",
        );
      }
    },
  );

  it("references the existing Terms Wallet subject without inventing a canonical claim or local Wallet status", () => {
    const owner = termsOfServicePolicyArtifact.sections.find(
      (section) => section.id === "cash-equivalent-and-marketplace-credit",
    )!;
    expect(owner.reviewManifest.openQuestions).toEqual([]);
    expect(owner.draftText).toContain("Chase Sets does not currently offer Marketplace Credit");
    expect(canonicalClaimIds).not.toContain("cash-equivalent-and-marketplace-credit");
    const subject = foundersOfferTermsPolicyArtifact.sections.find((section) => section.id === "no-cash-value")!;
    expect(subject.draftText).toContain("subject of the Terms of Service at /terms");
    expect(subject.reviewManifest.canonicalClaims).toBeUndefined();
    expect(subject.claimDisclosures).toBeUndefined();
  });
});
