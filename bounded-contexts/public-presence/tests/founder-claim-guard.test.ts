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
import { publicPolicyRegistry } from "../features/policies/domain/policy-registry";

const articlesDirectory = join(dirname(fileURLToPath(import.meta.url)), "../features/help/domain/articles");
const helpArticleSources = readdirSync(articlesDirectory)
  .filter((fileName) => fileName.endsWith(".md"))
  .sort()
  .map((fileName) => ({ fileName, source: readFileSync(join(articlesDirectory, fileName), "utf8") }));
const mutantKey = "publicPresence.info.founders.offer.body";

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
    expect(corpus.localeEntries).toHaveLength(28);
    expect(corpus.helpArticles).toHaveLength(17);
    expect(corpus.registeredArtifacts).toHaveLength(7);
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
      "founders FAQ title",
      {
        id: "publicPresence.info.founders.faqForever.title",
        text: publicPresenceEnglishTranslations["publicPresence.info.founders.faqForever.title"],
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
    expect(publicPresenceEnglishTranslations["publicPresence.info.founders.faqForever.body"]).toContain(feeLockPromise);
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
    expect(localeSources.some(({ id }) => id === "publicPresence.info.founders.faqForever.title")).toBe(true);
  });
});
