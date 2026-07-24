import {
  evaluatePublicPolicyPublicationReadiness,
  type PublicPolicyArtifact,
  type PublicPolicyPublicationReadiness,
} from "./policy-artifact";

export const requiredSellerAgreementSubjectIds = [
  "seller-eligibility-and-verification",
  "listing-obligations",
  "fulfillment-obligations",
  "fees-and-deductions",
  "payouts-holds-and-reserves",
  "taxes",
  "buyer-data-use-restrictions",
  "off-platform-circumvention",
  "enforcement-and-termination",
  "dispute-resolution",
  "governing-law",
] as const;

export type SellerAgreementSubjectId = (typeof requiredSellerAgreementSubjectIds)[number];

export type SellerAgreementPolicyArtifact = PublicPolicyArtifact<"seller-agreement", SellerAgreementSubjectId>;

export const sellerAgreementPolicyArtifact: SellerAgreementPolicyArtifact = {
  metadata: {
    policyKey: "seller-agreement",
    version: "v1",
    locale: "en",
    href: "/seller-agreement",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Seller agreement",
  description:
    "This versioned artifact defines the subjects the operative Chase Sets seller agreement must cover, in addition to the marketplace-wide Terms of Service. It is not effective until qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "seller-eligibility-and-verification",
      title: "Seller eligibility and verification",
      draftText:
        "To sell on Chase Sets, you must hold an account in good standing and act as, or on behalf of, an authorized member of the selling account. You represent that you are at least eighteen years old (or the age of majority in your jurisdiction) and have the legal capacity to enter into this Agreement, and, if you accept on behalf of a business or organization, that you are authorized to bind that account to its terms.\n\nThis Agreement binds the selling account, not only the individual member who accepts it. An account with more than one authorized member does not need every member to separately accept before the account may sell; acceptance by one authorized owner or admin binds the account, and Chase Sets records which individual accepted on the account's behalf.\n\nBefore an account can receive payout of marketplace proceeds, Chase Sets requires it to complete payout setup, which includes supplying identity and business information through Chase Sets' payment processor. Selling privileges and payout eligibility depend on that information remaining current and on the account's continued compliance with this Agreement and Chase Sets' other policies.\n\nChase Sets reserves the right to verify seller information, to periodically request recertification of a seller's business, tax, and contact information, to suspend or condition selling or payout privileges when required information is missing, inaccurate, or unverifiable, and to make legally required disclosures about high-volume sellers to the extent applicable law requires it. These are platform capabilities Chase Sets may exercise; none of them is a representation that a particular consumer-protection statute governing online marketplaces applies to your account or to Chase Sets, which remains an open question addressed below.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Establish account-scoped acceptance and binding-member authority (#5680); state the seller's age/capacity representation; describe the shipped business-information collection tied to payout setup; and reserve platform verify/recertify/suspend/disclosure rights framed as capabilities, not statutory-obligation claims, consistent with the unsettled INFORM Consumers Act applicability question raised by #5685.",
        decisionRefs: [5680],
        productTruthRefs: [
          "bounded-contexts/settlement/features/payout-readiness/domain/setup-progress.ts:4-15 (payout-setup requirement groups, including identity-and-business)",
          "bounded-contexts/settlement/features/payout-readiness/domain/setup-progress.ts:83,186 (identity-and-business requirement id)",
          "bounded-contexts/identity/features/accounts/domain/domain.ts:53,155-158 (SuspendAccount command; active-only precondition)",
          "bounded-contexts/platform-operations/features/risk-alerts/read-model/projection.ts:113-195,200-283 (partial velocity/threshold signals, per #5685's INFORM findings)",
        ],
        openQuestions: [
          "Whether the INFORM Consumers Act's high-volume new-or-unused-consumer-product threshold applies to Chase Sets' singles-heavy trading card marketplace is unresolved and reserved for counsel (#5685 INFORM track).",
          "Annual recertification (#5903), the $20,000 public-disclosure hook (#5904), and telephonic suspicious-activity intake (#5905) are not yet built; this subject describes them as reserved platform rights, not shipped guarantees, until those gaps close.",
        ],
        assumptions: [
          {
            assertion:
              "Chase Sets does not verify a seller's age or contracting capacity at signup; eligibility rests on the seller's own representation.",
            evidenceRef:
              "bounded-contexts/auth/support/api-support/registration-gates.ts (invitation-admission and disposable-email screening only; no age/capacity check)",
          },
          {
            assertion:
              "Identity and business information is collected through the payment processor's embedded payout onboarding, gating payout eligibility rather than selling or listing eligibility.",
            evidenceRef: "bounded-contexts/settlement/features/payout-readiness/domain/setup-progress.ts:12-15,63-89",
          },
          {
            assertion:
              "An account-level suspend/reactivate capability exists and is available as the mechanism behind any verification-driven suspension.",
            evidenceRef: "bounded-contexts/identity/features/accounts/domain/domain.ts:155-160,242-244",
          },
          {
            assertion:
              "High-volume threshold tracking, bank/TIN verification, annual recertification, the disclosure threshold, and suspicious-activity intake are partial or missing platform hooks tracked as fixed-scope gaps.",
            evidenceRef: "#5901, #5902, #5903, #5904, #5905 (filed from #5685's INFORM findings comment)",
          },
        ],
      },
    },
    {
      id: "listing-obligations",
      title: "Listing obligations",
      draftText:
        "Every listing you publish must describe a specific item you are offering for sale accurately, including its condition, using the condition scale and photo-evidence requirements in Chase Sets' Condition and photo standards help article and the listing composer's active evidence policy. A listing may only be created against an existing Chase Sets catalog entry for the product being sold; Chase Sets does not support free-text or off-catalog listings, and you are responsible for selecting the catalog entry that correctly matches the item.\n\nIf your item is professionally graded, you must list it as a graded item and provide accurate grading-company, grade, and certification details; Chase Sets validates certification numbers against the format published by supported grading companies but does not independently authenticate the card or the grading company's assessment. Listings above the price and evidence thresholds in the active Listing Evidence Policy carry additional photo and seller-trust requirements before they may go live, and the listing composer will not let you publish until those requirements are met.\n\nYou represent that you own or otherwise have the legal right to sell each item you list, that you currently possess it or have immediate access to it, and that you are not listing an item you do not yet have in hand or expect to acquire only after a sale. You are responsible for keeping your listed quantities in step with what you actually hold, and for promptly pausing or withdrawing a listing you can no longer fulfill.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Incorporate condition-standard and Listing Evidence Policy accuracy requirements by reference, state the closed-catalog listing rule, and state a physical-possession/no-drop-shipping representation as a seller warranty rather than a platform-verified control.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/marketplace/features/listing-evidence-policy/domain/policy.ts:478-588 (photo requirements for top raw conditions and graded listings; seller-trust price gating)",
          "bounded-contexts/marketplace/features/listings/domain/listing-evidence-readiness.test.ts (publication blocked until evidence/seller-trust requirements are satisfied)",
          'bounded-contexts/marketplace/features/listings/api/runtime.ts:817,1414,1644 (assert(supply, "Inventory item not found.") — a listing requires an existing catalog-linked inventory row)',
          "bounded-contexts/marketplace/features/listings/api/runtime.ts:1296-1310 (catalog_catalog_item_id persisted per listing)",
          "bounded-contexts/public-presence/features/help/domain/articles/condition-and-photo-standards.en.md",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Listings can only be created against an existing catalog entry; there is no free-text or off-catalog listing path.",
            evidenceRef: "bounded-contexts/marketplace/features/listings/api/runtime.ts:817,1414,1644,1296-1310",
          },
          {
            assertion:
              "Physical possession before listing (no drop-shipping) is not a platform-enforced check today; it is drafted here as a seller representation only.",
            evidenceRef:
              "Repo-wide search found no possession or drop-shipping gate in the marketplace, inventory, or fulfillment domains",
          },
        ],
      },
    },
    {
      id: "fulfillment-obligations",
      title: "Fulfillment obligations",
      draftText:
        "You must ship every order you accept using a Chase Sets-purchased postage label with tracking attached, as described in Chase Sets' Shipping requirements help article; orders cannot be dispatched without a purchased label, and delivery is recorded only from carrier tracking events. Chase Sets measures how quickly you dispatch orders against the platform's published dispatch-window standard as part of your seller standing; meeting it is part of fulfilling your obligations under this Agreement.\n\nIf you cannot fulfill an order you accepted, you must promptly raise a cannot-fulfill case rather than let the order sit unresolved; Chase Sets' Cannot fulfill an order help article describes how that case is handled, including that it defaults to a full buyer refund and reverses your share of the sale proceeds and the order's Order Protection contribution. Repeated cannot-fulfill cases and other fulfillment failures affect your seller standing and the trust signals Chase Sets uses to evaluate your account, and may lead to enforcement under the Enforcement and termination subject below.\n\nYou are responsible for packing and shipping the exact item and condition described in your listing, and must not include pricing or payment information in the package.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the shipped label/tracking requirement, the dispatch-window seller-standing measure, and cannot-fulfill consequences as seller obligations, incorporating the Shipping requirements and Cannot fulfill an order help articles by reference rather than restating their published figures.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/help/domain/articles/shipping-requirements.en.md (label purchase required before dispatch; tracking-driven delivery recording)",
          "bounded-contexts/marketplace/features/seller-metrics/domain/behavioral-metrics-policy.ts:48,57,109 (dispatchWindowHours On-Time Shipment Rate input)",
          "bounded-contexts/marketplace/GLOSSARY.md (On-Time Shipment Rate; Seller Reliability)",
          "bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts and bounded-contexts/platform-operations/features/support-requests/api/runtime.test.ts (urgent cannot-fulfill case routing)",
          "bounded-contexts/public-presence/features/help/domain/articles/cannot-fulfill-an-order.en.md",
        ],
        openQuestions: [
          "There is no separate contractual ship-by deadline distinct from the On-Time Shipment Rate standing measure; if a hard ship-by SLA with its own remedy is added later, this subject will need a fixed-scope revision.",
        ],
        assumptions: [
          {
            assertion:
              "Seller shipping timeliness is measured today as a seller-standing metric (On-Time Shipment Rate against a dispatch window), not as a separate enforced order-level deadline with its own automatic remedy.",
            evidenceRef:
              "bounded-contexts/marketplace/features/seller-metrics/domain/behavioral-metrics-policy.ts:48,57,109",
          },
        ],
      },
    },
    {
      id: "fees-and-deductions",
      title: "Fees and deductions",
      draftText:
        "Chase Sets charges a marketplace sales fee on each completed sale, computed from the rate, fixed amount, and per-item cap published in the current Marketplace Sales Fee Schedule policy document, and shown to you before you confirm a listing. Confirming a listing locks the fee terms then in effect for the units created at that moment, as described in Chase Sets' Marketplace sales and checkout fees help article; a later revision to the published schedule never changes units already locked, and Chase Sets re-audits the locked fee terms, including the per-item cap, before crediting your sale proceeds.\n\nEvery order also carries a seller-funded fulfillment allowance under the Marketplace Sales Fee Schedule. That allowance funds the order's Order Protection contribution first and your shipping cost second, and your payout detail itemizes both. Chase Sets does not charge you a separate listing fee, and buyer-side checkout processing fees, published in the same fee schedule and the Checkout Processing Fee policy document, are never deducted from your proceeds.\n\nChase Sets may offset or recoup amounts you owe it against your current or future Wallet balance under the Wallet Adjustment authority and Setoff subjects of the Terms of Service, which this Agreement incorporates for your selling account without restating them.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the sales-fee, fee-lock, and checkout-fee mechanism by reference to the ratified Commercial Terms fee-schedule policy documents (#4066) and the sales-fees help article, and cross-reference (without restating) the Terms of Service Wallet Adjustment/Setoff subjects for offset and recoupment.",
        decisionRefs: [4066],
        productTruthRefs: [
          "bounded-contexts/commercial-terms/features/marketplace-sales-fee/domain/policy.ts (commercial-terms.marketplace-sales-fee-schedule)",
          "bounded-contexts/commercial-terms/features/checkout-processing-fee/domain/policy.ts (commercial-terms.checkout-processing-fee)",
          "bounded-contexts/marketplace/features/listings/domain/fee-lock.ts:34-52,105-181 (fee-lock snapshot, tranche preservation, resize)",
          "bounded-contexts/public-presence/features/help/domain/articles/sales-fees.en.md",
          "bounded-contexts/settlement/GLOSSARY.md (Wallet Adjustment; Rebate; Chargeback Clawback)",
          "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts (adjustment-authority, setoff subjects — cross-referenced, not restated)",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Fee figures are sourced live from the Marketplace Sales Fee Schedule and Checkout Processing Fee policy documents and must not be restated as prose numbers here.",
            evidenceRef:
              "bounded-contexts/public-presence/features/help/domain/public-policy-value-whitelist.mjs (marketplace-sales-fee.* and checkout-processing-fee.* whitelist entries)",
          },
        ],
      },
    },
    {
      id: "payouts-holds-and-reserves",
      title: "Payouts, holds, and reserves",
      draftText:
        "Sale proceeds and any shipping payout post to your Wallet as pending and become available once delivery is recorded and the applicable clearance window described in Chase Sets' Getting paid help article has passed. Open support requests, fraud reviews, and chargebacks hold the affected order's funds beyond that schedule, and a chargeback hold releases only if the dispute is won, all as described in that help article and in the Order protection help article, which this Agreement incorporates by reference.\n\nYou request payouts of your available balance to the payout destination connected during Chase Sets' payout setup process; payout requests are refused while payout setup is incomplete, while support holds cover the requested funds, while your balance is negative, or when the requested amount is unavailable, and additional identity verification applies for a period after you change your payout destination. These bounds and holds are Settlement's Payout Release Hold and Connected Payout Account mechanisms and are not restated here beyond this reference.\n\nThis Agreement does not restate the Wallet's nature, custody, and interest posture, its adjustment authority, setoff rights, negative-balance and restriction rules, or its suspension, closure, dormant-balance, and legal-hold treatment; those are governed by the corresponding Terms of Service subjects, which apply to your account as a Wallet holder in addition to your obligations as a seller under this Agreement. Chase Sets may retain a reasonable reserve against your Wallet balance following suspension, closure, or termination of your selling privileges to cover pending refunds, chargebacks, and other obligations arising from your sales, released once those obligations are resolved or expire under the applicable Wallet rules.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the shipped clearance/hold/payout-request mechanism by reference to the Getting paid and Order protection help articles and Settlement's Payout Release Hold/Connected Payout Account vocabulary, state a post-termination reserve right, and cross-reference (without restating) the Terms of Service wallet subjects.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/help/domain/articles/getting-paid.en.md",
          "bounded-contexts/public-presence/features/help/domain/articles/order-protection.en.md",
          "bounded-contexts/settlement/features/payouts/api/runtime.ts:1498,1600 (payout requests blocked while readiness is not ready)",
          'bounded-contexts/settlement/features/payouts/api/runtime.test.ts:616 ("blocks payout requests until payout readiness is ready")',
          "bounded-contexts/settlement/GLOSSARY.md (Payout Release Hold; Connected Payout Account; Chargeback Clawback)",
          "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts (wallet-nature-custody-interest, adjustment-authority, setoff, negative-balances-and-restrictions, suspension-closure-and-holds subjects — cross-referenced, not restated)",
        ],
        openQuestions: [
          "A discrete post-termination reserve mechanic distinct from the existing Payout Release Hold and Wallet suspension/closure treatment is not separately shipped; this subject states it as a reserved right pending product confirmation of whether a dedicated reserve feature is needed.",
        ],
        assumptions: [
          {
            assertion:
              "No separate 'post-termination reserve' ledger mechanic exists today distinct from ordinary Payout Release Holds and the Wallet's suspension/closure/dormant-balance treatment.",
            evidenceRef:
              "bounded-contexts/settlement/GLOSSARY.md (Payout Release Hold, Collections); bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts (suspension-closure-and-holds subject, still counsel-required)",
          },
        ],
      },
    },
    {
      id: "taxes",
      title: "Taxes",
      draftText:
        "You are responsible for determining and paying any taxes that apply to your sales on Chase Sets. Where applicable law requires Chase Sets to collect tax information, issue information returns, or act as a marketplace facilitator for sales or transaction taxes, you agree to cooperate, including by supplying accurate taxpayer identification information through Chase Sets' payout setup process. Chase Sets may condition or pause your payout eligibility on receiving and verifying that information, consistent with the payout-readiness requirements described in Chase Sets' payout setup workflow, without altering the Terms of Service's Wallet or payout-hold rules, which continue to apply.\n\nThis Agreement does not determine whether Chase Sets acts as a marketplace facilitator for any particular tax, or state your individual tax obligations; those depend on facts specific to your account, product mix, and jurisdiction and remain your responsibility and, where Chase Sets has a collection or reporting duty, a matter for Chase Sets' own compliance program.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the seller's general tax-cooperation obligation and tie required taxpayer-identification cooperation to the shipped payout-readiness gate, without asserting a marketplace-facilitator position Chase Sets has not adopted.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/settlement/features/payout-readiness/domain/setup-progress.ts:4-15,63-89,186 (identity-and-business/tax-id requirement group)",
          'bounded-contexts/settlement/features/payout-readiness/domain/domain.test.ts:8-16 (missingRequirements includes "tax-id")',
          "bounded-contexts/settlement/features/payouts/api/runtime.ts:1600 (payout blocked while readiness is not ready)",
        ],
        openQuestions: [
          "Chase Sets' marketplace-facilitator tax posture by jurisdiction has not been determined and is reserved for counsel.",
        ],
        assumptions: [
          {
            assertion:
              'Taxpayer-identification collection is an opaque payment-processor-provided requirement ("tax-id") gating payout readiness, not a first-party W-9/TIN capture or verification flow.',
            evidenceRef: "bounded-contexts/settlement/features/payout-readiness/domain/domain.test.ts:8-16",
          },
        ],
      },
    },
    {
      id: "buyer-data-use-restrictions",
      title: "Buyer data use restrictions",
      draftText:
        "Chase Sets gives you the buyer information you need to fulfill an order and nothing more. A buyer's shipping address is verified at checkout and made available to you only as a snapshot on the shipment you are fulfilling; Chase Sets does not keep that address in durable postage records and does not give you an ongoing address book, a buyer contact channel, or any buyer information beyond what an order requires. Packing slips exclude prices and payment details.\n\nYou may use buyer information provided through an order only to fulfill and support that order. You must not use it to contact a buyer for marketing, to solicit a transaction outside Chase Sets, to build your own buyer list, or for any purpose unrelated to that order, and you must not retain, share, or sell it beyond what fulfilling and supporting the order requires.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the shipped, minimized buyer-data surface available to sellers (an order-scoped shipping-address snapshot only, with no messaging or contact channel) and state the corresponding seller use restriction.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/fulfillment/features/shipments/domain/shipment-action.ts (per-shipment address snapshot)",
          "bounded-contexts/public-presence/features/help/domain/articles/shipping-requirements.en.md (addresses sent to the postage provider at purchase time but excluded from durable postage records; packing slips print without prices or payment details)",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "No seller-facing buyer messaging or contact-information surface exists beyond the order-scoped shipping-address snapshot.",
            evidenceRef: "Repo-wide search found no buyer-seller messaging bounded context or route",
          },
        ],
      },
    },
    {
      id: "off-platform-circumvention",
      title: "Off-platform circumvention",
      draftText:
        "You must not use Chase Sets to identify a buyer or a sale opportunity and then complete, or invite a buyer to complete, that transaction outside Chase Sets in order to avoid Chase Sets' fees, buyer protections, or this Agreement. This includes asking a buyer to pay you directly, listing an item on Chase Sets only to direct the buyer to another marketplace or payment method, and any other attempt to route a Chase Sets-originated transaction around the platform.\n\nA transaction completed off Chase Sets in violation of this section is not eligible for Order Protection, Chase Sets' dispute process, or any other Chase Sets buyer or seller safeguard, and this section is enforced under the Enforcement and termination subject below.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State a seller promise not to circumvent the platform for a Chase Sets-originated transaction, framed as a contractual restriction enforced through the general enforcement subject rather than a claim that Chase Sets currently detects circumvention automatically.",
        decisionRefs: [],
        productTruthRefs: [],
        openQuestions: [
          "Chase Sets has no automated off-platform-circumvention detection today; this subject is a contractual restriction enforced through the ordinary enforcement path (reports, support review, account action) rather than a claim of automated detection.",
        ],
        assumptions: [
          {
            assertion:
              "No product surface detects or flags off-platform circumvention attempts; enforcement of this subject relies on reports and manual review like other policy violations.",
            evidenceRef: "Repo-wide search found no off-platform-circumvention detection logic",
          },
        ],
      },
    },
    {
      id: "enforcement-and-termination",
      title: "Enforcement and termination",
      draftText:
        "If you violate this Agreement or another Chase Sets policy, Chase Sets may take graduated action against your listings or your account, including dismissing a report, contacting you, removing or unlisting the affected listing, and suspending or closing your account, depending on the nature and severity of the issue. Chase Sets may also pause your Seller Listing Availability, which hides your active listings from buyers without changing their individual status, and, for repeated fulfillment failures or other standing issues, may otherwise restrict your selling privileges as described elsewhere in this Agreement and the Terms of Service.\n\nA suspended account may be reactivated once the underlying issue is resolved; a closed account's status is final. Suspension or closure does not by itself change your Wallet balance, but continues to be governed by the Terms of Service's suspension, closure, dormant-balance, and legal-hold subject, and by the reserve right described in the Payouts, holds, and reserves subject above.\n\nIf you believe an enforcement action was taken in error, you may contact Chase Sets support to ask for reconsideration. Chase Sets does not yet offer a structured in-product appeal workflow separate from support contact; that gap is tracked for a future release.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the shipped account-suspension/reactivation/closure state machine and the shipped listing-report moderation ladder as platform enforcement capabilities, and state a support-contact reconsideration path while flagging the absence of a structured in-product appeal workflow.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/identity/features/accounts/domain/domain.ts:53,102,104,155-166,242-247 (SuspendAccount/ReactivateAccount/CloseAccount commands and active/suspended/closed state machine)",
          "bounded-contexts/platform-operations/features/reported-content/api/contracts.ts:1-39 (dismiss/contact-seller/unlist/escalate-account-suspension moderation actions)",
          "bounded-contexts/platform-operations/features/reported-content/read-model/projection.ts:141-166 (statusByAction projection)",
          "bounded-contexts/marketplace/GLOSSARY.md (Seller Listing Availability)",
          "bounded-contexts/marketplace/features/reports/domain/domain.ts (auto-unlist on distinct-reporter threshold)",
          'bounded-contexts/marketplace/features/reports/api/runtime.test.ts:134 ("auto-unlists an active listing only when the distinct reporter window threshold is reached")',
        ],
        openQuestions: [
          'No structured in-product seller appeal workflow is shipped; "Reputation Appeal" is explicitly planned, unshipped Marketplace vocabulary. Fixed-scope gap #6048 tracks adding an enforcement-reason code and an appeal workflow.',
        ],
        assumptions: [
          {
            assertion:
              "Account suspension and closure are real, separate, event-sourced states (active/suspended/closed) with no enforcement-reason code captured on the domain event itself.",
            evidenceRef:
              "bounded-contexts/identity/features/accounts/domain/domain.ts:102-104 (AccountSuspendedEvent/AccountClosedEvent use EmptyEventData); gap filed as #6048",
          },
          {
            assertion:
              'The only shipped seller-account escalation reachable from content moderation is a status flag ("suspension-escalated"); no automated end-to-end account-suspension execution from a report was found.',
            evidenceRef:
              "bounded-contexts/platform-operations/features/reported-content/read-model/projection.ts:141-166",
          },
          {
            assertion:
              'No in-product appeal workflow exists; "Reputation Appeal" is listed as planned, not shipped, vocabulary.',
            evidenceRef:
              "bounded-contexts/marketplace/GLOSSARY.md (Planned Reputation And Authenticity — Reputation Appeal)",
          },
        ],
      },
    },
    {
      id: "dispute-resolution",
      title: "Dispute resolution",
      draftText:
        "Before filing a claim, you and Chase Sets agree to try to resolve a dispute informally: the party with a claim gives written notice to the other (to Chase Sets, at the notice address in the Governing law subject below) describing the claim and the resolution sought, and the parties have 45 days from that notice to resolve it informally before either party files an arbitration demand or a small-claims action.\n\nIf a dispute is not resolved informally, you and Chase Sets agree to resolve it by individual, binding arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, rather than in court, except that either party may bring an individual claim in small-claims court instead of arbitration if it qualifies. Chase Sets will pay the AAA and arbitrator fees for an individual claim valued at $10,000 or less. Arbitration is on an individual basis only: you and Chase Sets each waive the right to bring or participate in a class, collective, or representative action, and waive the right to a jury trial. If 25 or more substantially similar arbitration demands are filed by coordinated or commonly represented claimants within a short period, the parties agree to a batch-filing protocol under the AAA's mass-arbitration procedures rather than proceeding as 25 or more simultaneous individual cases.\n\nYou may opt out of this arbitration agreement by sending written notice to the notice address in the Governing law subject below within 30 days of first agreeing to this Seller Agreement. Opting out does not affect any other part of this Agreement.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State #5681's ratified dispute-resolution mechanics (informal-notice precondition, AAA Consumer Arbitration Rules, fee allocation, class-action/jury waiver, mass-filing batch protocol, opt-out window) uniformly with the other legal-corpus documents, per the decision's own instruction to apply it identically everywhere.",
        decisionRefs: [5681],
        productTruthRefs: [],
        openQuestions: [
          "Counsel validates the AAA administrator choice, fee allocation, and mass-filing protocol per #5681's recommendation.",
        ],
        assumptions: [
          {
            assertion:
              "These mechanics are fixed contract terms ratified by the #5681 decision rather than values sourced from a commercial-terms policy document, so they are intentionally exempt from the fee/window prose guard applied to the policy-driven subjects.",
            evidenceRef: "#5681 (decision recorded 2026-07-18: Option A ratified)",
          },
        ],
      },
    },
    {
      id: "governing-law",
      title: "Governing law and dispute forum",
      draftText:
        "This Agreement is between you and [ENTITY], and is governed by the laws of [STATE], without regard to conflict-of-law rules, except that the Dispute resolution subject above governs how disputes are resolved. Any small-claims or court action permitted by that subject must be brought in the state or federal courts located in [STATE].\n\nNotices under this Agreement, including the informal-dispute notice and arbitration opt-out described in the Dispute resolution subject, must be sent in writing to [NOTICE-CONTACT].",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Carry #5677's entity/governing-law/notice-contact markers forward as explicit [ENTITY]/[STATE]/[NOTICE-CONTACT] placeholders pending final counsel-approved substitution, consistent with this issue's explicit placeholder instruction.",
        decisionRefs: [5677],
        productTruthRefs: [],
        openQuestions: [
          "Final [ENTITY]/[STATE]/[NOTICE-CONTACT] substitution awaits counsel-approved final language during the packet review. #5677's decision thread already records directional facts (Chase Sets Limited, registered Wichita, Kansas; notice address in Maize, KS), but this draft intentionally keeps the placeholders per this issue's scope fence.",
          "Initial rollout jurisdictions (#5678: US, all 50 states + DC) are carried in the artifact's rolloutJurisdictionsOrProductLimits metadata field at publication time, not in this subject's prose.",
        ],
        assumptions: [
          {
            assertion:
              "Placeholders are used here even though #5677's decision thread records directional entity/notice facts, because this issue's scope fence explicitly calls for [ENTITY]/[STATE] placeholders in the draft.",
            evidenceRef:
              'Issue #5687 scope fence: "dispute-resolution + governing-law (#5681/#5677 markers, [ENTITY]/[STATE] placeholders)"',
          },
        ],
      },
    },
  ],
};

export function evaluateSellerAgreementPublicationReadiness(
  artifact: SellerAgreementPolicyArtifact,
): PublicPolicyPublicationReadiness {
  return evaluatePublicPolicyPublicationReadiness(artifact, requiredSellerAgreementSubjectIds);
}
