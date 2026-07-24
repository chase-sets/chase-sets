import type { PublicPolicyArtifact } from "./policy-artifact";

const chargeTimingProductTruthRefs = [
  "bounded-contexts/payments/features/payments/api/runtime.ts:1890-1943",
  "infrastructure/stripe-payments/index.ts:1464-1512",
];

export const requiredPaymentsTermsSubjectIds = [
  "processor-pass-through-and-collection-agent-role",
  "charge-timing-and-statement-descriptor",
  "payout-timing-and-clearance",
  "holds-freezes-and-offsets",
  "chargebacks-and-disputes",
  "kyc-and-verification",
  "no-interest",
  "tax-form-delivery",
  "errors-and-unauthorized-transactions",
  "termination-and-residual-obligations",
] as const;

export type PaymentsTermsSubjectId = (typeof requiredPaymentsTermsSubjectIds)[number];

const agreementSpecificGateOpenQuestion =
  "Agreement-specific Stripe Connected Account language — including the selected service agreement type, the " +
  "exact agreement-selection mechanics, and any dashboard, loss, fee, or requirements-allocation claim tied to " +
  "that agreement type — is intentionally withheld pending #5924's written Stripe confirmation and test-mode " +
  "evidence and #5923's counsel review of that evidence. This is a manifest-only drafting note, not a " +
  "placeholder for an unresolved implementation decision in the section above: the section's generic " +
  "Stripe-managed language is already complete and does not depend on this open question's resolution. A " +
  "separate follow-up replaces this note with counsel-reviewed agreement-specific language once the gate " +
  "clears; this artifact does not perform that follow-up.";

const agreementSpecificGateAssumption = {
  assertion:
    "The generic Stripe-managed pass-through, onboarding, and payout language drafted in this section is " +
    "accurate regardless of which service agreement type Stripe ultimately confirms for the Connected Account, " +
    "and does not encode or assume the #5924/#5923 decision.",
  evidenceRef: "bounded-contexts/public-presence/features/policies/domain/payments-terms.test.ts",
};

/**
 * Generic Stripe-managed payment acceptance and pass-through draft. Every
 * section remains counsel-required and non-operative; agreement-specific
 * Stripe language stays fenced behind the evidence gate recorded in the
 * gate open question on the processor-pass-through and payout-timing
 * subjects' review manifests.
 */
