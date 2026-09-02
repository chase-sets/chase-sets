import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import { renderPublicPolicyPublicationContracts } from "../integrations/compile-policy-publications.mjs";
import {
  foundersOfferTermsPolicyArtifact as artifact,
  foundersOfferTermsSourceTopicMapping as mapping,
  requiredFoundersOfferTermsSubjectIds,
} from "./founders-offer-terms";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "./policy-artifact";
import { publicPolicyRegistry } from "./policy-registry";

const subjectIds = [
  "eligibility-and-cap",
  "offer-window-and-fee-lock",
  "what-the-badge-means",
  "changes-and-termination",
  "no-cash-value",
  "relationship-to-tos",
];
const topicOracle = {
  offer: ["eligibility-and-cap", "offer-window-and-fee-lock", "what-the-badge-means"],
  feeLock: ["offer-window-and-fee-lock"],
  buyerEconomics: ["relationship-to-tos"],
  afterWindow: ["offer-window-and-fee-lock"],
  faqForever: ["offer-window-and-fee-lock", "what-the-badge-means"],
  faqSignup: ["eligibility-and-cap", "offer-window-and-fee-lock"],
  faqKeep: ["offer-window-and-fee-lock", "relationship-to-tos"],
};
const publicFoundersOfferTermsPublicationRecord = publicPolicyPublicationRecords["founders-offer-terms"];
const oldFingerprint = "sha256:483dda004c66223ca7dc76bd280e96e8261ee625c6f45676acaf09112ed51c30";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const readSource = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

function assertTopics(candidate: Readonly<Record<string, readonly string[]>>) {
  expect(Object.keys(candidate).sort(), "seven source topics").toEqual(Object.keys(topicOracle).sort());
  expect(candidate, "topic destinations").toEqual(topicOracle);
  for (const destinations of Object.values(candidate)) {
    expect(destinations.length).toBeGreaterThan(0);
    expect(destinations.every((id) => subjectIds.includes(id))).toBe(true);
  }
}

function assertSubjects(ids: readonly string[]) {
  expect(ids, "exact ordered subjects").toEqual(subjectIds);
}

function registryWith(candidate: PublicPolicyArtifact) {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === "founders-offer-terms" ? { ...entry, artifact: candidate } : entry,
  );
}

function syntheticPublished(): PublicPolicyArtifact {
  return {
    ...artifact,
    metadata: {
      ...artifact.metadata,
      publicationStatus: "published",
      effectiveAt: "2099-01-01T00:00:00.000Z",
      counselApprovalReference: "SYNTHETIC-FOUNDERS-COUNSEL-TEST-ONLY",
      rolloutJurisdictionsOrProductLimits: ["Synthetic test scope; no real approval."],
    },
    sections: artifact.sections.map((section) => ({
      ...section,
      reviewStatus: "counsel-approved",
      draftText: `Synthetic reviewed text for ${section.id}.`,
    })),
  };
}

async function compiledFounders(candidate: PublicPolicyArtifact) {
  const modules = await renderPublicPolicyPublicationContracts(registryWith(candidate));
  return modules.find(
    (module: { relativePath: string }) => module.relativePath === "founders-offer-terms-publication.ts",
  )!.content;
}

