import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredFoundersOfferTermsSubjectIds = [
  "eligibility-and-cap",
  "offer-window-and-fee-lock",
  "what-the-badge-means",
  "changes-and-termination",
  "no-cash-value",
  "relationship-to-tos",
] as const;
export type FoundersOfferTermsSubjectId = (typeof requiredFoundersOfferTermsSubjectIds)[number];

export const foundersOfferTermsSourceTopicMapping = {
  offer: ["eligibility-and-cap", "offer-window-and-fee-lock", "what-the-badge-means"],
  feeLock: ["offer-window-and-fee-lock"],
  buyerEconomics: ["relationship-to-tos"],
  afterWindow: ["offer-window-and-fee-lock"],
  faqForever: ["offer-window-and-fee-lock", "what-the-badge-means"],
  faqSignup: ["eligibility-and-cap", "offer-window-and-fee-lock"],
  faqKeep: ["offer-window-and-fee-lock", "relationship-to-tos"],
} as const satisfies Readonly<Record<string, readonly FoundersOfferTermsSubjectId[]>>;

// Clause-specific references resolve to full repository paths in the review packet.
const listingDomain = "bounded-contexts/marketplace/features/listings/domain/domain.ts";
const listingTests = "bounded-contexts/marketplace/features/listings/domain/domain.test.ts";
const listingRuntime = "bounded-contexts/marketplace/features/listings/api/runtime.ts";
const runtimeTests = "bounded-contexts/marketplace/features/listings/api/runtime.test.ts";
const feeLock = "bounded-contexts/marketplace/features/listings/domain/fee-lock.ts";
const feeQuotes = "bounded-contexts/marketplace/support/runtime-support/fee-quotes.ts";
const currentQuoteEvidence = `${listingRuntime}:958-978; ${feeQuotes}:53-78; ${feeQuotes}:133-152`;
const creationEvidence = `${listingDomain}:380-400; ${listingDomain}:499-525; ${listingDomain}:915-935; ${listingRuntime}:1405-1452; ${currentQuoteEvidence}`;

export const foundersOfferTermsPolicyArtifact: PublicPolicyArtifact<
  "founders-offer-terms",
  FoundersOfferTermsSubjectId
