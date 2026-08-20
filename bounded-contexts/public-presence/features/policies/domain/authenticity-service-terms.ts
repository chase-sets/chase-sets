import type { PublicPolicyArtifact } from "./policy-artifact";

export const requiredAuthenticityServiceTermsSubjectIds = [
  "service-nature",
  "opt-in-and-fee",
  "custody-and-care",
  "verification-outcomes",
  "counterfeit-handling",
  "funds-and-reviews",
  "condition-notes-and-disputes",
  "liability-limits",
  "service-termination",
] as const;

export type AuthenticityServiceTermsSubjectId = (typeof requiredAuthenticityServiceTermsSubjectIds)[number];

/**
 * Counsel review packet draft only: nothing here is operative or
 * consent-activatable while counsel review is pending. Deliberately not
 * launch-required — this document rides in the counsel review packet only
 * and becomes launch-required when the authenticity service ships an opt-in
 * surface.
 */
export const authenticityServiceTermsPolicyArtifact: PublicPolicyArtifact<
  "authenticity-service-terms",
  AuthenticityServiceTermsSubjectId
> = {
  metadata: {
    policyKey: "authenticity-service-terms",
    version: "v1",
    locale: "en",
    href: "/authenticity-terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: false,
  },
  title: "Authenticity service terms",
  description:
    "This versioned artifact drafts the Chase Sets authenticity service terms subject taxonomy for the counsel review packet. It is not effective until qualified counsel approves the final language, launch scope, and external approval reference; nothing in it takes effect. The checkout opt-in and fee described below are live, but the inspection service these terms govern is not yet operative end-to-end.",
  sections: [
    {
      id: "service-nature",
      title: "Nature of the Authenticity Check service",
      draftText:
        "The Chase Sets Authenticity Check is an optional inspection and verification service for eligible orders: an inspector examines the item at the Chase Sets Authenticity Facility and records a passed, failed, or inconclusive verdict. It is not a warranty over the condition or description of any Listing, and it is not a grading service — it does not assign a numeric or letter condition grade. These Authenticity Service Terms govern this optional service; they do not modify or expand Chase Sets' general marketplace Terms of Service disclaimers except through the specific scope stated in this document.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State that the Authenticity Check is an optional inspection/verification service distinct from a warranty or grading service, and that it does not expand the general Terms of Service disclaimers beyond this document's own scope.",
        decisionRefs: [4284],
        productTruthRefs: [
          "bounded-contexts/authenticity/README.md:5-8",
          "bounded-contexts/authenticity/features/cases/domain/domain.ts:282-303",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Authenticity Verdicts are a closed passed/failed/inconclusive set; there is no numeric or letter grading dimension in the shipped verdict model.",
            evidenceRef: "bounded-contexts/authenticity/support/runtime-support/common.ts:18",
          },
        ],
      },
    },
    {
      id: "opt-in-and-fee",
      title: "Buyer opt-in and fee",
      draftText:
        "Chase Sets offers the Authenticity Check as a buyer opt-in at checkout for eligible orders that meet Chase Sets' order-value threshold. If you opt in, Chase Sets charges the fee set out in the live Authenticity Fee Policy (policy key commercial-terms.authenticity-fee), which Chase Sets may revise from time to time; this document does not restate a fee amount, and the amount in effect at the time of your checkout is the amount that applies to your order.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the buyer's checkout opt-in and reference the live authenticity fee policy without restating a fee amount.",
        decisionRefs: [4275],
        productTruthRefs: [
          "bounded-contexts/ordering/features/orders/domain/authenticity-check-fee.ts:41-52",
          "bounded-contexts/commercial-terms/features/authenticity-fee/domain/policy.ts:124-131",
          "bounded-contexts/checkout/features/sessions/domain/domain.ts:696-716",
          "bounded-contexts/ordering/features/orders/domain/authenticity-check-fee.ts:92-118",
        ],
        openQuestions: [
          "Checkout's buyer opt-in and fee quoting (Ordering, #4275) and the Authenticity Case judgment lifecycle described elsewhere in this document (Authenticity) are two separately shipped surfaces; Authenticity's README records no wired integration event connecting them yet (bounded-contexts/authenticity/README.md:39-42), so this document must not describe them as one connected end-to-end service.",
        ],
        assumptions: [
          {
            assertion:
              "The buyer-facing fee is resolved from the commercial-terms.authenticity-fee policy at checkout preview and frozen at order-creation time, not hand-entered.",
            evidenceRef: "bounded-contexts/ordering/features/orders/api/authenticity-fee-policy-resolver.ts:12-23",
          },
          {
            assertion:
              "The buyer opt-in offer is unavailable for purchase-intent checkout, cannot change once orders are created or purchase intent is submitted, and requires a current fee quote fingerprint when selected.",
            evidenceRef: "bounded-contexts/checkout/features/sessions/domain/domain.ts:696-716",
          },
          {
            assertion:
              "The order-value eligibility gate is Ordering's own policy gate, not a checkout.session behavior: Ordering's authenticity-check fee quoting treats an order as eligible only once its order value is at or above the resolved policy's optInThresholdAmount.",
            evidenceRef: "bounded-contexts/ordering/features/orders/domain/authenticity-check-fee.ts:92-118",
          },
        ],
      },
    },
    {
      id: "custody-and-care",
      title: "Custody and care of your item",
      draftText:
        "Chase Sets' custody of your item for purposes of the Authenticity Check begins when the Chase Sets Authenticity Facility confirms receipt of the inbound package, not when a shipping carrier first scans it. Before facility receipt, the item remains in transit under the applicable shipping carrier's terms. The standard of care Chase Sets applies to an item in its custody, and the allocation of loss or damage while an item is in that custody, including whether Chase Sets carries or requires insurance for that exposure, are questions Chase Sets has not yet settled and remain subject to qualified counsel and Todd's review before this document publishes.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State that custody begins at facility receipt confirmation rather than an earlier carrier scan, and flag the care-standard and insurance posture as unresolved.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/authenticity/features/cases/domain/domain.ts:253-264",
          "bounded-contexts/authenticity/GLOSSARY.md:23-27",
        ],
        openQuestions: [
          "The standard of care applied to an item in Chase Sets' custody, and whether Chase Sets carries or requires insurance covering loss or damage during that custody, are not yet supported by any ratified product-truth source and remain explicit counsel/Todd-sensitive packet questions pending resolution before publication.",
        ],
        assumptions: [
          {
            assertion:
              "The 'authenticity.case.received' event, not an earlier carrier tracking scan, is the shipped fact marking facility receipt.",
            evidenceRef: "bounded-contexts/authenticity/features/cases/domain/domain.ts:253-264",
          },
        ],
      },
    },
    {
      id: "verification-outcomes",
      title: "Verification outcomes",
      draftText:
        "An inspector at the Chase Sets Authenticity Facility records one of three verdicts for your item: passed, failed, or inconclusive, each backed by an inspection checklist and at least one evidence photo. A passed verdict proceeds toward delivery to you; a failed or inconclusive verdict proceeds toward return to the seller, unless the counterfeit-handling section below applies. Effects of a verdict beyond the Authenticity Case itself, including any refund, listing action, or risk-and-moderation escalation, are owned by other Chase Sets contexts and are not yet fully wired to every verdict reason; where a specific cross-context effect is not yet shipped, this document does not claim it exists. Whether an inconclusive verdict carries a cost allocation different from a failed verdict is a question Chase Sets has not yet settled and remains subject to qualified counsel and Todd's review before this document publishes.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the shipped passed/failed/inconclusive verdict triad and distinguish it from unshipped cross-context verdict effects; flag inconclusive cost allocation as unresolved.",
        decisionRefs: [4284],
        productTruthRefs: [
          "bounded-contexts/authenticity/support/runtime-support/common.ts:18",
          "bounded-contexts/authenticity/features/cases/domain/domain.ts:282-332",
          "bounded-contexts/authenticity/README.md:56-59",
        ],
        openQuestions: [
          "Verdict reactions such as refunds, risk flags, and moderation escalation are m109 #4278 future design, not shipped Authenticity behavior; bounded-contexts/authenticity/README.md:24-25 records #4278 as not yet owned by Authenticity.",
          "Whether an inconclusive verdict carries a cost allocation distinct from a failed verdict is not yet supported by any ratified product-truth source and remains an explicit counsel/Todd-sensitive packet question pending resolution before publication.",
        ],
        assumptions: [
          {
            assertion:
              "The verdict triad (passed/failed/inconclusive) is closed and evidence-photo-backed today; there is no fourth verdict value.",
            evidenceRef: "bounded-contexts/authenticity/support/runtime-support/common.ts:18",
          },
        ],
      },
    },
    {
      id: "counterfeit-handling",
      title: "Confirmed-counterfeit handling",
      draftText:
        "If the Authenticity Check confirms your item is counterfeit, Chase Sets refunds the buyer and does not return the item to the seller. Chase Sets retains the item pending an authorized disposition; Chase Sets Operations, not Authenticity, holds physical custody and may retain, dispose of, or refer the item to law enforcement only under a later counsel-approved procedure, and this document does not itself authorize any automatic disposal or referral. Today's shipped return path treats every failed or inconclusive case the same way regardless of reason code; a fixed-scope Authenticity change is required before a confirmed-counterfeit verdict is handled differently from an ordinary failed verdict, and this document does not claim that distinction is already built.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Record decision #6428's Option B confirmed-counterfeit disposition verbatim as future design, and flag that today's shipped return path does not yet distinguish counterfeit from other failed reasons.",
        decisionRefs: [6428],
        productTruthRefs: [
          "bounded-contexts/authenticity/features/cases/domain/domain.ts:317-332",
          "bounded-contexts/authenticity/support/runtime-support/common.ts:22-28",
        ],
        openQuestions: [
          "Issue #6428 (resolved 2026-08-02, Option B) establishes the future confirmed-counterfeit disposition described above: refund the buyer, never return a confirmed counterfeit to the seller, and retain it under Chase Sets custody until counsel-approved retention, disposal, or referral rules authorize the next step. The fixed-scope Authenticity follow-up that must distinguish 'counterfeit' from other failed reason codes before this posture can ship is not yet filed against a specific issue number as of this document's drafting and remains future design, not shipped behavior.",
        ],
        assumptions: [
          {
            assertion:
              "'ReturnAuthenticityCase' permits returning any case with a failed or inconclusive status today, without a reason-code-specific carve-out for 'counterfeit'.",
            evidenceRef: "bounded-contexts/authenticity/features/cases/domain/domain.ts:317-322",
          },
        ],
      },
    },
    {
      id: "funds-and-reviews",
      title: "Funds maturation and review eligibility",
      draftText:
        "Only delivery of your item from the Chase Sets Authenticity Facility to you (the second leg of an authenticity-checked shipment) is designed to mature seller payout funds or create your order's review eligibility; the earlier delivery from the seller to the Chase Sets Authenticity Facility (the first leg) is not that fact and never triggers a payout-funds-maturation or review-eligibility effect on its own. This first-leg/second-leg distinction is a governing design invariant for future Authenticity Check behavior. The second-leg, facility-to-buyer delivery step itself is not yet shipped, so this document states the invariant those future systems must honor rather than claiming a two-leg mechanism that already operates today.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the leg-two-only funds-maturation/review-eligibility invariant as governing future design, not a shipped two-leg mechanism.",
        decisionRefs: [4284],
        productTruthRefs: [
          "bounded-contexts/authenticity/GLOSSARY.md:23-27",
          "bounded-contexts/authenticity/README.md:19-21,67-68",
        ],
        openQuestions: [
          "The leg-one (seller-to-facility) 'authenticity.case.received' fact is shipped, but leg-two (facility-to-buyer) delivery, and the Fulfillment/Settlement/Marketplace consumption of it for payout-funds-maturation and review eligibility, are m109 #4276 future design and are not yet shipped; this section states the governing invariant those future contexts must honor, not a present-day two-leg delivery claim.",
        ],
        assumptions: [
          {
            assertion:
              "Authenticity's README explicitly disclaims owning 'the delivered fact that matures payout funds and review eligibility', attributing it instead to a future Fulfillment-emitted fact consumed by Settlement and Marketplace.",
            evidenceRef: "bounded-contexts/authenticity/README.md:19-21",
          },
        ],
      },
    },
    {
      id: "condition-notes-and-disputes",
      title: "Condition notes and disputes",
      draftText:
        "The inspector records inspection checklist results, at least one evidence photo, and any per-line condition notes as part of every verdict. If you have a dispute about your order, including one arising from an Authenticity Check verdict, Chase Sets' Support Request process is the uniform avenue for raising it, the same avenue that applies to every other order dispute under Chase Sets' published Terms; these Authenticity Service Terms do not create a separate dispute mechanism. This document does not claim that inspection notes or evidence photos are already surfaced inside the Support Request evidence flow; that specific integration is not yet built.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe shipped inspection notes/evidence capture and point disputes to the uniform Support Request posture ratified by #5681, without claiming unshipped evidence integration.",
        decisionRefs: [5681],
        productTruthRefs: [
          "bounded-contexts/authenticity/features/cases/domain/domain.ts:282-303,431-436",
          "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:544-569",
        ],
        openQuestions: [
          "Whether Authenticity Case inspection notes and evidence photos are surfaced inside the Support Request dispute evidence flow described in #4282 is not yet shipped; this document states the uniform Support Request dispute avenue only and does not claim that specific evidence integration exists.",
        ],
        assumptions: [
          {
            assertion:
              "Every recorded verdict carries checklist results, at least one evidence photo reference, and optional per-line notes.",
            evidenceRef: "bounded-contexts/authenticity/features/cases/domain/domain.ts:282-303,431-436",
          },
        ],
      },
    },
    {
      id: "liability-limits",
      title: "Liability limits",
      draftText:
        "Chase Sets' liability for the Authenticity Check service is limited to the scope of this document and is subject to the disclaimers and liability limitation stated in the Terms of Service, which already names the Authenticity Check as the sole exception to Chase Sets' general no-warranty-over-Listings posture, limited to the scope stated in these Authenticity Service Terms. This document does not state a separate numeric liability cap for the Authenticity Check service; any cap remains subject to qualified counsel review, consistent with the Terms of Service's own placeholder treatment of its liability-cap floor.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State that Authenticity Check liability limitation is scoped consistently with the Terms of Service's authenticity-check carve-out, without inventing a separate numeric cap.",
        decisionRefs: [],
        productTruthRefs: ["bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:521"],
        openQuestions: [
          "Any numeric liability cap specific to the Authenticity Check service is an unresolved counsel and business decision, consistent with the Terms of Service's own '[LIABILITY-CAP-FLOOR-AMOUNT]' placeholder convention for the same undecided fact; no number is stated here.",
        ],
        assumptions: [
          {
            assertion:
              "The Terms of Service already names the Authenticity Check as the sole exception to its general no-warranty-over-Listings posture, scoped to the Authenticity Service Terms.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:521",
          },
        ],
      },
    },
    {
      id: "service-termination",
      title: "Service availability and termination",
      draftText:
        "The Authenticity Check inspection service these terms govern is not yet fully operative: this document's own publication metadata records it as counsel-review-required, with no effective date and launchRequired left false, because the inspection lifecycle these terms govern -- facility intake, verdict, and facility-to-buyer delivery -- is not yet wired to the checkout opt-in, and no Authenticity Case is opened from an order today. Once the service does launch, Chase Sets expects to describe its ordinary availability, Chase Sets' ability to suspend, modify, or discontinue the service, and what survives such a change, such as an already-opened Authenticity Case, in a future counsel-approved revision of this document. This document does not itself activate, enforce, or make available any Authenticity Check service.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State that the inspection service is not yet wired end-to-end, consistent with this document's own counsel-pending metadata, and reserve future availability/termination/survival language without inventing activation machinery or denying the shipped checkout opt-in.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.ts",
          "bounded-contexts/authenticity/README.md:39-42",
          "bounded-contexts/checkout/features/sessions/ui/checkout-shipping-section.tsx:87-98",
          "bounded-contexts/ordering/features/orders/api/runtime.ts:1290-1307",
        ],
        openQuestions: [
          "Availability, suspension/discontinuation, and survival terms for a fully operative Authenticity Check service are future drafting for when the inspection lifecycle is wired end-to-end from the shipped checkout opt-in, and are not addressed by this counsel-pending, non-effective packet document today.",
        ],
        assumptions: [
          {
            assertion:
              "This artifact's own metadata (publicationStatus: counsel-review-required, effectiveAt: null, launchRequired: false) already proves the document itself is not live or consent-activatable, independent of the shipped checkout opt-in described in opt-in-and-fee.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.ts",
          },
          {
            assertion:
              "Authenticity's README states no order-placed-with-authenticity-plan integration event is wired yet, so no Authenticity Case is opened from an order today, even though the buyer opt-in and fee are shipped in Checkout/Ordering.",
            evidenceRef: "bounded-contexts/authenticity/README.md:39-42",
          },
        ],
      },
    },
  ],
};