describe("founders offer terms migration", () => {
  it("covers every migrated founders topic", () => {
    assertTopics(mapping);
    for (const topic of Object.keys(topicOracle)) {
      const mutant: Record<string, readonly string[]> = { ...mapping };
      delete mutant[topic];
      expect(() => assertTopics(mutant), topic).toThrow("seven source topics");
    }
  });

  it("resolves each destination and leaves exactly the two new counsel-draft subjects source-less", () => {
    assertTopics(mapping);
    const destinations = new Set(Object.values(mapping).flat());
    const sourceLess = subjectIds.filter((id) => !destinations.has(id as never));
    expect(sourceLess).toEqual(["changes-and-termination", "no-cash-value"]);
    for (const id of sourceLess) {
      const section = artifact.sections.find((section) => section.id === id)!;
      expect(section.reviewStatus).toBe("counsel-required");
      expect(section.reviewManifest.scopeNote).toContain("no predecessor topic");
      expect(section.reviewManifest.openQuestions.length).toBeGreaterThan(0);
    }
    for (const topic of Object.keys(topicOracle)) {
      expect(() => assertTopics({ ...mapping, [topic]: [] })).toThrow("topic destinations");
      expect(() => assertTopics({ ...mapping, [topic]: ["unknown-subject"] })).toThrow("topic destinations");
    }
  });

  it("requires exactly the six ordered subjects and rejects stub, drop, duplicate and extra controls", () => {
    assertSubjects(requiredFoundersOfferTermsSubjectIds);
    assertSubjects(artifact.sections.map((section) => section.id));
    for (const ids of [
      ["founders-offer-terms-scope", ...subjectIds],
      subjectIds.slice(1),
      [...subjectIds, "seventh-subject"],
      [...subjectIds.slice(0, -1), subjectIds[0]!],
    ])
      expect(() => assertSubjects(ids)).toThrow("exact ordered subjects");
  });

  it("has nonblank content and complete manifests, and rejects unknown nested fields", () => {
    expect(validatePublicPolicyArtifactStructure(artifact)).toEqual([]);
    for (const section of artifact.sections) {
      expect(section.draftText.trim().length, section.id).toBeGreaterThan(0);
      const manifest = section.reviewManifest;
      expect(manifest.scopeNote.trim().length).toBeGreaterThan(0);
      expect(manifest.decisionRefs.length).toBeGreaterThan(0);
      expect(manifest.productTruthRefs.length).toBeGreaterThan(0);
      expect(manifest.assumptions.length).toBeGreaterThan(0);
      for (const assumption of manifest.assumptions) {
        expect(assumption.assertion.trim().length).toBeGreaterThan(0);
        expect(assumption.evidenceRef.trim().length).toBeGreaterThan(0);
      }
    }
    for (const level of ["artifact", "metadata", "section", "manifest", "assumption"]) {
      const mutant = structuredClone(artifact);
      const targets = {
        artifact: mutant,
        metadata: mutant.metadata,
        section: mutant.sections[0]!,
        manifest: mutant.sections[0]!.reviewManifest,
        assumption: mutant.sections[0]!.reviewManifest.assumptions[0]!,
      };
      Object.assign(targets[level as keyof typeof targets], { syntheticUnknown: true });
      expect(validatePublicPolicyArtifactStructure(mutant).join("\n"), level).toContain("unexpected field");
      expect(validatePublicPolicyArtifactStructure(mutant).join("\n")).toContain("syntheticUnknown");
    }
  });

  it("preserves both ratified sentences without copying historical standard fees or cohort activity", () => {
    const copy = artifact.sections.map((section) => section.draftText).join(" ");
    const claim = readSource("docs/campaigns/offer-economics-claims-substantiation.md")
      .split(/\r?\n/)
      .slice(29, 46)
      .join("\n");
    for (const sentence of [
      "Beta access opens a 60-day 0% seller-fee window — every listing you create in that window locks 0% until it sells.",
      "The first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed.",
    ]) {
      expect(claim).toContain(sentence);
      expect(copy).toContain(sentence);
    }
    expect(copy).not.toMatch(/5%|500 bps|\$25|\$0\.00|cohort is.*empty|no wave has been admitted/i);
    for (const href of ["/sales-fees", "/payments-terms", "/terms"]) expect(copy).toContain(href);
  });

  it("keeps committed metadata pending and compiles activation only for synthetic fully reviewed content", async () => {
    expect(artifact.metadata).toEqual({
      policyKey: "founders-offer-terms",
      version: "v1",
      locale: "en",
      href: "/founders",
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
      rolloutJurisdictionsOrProductLimits: [],
      launchRequired: true,
    });
    expect(artifact.sections.every((section) => section.reviewStatus === "counsel-required")).toBe(true);
    expect(isConsentActivatable(artifact, requiredFoundersOfferTermsSubjectIds)).toBe(false);
    expect(await compiledFounders(artifact)).toContain("consentActivatable: false");
    const ready = syntheticPublished();
    expect(evaluatePublicPolicyPublicationReadiness(ready, requiredFoundersOfferTermsSubjectIds)).toEqual({
      ready: true,
      errors: [],
    });
    expect(await compiledFounders(ready)).toContain("consentActivatable: true");
    for (const draftText of ["", " \n\t "]) {
      const blank = {
        ...ready,
        sections: ready.sections.map((section, index) => (index === 0 ? { ...section, draftText } : section)),
      };
      const result = evaluatePublicPolicyPublicationReadiness(blank, requiredFoundersOfferTermsSubjectIds);
      expect(result.ready).toBe(false);
      expect(result.errors).toEqual([
        "Founders Offer Terms subject 'eligibility-and-cap' requires non-empty operative copy.",
      ]);
      expect(await compiledFounders(blank)).toContain("consentActivatable: false");
    }
    const extra: PublicPolicyArtifact = {
      ...ready,
      sections: [
        ...ready.sections,
        {
          ...ready.sections[0]!,
          id: "synthetic-unreviewed-extra",
          reviewStatus: "counsel-required",
        },
      ],
    };
    expect(evaluatePublicPolicyPublicationReadiness(extra, requiredFoundersOfferTermsSubjectIds).errors).toEqual([
      "Founders Offer Terms additional subject 'synthetic-unreviewed-extra' requires counsel-approved copy.",
    ]);
    expect(await compiledFounders(extra)).toContain("consentActivatable: false");
  });

  it("compiles current full fingerprints and isolates a content-only edit to one publication module", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    expect(baseline).toHaveLength(8);
    for (const module of baseline) {
      expect(module.content, module.relativePath).toBe(
        readSource(`contracts/public-docs/generated/${module.relativePath}`),
      );
    }
    expect(publicFoundersOfferTermsPublicationRecord.contentFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(publicFoundersOfferTermsPublicationRecord.contentFingerprint).not.toBe(oldFingerprint);
    expect(publicFoundersOfferTermsPublicationRecord.consentActivatable).toBe(false);
    const edited = {
      ...artifact,
      sections: artifact.sections.map((section, index) =>
        index === 0 ? { ...section, draftText: `${section.draftText} Synthetic content-only test addition.` } : section,
      ),
    };
    expect(edited.metadata).toEqual(artifact.metadata);
    const regenerated = await renderPublicPolicyPublicationContracts(registryWith(edited));
    expect(
      regenerated
        .filter(
          (module: { relativePath: string; content: string }) =>
            module.content !==
            baseline.find((before: { relativePath: string }) => before.relativePath === module.relativePath)!.content,
        )
        .map((module: { relativePath: string }) => module.relativePath),
    ).toEqual(["founders-offer-terms-publication.ts"]);
  });
});