export const paymentsTermsPolicyArtifact: PublicPolicyArtifact<"payments-terms", PaymentsTermsSubjectId> = {
  metadata: {
    policyKey: "payments-terms",
    version: "v1",
    locale: "en",
    href: "/payments-terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Payments terms",
  description:
    "This versioned artifact drafts the Chase Sets payments terms in the public policy corpus, describing the " +
    "Marketplace's Stripe-managed payment acceptance and processor pass-through posture in generic terms. " +
    "Nothing in it takes effect, and none of it is binding, before qualified counsel approves the final " +
    "language, launch scope, and external approval reference.",
  sections: [
    {
      id: "processor-pass-through-and-collection-agent-role",
      title: "Processor pass-through and limited collection-agent role",
      draftText:
        "Chase Sets is not a bank and does not itself hold, custody, or transmit the money that moves through " +
        "the Marketplace's payment features. Stripe, our payment processor, provides the infrastructure that " +
        "accepts a buyer's payment method, verifies sellers who want to receive payouts, and moves funds " +
        "toward a seller's payout destination. When you buy something on the Marketplace, Chase Sets acts " +
        "only as a limited collection agent for the seller: the amount you pay is collected on the seller's " +
        "behalf and passed through Stripe's systems toward the seller, net of any amounts Chase Sets is " +
        "authorized to retain under the Terms of Service and this document. If you want to receive payouts as " +
        "a seller, Stripe requires you to review and accept the Connected Account Agreement it presents during " +
        "its own onboarding flow before your account can receive funds.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State that Stripe processes and moves payment funds, that Chase Sets' role is a limited " +
          "collection-agent pass-through, and that Stripe — not Chase Sets — presents and captures the " +
          "Connected Account Agreement, without naming the selected agreement type or its mechanics.",
        decisionRefs: [5685, 5924, 5923],
        productTruthRefs: [
          "infrastructure/stripe-connect/index.ts:879-917 (embedded Account Session onboarding surface)",
          "infrastructure/stripe-connect/index.ts:991-1010 (hosted Account Link onboarding surface)",
          "bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx:63-110",
        ],
        openQuestions: [agreementSpecificGateOpenQuestion],
        assumptions: [
          agreementSpecificGateAssumption,
          {
            assertion:
              "Chase Sets does not submit a platform tos_acceptance attestation on a seller's behalf; Stripe's " +
              "own managed onboarding UI presents and captures the applicable Connected Account Agreement.",
            evidenceRef: "infrastructure/stripe-connect/index.ts:879-917,991-1010",
          },
        ],
      },
    },
    {
      id: "charge-timing-and-statement-descriptor",
      title: "Charge timing and statement descriptor",
      draftText:
        "Stripe charges your selected payment method when you complete a purchase on the Marketplace. From " +
        "that point, the charge follows Stripe's standard card-network authorization and processing path, " +
        "which Chase Sets does not control and this document does not restate. The resulting entry on your " +
        "card or bank statement will carry a transaction descriptor that identifies Chase Sets, Stripe, or " +
        "both, so you can recognize purchases made on the Marketplace. Chase Sets does not control the exact " +
        "descriptor format your card network or financial institution ultimately displays.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe when a charge occurs and that the buyer's statement carries a Chase Sets/Stripe-identifying " +
          "descriptor, without inventing exact descriptor text or processing-time numbers.",
        decisionRefs: [5685],
        productTruthRefs: chargeTimingProductTruthRefs,
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Chase Sets charges the buyer's payment method through Stripe at the time a Marketplace purchase " +
              "completes, and no repository evidence shows a delayed or deferred charge model: the checkout " +
              "handler synchronously requests a Stripe payment session (immediately confirming a PaymentIntent " +
              "for a saved instrument, or creating the Checkout Session the buyer completes as part of the same " +
              "purchase for a new one), carrying the statement descriptor suffix, before the purchase is " +
              "recorded as created.",
            evidenceRef: chargeTimingProductTruthRefs.join("; "),
          },
        ],
        canonicalClaims: [
          {
            claimId: "payment-charge-timing-and-capture",
            productTruthRefs: chargeTimingProductTruthRefs,
          },
        ],
      },
    },
    {
      id: "payout-timing-and-clearance",
      title: "Payout timing and clearance",
      draftText:
        "Once Stripe has cleared your account for payouts and you have a payout destination on file, Chase " +
        "Sets requests payouts to that destination through Stripe's payout systems. Stripe controls the " +
        "mechanics and processing path funds follow after a payout is requested. This document does not state " +
        "a fixed number of days for a payout to clear or become available, because that timing depends on the " +
        "connected-account configuration Stripe confirms for the Marketplace. Your payout-readiness status " +
        "reflects whether your account is cleared, whether Stripe still needs information from you, and " +
        "whether a hold described elsewhere in this document is active.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe payout initiation and Stripe's control over payout mechanics without asserting a numeric " +
          "clearance SLA or the agreement-specific timing that depends on the #5924/#5923 gate.",
        decisionRefs: [5685, 5924, 5923],
        productTruthRefs: [
          "bounded-contexts/settlement/features/payouts/domain/reason-codes.ts",
          "bounded-contexts/settlement/features/payout-readiness/api/runtime.ts:609-634",
        ],
        openQuestions: [agreementSpecificGateOpenQuestion],
        assumptions: [
          agreementSpecificGateAssumption,
          {
            assertion:
              "Chase Sets already models a payout-readiness status distinguishing account clearance, " +
              "outstanding provider requirements, and active holds, without publishing a numeric clearance SLA.",
            evidenceRef: "bounded-contexts/settlement/features/payout-readiness/api/runtime.ts:609-634",
          },
        ],
      },
    },
    {
      id: "holds-freezes-and-offsets",
      title: "Holds, freezes, and offsets",
      draftText:
        "Stripe may place a hold on funds connected to your account, pause your payout capability, or request " +
        "additional verification in connection with risk review, incomplete verification, an open dispute, or " +
        "its own compliance obligations. Chase Sets separately places its own hold on sale proceeds pending " +
        "delivery, risk, support, and aging rules, and reflects that and other payout-unavailable states — " +
        "such as an outstanding provider requirement — in your payout-readiness status. Where the Terms of " +
        "Service authorize it, Chase Sets may also apply, hold, or offset your available Wallet balance " +
        "against amounts you owe Chase Sets. Neither Chase Sets nor Stripe guarantees when a hold or freeze " +
        "will be released.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe Stripe-level processor holds, Chase Sets' own Payout Release Hold, and the Terms of " +
          "Service's existing Wallet setoff authority as three distinct mechanisms, without inventing release " +
          "timing.",
        decisionRefs: [5685],
        productTruthRefs: [
          "bounded-contexts/settlement/features/payouts/domain/reason-codes.ts:3-16",
          "bounded-contexts/settlement/GLOSSARY.md:117-125 (Payout Release Hold)",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Chase Sets already models a Settlement-owned Payout Release Hold distinct from Stripe's own " +
              "processor-level holds, plus a payout-unavailable reason for an outstanding provider requirement, " +
              "without publishing a numeric release SLA.",
            evidenceRef: "bounded-contexts/settlement/GLOSSARY.md:117-125",
          },
        ],
        canonicalClaims: [
          {
            claimId: "payout-release-hold-mechanism",
            productTruthRefs: ["bounded-contexts/settlement/GLOSSARY.md:117-125"],
          },
        ],
      },
    },
    {
      id: "chargebacks-and-disputes",
      title: "Chargebacks and disputes",
      draftText:
        "If a buyer disputes a charge with their card issuer or bank, or opens a dispute through Stripe, " +
        "Stripe manages that chargeback or dispute under its own card-network and processor rules, including " +
        "any evidence submission process. While a dispute is open, Chase Sets may hold the related pending " +
        "sale proceeds so they do not become available to the seller. If the dispute is resolved against the " +
        "seller, Chase Sets records the resulting recovery against the seller's Wallet balance, which can " +
        "create a negative balance if the related funds already left the Wallet. If the dispute is resolved " +
        "in the seller's favor, Chase Sets releases the hold and credits the seller's Wallet balance. Chase " +
        "Sets does not control a card network's or Stripe's dispute decision, evidence deadlines, or " +
        "resolution timing.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the chargeback/dispute path as Stripe- and card-network-owned, and describe Chase Sets' " +
          "own chargeback hold and recovery/release mechanics using the ratified Chargeback Clawback " +
          "vocabulary's effects without naming that internal term, without inventing deadlines.",
        decisionRefs: [5685],
        productTruthRefs: ["bounded-contexts/settlement/GLOSSARY.md:127-135 (Chargeback Clawback)"],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Chase Sets already holds pending sale proceeds during an open dispute, posts an automated " +
              "recovery against the seller's Wallet balance (which may go negative) if the dispute is lost, " +
              "and releases the hold with a matching credit if the dispute is won — a mechanism distinct from " +
              "the operator-directed Wallet Adjustment path, which this section therefore does not name.",
            evidenceRef: "bounded-contexts/settlement/GLOSSARY.md:127-135",
          },
        ],
        canonicalClaims: [
          {
            claimId: "payment-chargeback-recovery-mechanism",
            productTruthRefs: ["bounded-contexts/settlement/GLOSSARY.md:127-135"],
          },
        ],
      },
    },
    {
      id: "kyc-and-verification",
      title: "KYC and verification",
      draftText:
        "Before Stripe activates payout capability for your account, Stripe's onboarding requires identifying, " +
        "business, banking, and tax information that Stripe or applicable law requires to verify who you are " +
        "and to set up a payout destination. Stripe evaluates that information, may ask for more " +
        "documentation, and controls whether and when your account clears for payouts. Chase Sets shows you " +
        "the verification and payout-readiness status Stripe reports for your account so you can track " +
        "outstanding requirements, but Chase Sets does not perform this verification itself and does not " +
        "control Stripe's verification decisions or timing.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe Stripe-owned KYC/verification onboarding and Chase Sets' read-only status display, without " +
          "asserting a verification SLA or which party bears requirement-collection responsibility.",
        decisionRefs: [5685],
        productTruthRefs: [
          "infrastructure/stripe-connect/index.ts:390-425",
          "bounded-contexts/settlement/features/payout-readiness/api/runtime.ts:609-634",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Stripe's onboarding requirement set already groups identity, business, banking, and agreement " +
              "information Stripe requires before payouts activate, and Chase Sets surfaces that state without " +
              "performing the verification itself.",
            evidenceRef: "infrastructure/stripe-connect/index.ts:390-425",
          },
        ],
      },
    },
    {
      id: "no-interest",
      title: "No interest",
      draftText:
        "Chase Sets does not pay you interest on funds connected to your Marketplace payment activity, " +
        "including amounts pending payout. Stripe's own terms, which you accept separately during its " +
        "onboarding, govern whether any interest applies to funds Stripe processes or holds on Chase Sets' " +
        "behalf. Any interest posture for amounts reflected in your Wallet balance is addressed by the Terms " +
        "of Service, not by this document.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State Chase Sets' no-interest position on payment-processing funds and defer any Stripe-side " +
          "interest question to Stripe's own terms, without restating or resolving the sibling Wallet " +
          "interest posture, which the Terms of Service artifact leaves an unresolved open question.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "The Terms of Service's sibling wallet-nature-custody-interest subject already reserves the " +
              "Wallet's own interest posture, so this document limits itself to payment-processing funds " +
              "rather than restating the Wallet's terms.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts",
          },
        ],
      },
    },
    {
      id: "tax-form-delivery",
      title: "Tax-form delivery",
      draftText:
        "Where applicable law requires a tax information return in connection with payments processed through " +
        "the Marketplace, Stripe, as our payment processor, or Chase Sets, where legally required, prepares " +
        "and makes it available using the tax information collected during onboarding. You are responsible " +
        "for keeping that tax information accurate and current, and for your own tax reporting obligations.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State a general, mechanism-agnostic tax-form delivery commitment. No repository evidence proves an " +
          "implemented tax-form generation or delivery mechanism; the implementation/evidence gap is filed " +
          "separately rather than guessed at here.",
        decisionRefs: [6049],
        productTruthRefs: [],
        openQuestions: [
          "Tax-form delivery mechanics (which forms, and how/when Stripe or Chase Sets delivers them) lack " +
            "repository evidence; the implementation/evidence gap is filed at #6049. This gap is unrelated to " +
            "the agreement-type evidence gate tracked on this artifact's processor-pass-through and " +
            "payout-timing sections.",
        ],
        assumptions: [
          {
            assertion:
              "No repository evidence currently proves a tax-form generation or delivery mechanism for Chase " +
              "Sets connected accounts, so this section stays at a general policy-commitment level.",
            evidenceRef: "https://github.com/chase-sets/chase-sets/issues/6049",
          },
        ],
      },
    },
    {
      id: "errors-and-unauthorized-transactions",
      title: "Errors and unauthorized transactions",
      draftText:
        "If you believe a charge, payout, or transfer connected to your Marketplace payment activity is " +
        "unauthorized or was made in error, contact Chase Sets support. Chase Sets may investigate using the " +
        "account and transaction information available to it and correct a confirmed error or unauthorized " +
        "transaction through a Wallet Adjustment, a refund, or a request to Stripe, consistent with the Terms " +
        "of Service. Chase Sets does not control the outcome or timing of an investigation your card network, " +
        "bank, or Stripe conducts on its own.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the error/unauthorized-transaction reporting and correction path using the existing Wallet " +
          "Adjustment reason codes, without inventing an investigation SLA.",
        decisionRefs: [5685],
        productTruthRefs: ["bounded-contexts/settlement/features/wallets/domain/wallet-adjustment.ts:24-35"],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Chase Sets already has Wallet Adjustment reason codes for correcting transaction errors and " +
              "reversing fraud-driven activity.",
            evidenceRef: "bounded-contexts/settlement/features/wallets/domain/wallet-adjustment.ts:24-35",
          },
        ],
      },
    },
    {
      id: "termination-and-residual-obligations",
      title: "Termination and residual obligations",
      draftText:
        "Ending your use of Payments features, closing your account, or Chase Sets suspending your account " +
        "does not erase obligations that arose before that point. Amounts you owe Chase Sets, and any amount " +
        "tied to an open dispute, chargeback, hold, or legal process, continue to apply after termination, and " +
        "Chase Sets may continue to hold, apply, or offset available funds toward those obligations to the " +
        "extent the Terms of Service already authorize. The provisions of this document that by their nature " +
        "should survive termination — including your payment obligations, Chase Sets' processor pass-through " +
        "role, and the dispute-related terms above — continue after your access to Payments features ends.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State standard survival-of-obligations language tied to the Terms of Service's existing suspension, " +
          "closure, and hold posture, without restating the sibling Wallet terms.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "The Terms of Service's sibling suspension-closure-and-holds subject already reserves Wallet " +
              "fund treatment at suspension or closure, so this document limits itself to residual " +
              "Payments-feature obligations rather than restating the Wallet's terms.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts",
          },
        ],
      },
    },
  ],
};