> = {
  metadata: {
    policyKey: "founders-offer-terms",
    version: "v1",
    locale: "en",
    href: "/founders",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Founders offer terms",
  description:
    "The founders offer in plain language: eligibility, the fee window, listing fee locks, and the numbered badge. This draft awaits qualified counsel review before it takes effect.",
  sections: [
    {
      id: "eligibility-and-cap",
      title: "Eligibility and the founder cap",
      draftText:
        "The first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed. An invite alone does not claim a Founder Number. Once an account has beta access, its first listing or offer claims a number in activation order, while numbers remain available. The cap applies to claimed Founder Numbers, not invitations or the number of accounts whose beta access opens a fee window.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Preserve access eligibility, activation-ordered numbering and the cap without implying current cohort activity.",
        decisionRefs: [4068, 5579, 6798],
        productTruthRefs: [
          "bounded-contexts/identity/features/founders-cohort/domain/domain.ts:5-59",
          "bounded-contexts/identity/features/founders-cohort/api/runtime.ts:48-83",
          "bounded-contexts/identity/features/founders-cohort/integrations/marketplace/founder-claim-reaction.ts:22-47",
        ],
        openQuestions: ["Counsel must review the final eligibility language and applicable launch scope."],
        assumptions: [
          {
            assertion: "The cap is 500 claimed Founder Numbers, assigned once per account in activation order.",
            evidenceRef: "bounded-contexts/identity/features/founders-cohort/domain/domain.ts:5-59",
          },
          {
            assertion:
              "A founders window is required for a claim; listing-created and offer-submitted are the current qualifying events.",
            evidenceRef:
              "bounded-contexts/identity/features/founders-cohort/api/runtime.ts:48-83; bounded-contexts/identity/features/founders-cohort/integrations/marketplace/founder-claim-reaction.ts:22-47",
          },
        ],
      },
    },
    {
      id: "offer-window-and-fee-lock",
      title: "The offer window and listing fee locks",
      draftText:
        "Beta access opens a 60-day 0% seller-fee window — every listing you create in that window locks 0% until it sells. The window starts at beta access, independently of badge claim, includes its start and excludes its end. Each listing locks its fee when you create it for the initial listed units. Editing price, including bulk price edits, photos or purchase limits, and pausing or resuming a listing keep its fee lock. Added quantity takes current terms only for the added units. Decreasing quantity retires the newest units first; adding them back takes current terms. Withdrawal is terminal: relisting or recreating requires a new listing at current terms. Substituting the item or condition also requires a new listing at current terms. Listings you locked at 0% keep that rate until they sell. After the window, new listings and added units take the current terms described at /sales-fees. The 0% offer concerns seller fees; shipping allowance, processing and Order Protection are described at /payments-terms and /sales-fees.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Preserve the ratified fee promise and all seven migrated fee-lock clauses. Storage behavior does not decide hypothetical program termination rights.",
        decisionRefs: [4068, 6798, 7101],
        productTruthRefs: [
          "docs/campaigns/offer-economics-claims-substantiation.md:30-46",
          "bounded-contexts/identity/api.ts:815-827",
          `${listingRuntime}:1746-1882`,
          `${feeLock}:105-179`,
        ],
        openQuestions: [
          "Counsel must review the operative fee-lock wording; storage invariants do not establish a right to terminate or forfeit the offer.",
        ],
        assumptions: [
          {
            assertion: "Beta access starts the 60-day window independently of badge claim.",
            evidenceRef: "bounded-contexts/identity/api.ts:815-827; bounded-contexts/identity/GLOSSARY.md:108-120",
          },
          {
            assertion:
              "The founders agreement supplies zero percentage and zero fixed seller fees during a start-inclusive, end-exclusive window, failing closed until ready.",
            evidenceRef:
              "bounded-contexts/commercial-terms/features/agreements/integrations/identity/founders-window-reaction.ts:22-35; bounded-contexts/commercial-terms/features/resolutions/read-model/resolve.ts:304-354",
          },
          { assertion: "Creation locks current quoted terms for the initial units.", evidenceRef: creationEvidence },
          {
            assertion:
              "Single and bulk price edits preserve all seven stored term fields, tranche count and unit counts.",
            evidenceRef: `${listingRuntime}:1746-1761; ${listingRuntime}:1762-1868; ${feeQuotes}:154-176; ${listingDomain}:700-708; ${feeLock}:105-134`,
          },
          {
            assertion: "Photos, pause and resume preserve existing fee locks.",
            evidenceRef: `${listingTests}:307-333`,
          },
          {
            assertion:
              "Purchase-limit edits change only purchase limits; this is structural evidence, not a dedicated behavioral test.",
            evidenceRef: `${listingDomain}:749-758; ${listingDomain}:956-960`,
          },
          {
            assertion:
              "Added units use a fresh current quote; reductions retire newest units and re-added units need current terms.",
            evidenceRef: `${listingDomain}:728-747; ${feeLock}:142-179; ${listingRuntime}:1869-1882; ${currentQuoteEvidence}`,
          },
          {
            assertion: "Withdrawal is terminal; relisting creates a new identity with current quoted terms.",
            evidenceRef: `${listingDomain}:896-899; ${listingTests}:335-365; ${creationEvidence}; ${runtimeTests}:940-1070`,
          },
          {
            assertion:
              "Item or condition substitution requires recreation; the closed command union is structural evidence, and new listings use current quoted terms.",
            evidenceRef: `${listingDomain}:483-497; ${creationEvidence}; ${runtimeTests}:940-1070`,
          },
          {
            assertion:
              "Current standard schedule values belong to Commercial Terms policy, seed and public route, not historical campaign schedule prose.",
            evidenceRef:
              "bounded-contexts/commercial-terms/features/marketplace-sales-fee/domain/policy.ts:24-29; bounded-contexts/commercial-terms/support/runtime-support/seed.ts:109-110; bounded-contexts/commercial-terms/support/runtime-support/seed.ts:168-186; bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx:20-22; bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx:67-97",
          },
        ],
      },
    },
    {
      id: "what-the-badge-means",
      title: "What the founder badge means",
      draftText:
        "Your Founder Number identifies your place in activation order. Your numbered founder badge is publicly displayed. The badge and the fee window are distinct: beta access starts the window whether or not you have claimed a badge.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote: "Describe numbered public display without promising badge or display irrevocability.",
        decisionRefs: [4887, 5579, 6793],
        productTruthRefs: ["docs/campaigns/offer-economics-claims-substantiation.md:40-46"],
        openQuestions: [
          "Counsel must review the distinction between public badge display and stored fee-lock durability.",
        ],
        assumptions: [
          {
            assertion: "Ratification covers public numbered badge display, not a permanence guarantee.",
            evidenceRef: "docs/campaigns/offer-economics-claims-substantiation.md:40-46",
          },
        ],
      },
    },
    {
      id: "changes-and-termination",
      title: "Changes and termination — counsel review scope",
      draftText:
        "Terms for changes to or termination of the founders offer await counsel review and have not been ratified. This draft does not establish a right to change, terminate or forfeit the offer. The listing fee-lock behavior described above does not decide those legal questions.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "New counsel-gated coverage with no predecessor topic. Review changes and termination without deriving legal powers from storage behavior.",
        decisionRefs: [5692, 6798],
        productTruthRefs: [`${feeLock}:120-134`],
        openQuestions: [
          "What changes or termination terms, if any, should counsel approve, including treatment of existing locks and any notice obligations?",
        ],
        assumptions: [
          {
            assertion:
              "Fee-lock preservation supplies product scope only; it does not answer the unresolved legal power or notice questions.",
            evidenceRef: `${feeLock}:120-134`,
          },
        ],
      },
    },
    {
      id: "no-cash-value",
      title: "Cash-value characterization — counsel review scope",
      draftText:
        "The legal characterization of the founders offer, including whether it has cash value, awaits counsel review and has not been ratified. Wallet balance and Marketplace Credit are addressed separately in the Cash-equivalent balance and Marketplace Credit subject of the Terms of Service at /terms; that subject does not settle the founders offer's characterization.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "New counsel-gated coverage with no predecessor topic. Refer to the existing Terms subject without inventing a second Wallet status or settling founders cash value.",
        decisionRefs: [5692, 5004],
        productTruthRefs: ["bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:122-138"],
        openQuestions: [
          "How should counsel characterize the founders offer's cash value, redemption and transferability, without conflating it with Wallet funds or Marketplace Credit?",
        ],
        assumptions: [
          {
            assertion:
              "The existing Terms cash-equivalent-and-marketplace-credit subject owns Wallet scope, not a settled founders-offer characterization.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:122-138",
          },
        ],
      },
    },
    {
      id: "relationship-to-tos",
      title: "Relationship to other terms",
      draftText:
        "Read this founders offer draft with the Terms of Service at /terms and the Seller Agreement at /seller-agreement. The current seller fee schedule is at /sales-fees. For buyer checkout charges, processing, shipping allowance, Order Protection and payout treatment, see /payments-terms and /sales-fees. A 0% seller fee does not remove those separate charges or change those terms.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Cross-reference the existing owners of general terms and buyer economics instead of copying changing fee figures.",
        decisionRefs: [5692, 6798],
        productTruthRefs: [
          "contracts/public-docs/policy-corpus.ts:20-28",
          "bounded-contexts/public-presence/features/policies/domain/seller-agreement.ts:151-175",
          "bounded-contexts/commercial-terms/features/agreements/integrations/identity/founders-window-reaction.ts:22-35",
        ],
        openQuestions: ["Counsel must confirm incorporation and precedence across the reviewed legal documents."],
        assumptions: [
          {
            assertion:
              "General terms, seller obligations and payment treatment remain owned by their existing policy documents.",
            evidenceRef: "contracts/public-docs/policy-corpus.ts:20-28",
          },
          {
            assertion:
              "The founders seller-fee agreement retains shipping allowance; separate checkout charges and Order Protection remain described by their existing terms.",
            evidenceRef:
              "bounded-contexts/commercial-terms/features/agreements/integrations/identity/founders-window-reaction.ts:22-35; bounded-contexts/public-presence/features/policies/domain/seller-agreement.ts:151-175",
          },
        ],
      },
    },
  ],
};