const listingDomain = "bounded-contexts/marketplace/features/listings/domain/domain.ts";
const listingTests = "bounded-contexts/marketplace/features/listings/domain/domain.test.ts";
const listingRuntime = "bounded-contexts/marketplace/features/listings/api/runtime.ts";
const runtimeTests = "bounded-contexts/marketplace/features/listings/api/runtime.test.ts";
const feeLock = "bounded-contexts/marketplace/features/listings/domain/fee-lock.ts";
const feeQuotes = "bounded-contexts/marketplace/support/runtime-support/fee-quotes.ts";
type Citation = readonly [ref: string, ...patterns: RegExp[]];
const quoteChain: Citation[] = [
  [
    `${listingRuntime}:958-978`,
    /async function quoteListingTerms\(accountId: string, priceAmount: string\)\s*\{\s*return quoteMarketplaceTerms\(deps.commercialTermsResolver,/,
    /providedFingerprint !== currentQuote.fee_quote_fingerprint/,
  ],
  [
    `${feeQuotes}:53-78`,
    /export async function quoteMarketplaceTerms/,
    /await resolver.resolveListingTerms\(\{\s*accountId: params.accountId,\s*amount: params.priceAmount/,
    /schedule_id: terms.scheduleId/,
    /agreement_id: terms.agreementId/,
  ],
  [
    `${feeQuotes}:133-152`,
    /export function feeLockFromMarketplaceTermsQuote/,
    /unitCount,\s*terms: \{/,
    /termsScheduleId: quote.schedule_id/,
    /termsAgreementId: quote.agreement_id/,
  ],
];
const creationChain: Citation[] = [
  [`${listingDomain}:380-400`, /type: "CreateListing"/, /feeLock: MarketplaceListingFeeLock/, /quantityCap: number/],
  [`${listingDomain}:499-525`, /"marketplace.listing.created"/, /feeLocks: MarketplaceListingFeeLock\[\]/],
  [
    `${listingDomain}:915-935`,
    /catalogItemId: event.data.catalogItemId/,
    /selectedOptions: event.data.selectedOptions/,
    /feeLocks: event.data.feeLocks/,
  ],
  [
    `${listingRuntime}:1405-1452`,
    /const quote = await quoteListingTerms\(params.accountId, params.priceAmount\)/,
    /type: "CreateListing"/,
    /feeLock: feeLockFromMarketplaceTermsQuote\(params.quantityCap, quote\)/,
  ],
  ...quoteChain,
];
const changedSchedule: Citation = [
  `${runtimeTests}:940-1070`,
  /keeps existing listing fee locks when management changes future terms/,
  /scheduleId: "cts_launch"/,
  /scheduleId: "cts_after_launch"/,
  /await services.createListing/,
  /expect\(originalHistory\)/,
  /expect\(newHistory\)/,
];
const citationRules: readonly (readonly [assertionStart: string, citations: readonly Citation[]])[] = [
  [
    "The cap is 500",
    [
      [
        "bounded-contexts/identity/features/founders-cohort/domain/domain.ts:5-59",
        /FOUNDERS_COHORT_CAP = 500/,
        /state.claims.find\(\(claim\) => claim.accountId === command.accountId\)/,
        /state.claims.length >= FOUNDERS_COHORT_CAP/,
        /founderNumber: state.claims.length \+ 1/,
      ],
    ],
  ],
  [
    "A founders window",
    [
      [
        "bounded-contexts/identity/features/founders-cohort/api/runtime.ts:48-83",
        /if \(!account\?\.foundersWindow\)/,
        /type: "ClaimFounderNumber"/,
        /type: "AssignAccountBadge"/,
      ],
      [
        "bounded-contexts/identity/features/founders-cohort/integrations/marketplace/founder-claim-reaction.ts:22-47",
        /"marketplace.listing.created"/,
        /qualifyingActType: "listing-created"/,
        /"marketplace.offer.submitted"/,
        /qualifyingActType: "offer-submitted"/,
      ],
    ],
  ],
  [
    "Beta access starts",
    [
      [
        "bounded-contexts/identity/api.ts:815-827",
        /if \(params.foundersBetaAccessStartedAt\)/,
        /foundersWindowEndsAt.setUTCDate\(foundersWindowEndsAt.getUTCDate\(\) \+ 60\)/,
        /type: "OpenFoundersWindow"/,
      ],
      [
        "bounded-contexts/identity/GLOSSARY.md:108-120",
        /anchored to beta access, not badge claim/,
        /includes its start and excludes/,
      ],
    ],
  ],
  [
    "The founders agreement",
    [
      [
        "bounded-contexts/commercial-terms/features/agreements/integrations/identity/founders-window-reaction.ts:22-35",
        /agreements.createAgreement/,
        /marketplaceSalesFeePercentageBps: 0/,
        /marketplaceSalesFeeFixedAmount: "0.00"/,
        /effectiveFrom: data.betaAccessStartedAt/,
        /effectiveUntil: data.foundersWindowEndsAt/,
      ],
      [
        "bounded-contexts/commercial-terms/features/resolutions/read-model/resolve.ts:304-354",
        /getActiveSchedule\(db, effectiveAt\)/,
        /getActiveAgreement\(db, params.accountId, effectiveAt\)/,
        /founders_window_started_at <= effectiveAt/,
        /founders_window_ends_at > effectiveAt/,
        /agreement\?\.marketplace_sales_fee_percentage_bps === 0/,
        /agreement.marketplace_sales_fee_fixed_amount === "0.00"/,
        /Founders window agreement is not ready/,
      ],
    ],
  ],
  ["Creation locks", creationChain],
  [
    "Single and bulk",
    [
      [
        `${listingRuntime}:1746-1761`,
        /updateListingPrice: async/,
        /listing.feeLocks.map\(\(lock\) => requoteMarketplaceListingFeeLock\(lock, params.priceAmount\)\)/,
        /type: "UpdateListingPrice"/,
      ],
      [
        `${listingRuntime}:1762-1868`,
        /applyBulkListingPriceUpdates: async/,
        /assertConfirmedFeeQuote\(update.feeQuoteFingerprint, quote\)/,
        /listing.feeLocks.map\(\(lock\) => requoteMarketplaceListingFeeLock\(lock, update.priceAmount\)\)/,
        /type: "UpdateListingPrice"/,
      ],
      [
        `${feeQuotes}:154-176`,
        /quoteLockedMarketplaceFeeTerms\(feeLock.terms, priceAmount\)/,
        /return \{\s*\.\.\.feeLock,/,
      ],
      [
        `${listingDomain}:700-708`,
        /case "UpdateListingPrice"/,
        /assertFeeLockTranchesPreserved\(state.feeLocks, feeLocks\)/,
      ],
      [
        `${feeLock}:105-134`,
        ...[
          "marketplaceSalesFeePercentageBps",
          "marketplaceSalesFeeFixedAmount",
          "marketplaceSalesFeeCapAmount",
          "shippingAllowancePercentageBps",
          "termsScheduleId",
          "termsAgreementId",
          "termsResolvedAt",
        ].map((field) => new RegExp(`left\\.${field}.*right\\.${field}`)),
        /current.length === requoted.length/,
        /currentLock.unitCount === nextLock.unitCount/,
        /sameMarketplaceListingFeeTerms\(currentLock.terms, nextLock.terms\)/,
      ],
    ],
  ],
  [
    "Photos, pause",
    [
      [
        `${listingTests}:307-333`,
        /type: "AddListingPhotos"/,
        /type: "PauseListing"/,
        /const resumed = decideMarketplaceListing\(paused, publishListingCommand\)/,
        /expect\(state.feeLocks\).toEqual\(draft.feeLocks\)/,
      ],
    ],
  ],
  [
    "Purchase-limit edits",
    [
      [
        `${listingDomain}:749-758`,
        /case "UpdateListingPurchaseLimits"/,
        /return \[\{ type: "marketplace.listing.purchase-limits-updated", data: \{ purchaseLimits \} \}\]/,
      ],
      [
        `${listingDomain}:956-960`,
        /case "marketplace.listing.purchase-limits-updated":\s*return \{\s*\.\.\.state,\s*purchaseLimits: event.data.purchaseLimits,/,
      ],
    ],
  ],
  [
    "Added units",
    [
      [
        `${listingDomain}:728-747`,
        /resizeMarketplaceListingFeeLocks\(state.feeLocks, quantityCap, command.addedUnitsFeeLock\)/,
      ],
      [
        `${feeLock}:142-179`,
        /quantityCap > currentUnitCount/,
        /normalized.unitCount === quantityCap - currentUnitCount/,
        /return \[\.\.\.current, normalized\]/,
        /const latest = resized.pop\(\)/,
      ],
      [
        `${listingRuntime}:1869-1882`,
        /addedUnitCount = Math.max\(0, params.quantityCap - listing.quantityCap\)/,
        /addedUnitCount > 0 \? await quoteListingTerms\(params.accountId, listing.priceAmount\) : null/,
        /assertConfirmedFeeQuote\(params.feeQuoteFingerprint, quote\)/,
        /addedUnitsFeeLock: quote \? feeLockFromMarketplaceTermsQuote\(addedUnitCount, quote\) : null/,
      ],
      ...quoteChain,
    ],
  ],
  [
    "Withdrawal is terminal",
    [
      [`${listingDomain}:896-899`, /case "WithdrawListing"/, /"marketplace.listing.withdrawn"/],
      [
        `${listingTests}:335-365`,
        /Withdrawn listings cannot be published/,
        /Withdrawn listings cannot be updated/,
        /Listing has already been created/,
      ],
      ...creationChain,
      changedSchedule,
    ],
  ],
  [
    "Item or condition",
    [
      [
        `${listingDomain}:483-497`,
        /^export type MarketplaceListingCommand =\s*\| CreateListingCommand\s*\| UpdateListingPriceCommand\s*\| UpdateListingQuantityCapCommand\s*\| UpdateListingPurchaseLimitsCommand\s*\| AddListingPhotosCommand\s*\| ClassifyListingPhotoCommand\s*\| ReplaceListingPhotoCommand\s*\| RemoveListingPhotoCommand\s*\| ReorderListingPhotosCommand\s*\| RefreshListingEvidenceRequirementsCommand\s*\| PublishListingCommand\s*\| PauseListingCommand\s*\| AutoUnlistListingCommand\s*\| WithdrawListingCommand;$/,
      ],
      ...creationChain,
      changedSchedule,
    ],
  ],
  [
    "Current standard schedule",
    [
      [
        "bounded-contexts/commercial-terms/features/marketplace-sales-fee/domain/policy.ts:24-29",
        /marketplaceSalesFeePercentageBps: 500,/,
        /marketplaceSalesFeeFixedAmount: "0.00",/,
        /marketplaceSalesFeeCapAmount: "25.00",/,
      ],
      [
        "bounded-contexts/commercial-terms/support/runtime-support/seed.ts:109-110",
        /await seedMarketplaceSalesFeeScheduleIfMissing/,
      ],
      [
        "bounded-contexts/commercial-terms/support/runtime-support/seed.ts:168-186",
        /async function seedMarketplaceSalesFeeScheduleIfMissing/,
        /value: MARKETPLACE_SALES_FEE_SCHEDULE_LAUNCH_POLICY_VALUE/,
        /status: "active"/,
      ],
      [
        "bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx:20-22",
        /standard.bps": policyValue\("bps", 500\)/,
        /standard.fixed": policyValue\("money", "0.00"/,
        /standard.cap": policyValue\("money", "25.00"/,
      ],
      [
        "bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx:67-97",
        /renders the standard account schedule/,
        /await loader/,
        /5% of the item price plus \$0.00, capped at \$25.00 per item/,
      ],
    ],
  ],
];

function assertCitations(candidate: PublicPolicyArtifact, sourceOverrides: Readonly<Record<string, string>> = {}) {
  const assumptions = candidate.sections.flatMap((section) => section.reviewManifest.assumptions);
  for (const [assertionStart, citations] of citationRules) {
    const matches = assumptions.filter(({ assertion }) => assertion.startsWith(assertionStart));
    expect(matches, assertionStart).toHaveLength(1);
    const refs = matches[0]!.evidenceRef.split("; ");
    expect(refs.toSorted(), `${assertionStart}: clause references`).toEqual(citations.map(([ref]) => ref).toSorted());
    for (const [ref, ...patterns] of citations) {
      const [, path, from, to] = /^(.+):(\d+)-(\d+)$/.exec(ref)!;
      const lines = (sourceOverrides[path!] ?? readSource(path!)).split(/\r?\n/);
      expect(Number(to), ref).toBeLessThanOrEqual(lines.length);
      const slice = lines
        .slice(Number(from) - 1, Number(to))
        .join("\n")
        .trim();
      for (const pattern of patterns) expect(slice, `${assertionStart}: ${ref}`).toMatch(pattern);
    }
  }
}

function replaceEvidence(prefix: string, replace: (value: string) => string): PublicPolicyArtifact {
  return {
    ...artifact,
    sections: artifact.sections.map((section) => ({
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        assumptions: section.reviewManifest.assumptions.map((assumption) =>
          assumption.assertion.startsWith(prefix)
            ? { ...assumption, evidenceRef: replace(assumption.evidenceRef) }
            : assumption,
        ),
      },
    })),
  };
}

describe("founders clause-level source authority", () => {
  it("cites actual owners and current quote-to-lock wiring for every numeric and fee-lock assumption", () => {
    assertCitations(artifact);
  });
  it("rejects blanket fee-lock and unrelated plausible ranges for photos independently", () => {
    for (const ref of [`${feeLock}:105-179`, `${listingTests}:335-365`]) {
      expect(() => assertCitations(replaceEvidence("Photos, pause", () => ref))).toThrow(
        "Photos, pause: clause references",
      );
    }
  });
  it("rejects domain-only current-rate evidence for creation, added units, relisting and recreation", () => {
    for (const prefix of ["Creation locks", "Added units", "Withdrawal is terminal", "Item or condition"]) {
      const mutant = replaceEvidence(prefix, (refs) =>
        refs
          .split("; ")
          .filter((ref) => !ref.startsWith(listingRuntime) && !ref.startsWith(feeQuotes))
          .join("; "),
      );
      expect(() => assertCitations(mutant)).toThrow(`${prefix}: clause references`);
    }
  });
  it("rejects same-shaped stored requotes in place of current quote wiring", () => {
    const real = readSource(listingRuntime);
    const mutant = real
      .replaceAll(
        "await quoteListingTerms(params.accountId, params.priceAmount)",
        "await requoteMarketplaceListingFeeLock(params.accountId, params.priceAmount)",
      )
      .replaceAll(
        "await quoteListingTerms(params.accountId, listing.priceAmount)",
        "await requoteMarketplaceListingFeeLock(params.accountId, listing.priceAmount)",
      );
    expect(mutant).not.toBe(real);
    expect(() => assertCitations(artifact, { [listingRuntime]: mutant })).toThrow("Creation locks:");
  });
  it("rejects each changed canonical schedule value without copying those values into public text", () => {
    const path = "bounded-contexts/commercial-terms/features/marketplace-sales-fee/domain/policy.ts";
    for (const [before, after] of [
      ["PercentageBps: 500", "PercentageBps: 501"],
      ['FixedAmount: "0.00"', 'FixedAmount: "0.01"'],
      ['CapAmount: "25.00"', 'CapAmount: "26.00"'],
    ]) {
      const real = readSource(path);
      const mutant = real.replace(before!, after!);
      expect(mutant).not.toBe(real);
      expect(() => assertCitations(artifact, { [path]: mutant })).toThrow("Current standard schedule:");
    }
  });
  it("preserves all three Pricing callers through the shared client and the real bulk route", () => {
    const callers: Citation[] = [
      [
        "bounded-contexts/pricing/features/repricing-engine/api/runtime.ts:489-491",
        /marketplaceGatewayForAccount\(accountId\).applyBulkListingPriceUpdates\(\{ updates \}\)/,
      ],
      [
        "bounded-contexts/pricing/features/recommendations/api/runtime.ts:619-622",
        /marketplaceListings.applyBulkListingPriceUpdates/,
        /updates: bulkUpdates.map/,
      ],
      [
        "bounded-contexts/pricing/features/bulk-reprice-ingestion/api/runtime.ts:620-621",
        /marketplaceGateway.applyBulkListingPriceUpdates\(\{ updates \}\)/,
      ],
      [
        "bounded-contexts/pricing/support/request-support/marketplace-listings.ts:25-25",
        /applyBulkListingPriceUpdates: \(body, options\) => marketplaceApi.applyBulkListingPriceUpdates\(body, options\)/,
      ],
      [
        "bounded-contexts/marketplace/client.ts:522-536",
        /async applyBulkListingPriceUpdates/,
        /"\/account\/listings\/prices\/bulk"/,
        /method: "POST"/,
      ],
      [
        "bounded-contexts/marketplace/features/listings/api/route.ts:1132-1165",
        /"\/listings\/prices\/bulk"/,
        /services.applyBulkListingPriceUpdates/,
        /updates: parseBulkListingPriceUpdates\(body\)/,
      ],
    ];
    for (const [ref, ...patterns] of callers) {
      const [, path, from, to] = /^(.+):(\d+)-(\d+)$/.exec(ref)!;
      const slice = readSource(path!)
        .split(/\r?\n/)
        .slice(Number(from) - 1, Number(to))
        .join("\n");
      for (const pattern of patterns) expect(slice, ref).toMatch(pattern);
    }
  });
});
