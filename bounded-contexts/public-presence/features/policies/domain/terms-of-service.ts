import {
  evaluatePublicPolicyPublicationReadiness,
  type PublicPolicyArtifact,
  type PublicPolicyPublicationReadiness,
} from "./policy-artifact";

const walletInterestUnresolvedCanonicalClaims = [
  { claimId: "wallet-no-interest", productTruthRefs: [] },
  { claimId: "wallet-deposit-and-fdic-posture", productTruthRefs: [] },
] as const;

// The public counterpart of walletInterestUnresolvedCanonicalClaims: renders
// each claim's canonical-registry disclosure text structurally instead of
// asserting the unresolved interest/deposit-insurance posture as free-form
// draftText prose.
const walletInterestClaimDisclosures = [
  { claimId: "wallet-deposit-and-fdic-posture" },
  { claimId: "wallet-no-interest" },
] as const;

// The authorized-agent responsibility boundary reaches two Terms subjects at
// once: the agent subject that describes the authorization, and the account
// subject whose activity-responsibility clause composes with it. Both carry
// the SAME canonical claim id, so the corpus states one status and one
// provenance for the boundary rather than two sections drifting apart.
const agentResponsibilityBoundaryClaimId = "authorized-agent-principal-responsibility-and-liability-boundary";
const agentAccessAndAccountSanctionBoundaryClaimId = "agent-access-and-agent-caused-account-sanction-boundary";

const agentBoundaryUnresolvedCanonicalClaims = [
  { claimId: agentResponsibilityBoundaryClaimId, productTruthRefs: [] },
  { claimId: agentAccessAndAccountSanctionBoundaryClaimId, productTruthRefs: [] },
] as const;

const agentBoundaryClaimDisclosures = [
  { claimId: agentResponsibilityBoundaryClaimId },
  { claimId: agentAccessAndAccountSanctionBoundaryClaimId },
] as const;

const accountActivityResponsibilityCanonicalClaims = [
  { claimId: agentResponsibilityBoundaryClaimId, productTruthRefs: [] },
] as const;

const accountActivityResponsibilityClaimDisclosures = [{ claimId: agentResponsibilityBoundaryClaimId }] as const;

export const requiredTermsOfServiceSubjectIds = [
  // Wallet and balance subjects (ADR 0020). Taxonomy and order preserved unchanged.
  "wallet-nature-custody-interest",
  "cash-equivalent-and-marketplace-credit",
  "adjustment-authority",
  "provisional-credits-and-reversals",
  "setoff",
  "negative-balances-and-restrictions",
  "history-notice-and-disputes",
  "suspension-closure-and-holds",
  "effective-date-notice-and-acceptance",
  "evidence-and-fair-use",
  // Marketplace taxonomy additions.
  "marketplace-role-and-limited-payments-agent",
  "eligibility-and-accounts",
  "listings-offers-and-contract-formation",
  "conduct-and-policy-incorporation",
  "user-content-license",
  "electronic-agents-and-automated-access",
  "electronic-communications-and-esign",
  "disclaimers-and-liability-limits",
  "user-vs-user-dispute-release",
  "dispute-resolution-with-platform",
  "governing-law-and-forum",
  "changes-notice-and-acceptance",
] as const;

export type TermsOfServiceSubjectId = (typeof requiredTermsOfServiceSubjectIds)[number];

export type TermsOfServicePolicyArtifact = PublicPolicyArtifact<"terms-of-service", TermsOfServiceSubjectId>;

export const termsOfServicePolicyArtifact: TermsOfServicePolicyArtifact = {
  metadata: {
    policyKey: "terms-of-service",
    version: "v1",
    locale: "en",
    href: "/terms",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Terms of service",
  description:
    "This versioned artifact defines the subjects the operative Chase Sets terms must cover. It is not effective until qualified counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "wallet-nature-custody-interest",
      title: "Wallet nature, custody, and interest",
      draftText:
        "The Chase Sets Wallet is a marketplace ledger account that Settlement maintains to record what Chase Sets owes to, or is owed by, your Account. It is not a bank account, and Chase Sets is not a bank. Chase Sets holds funds corresponding to Wallet balances as an operational matter of running the marketplace, not as a custodian acting on instructions outside the marketplace uses described in these Terms.",
      reviewStatus: "counsel-required",
      claimDisclosures: walletInterestClaimDisclosures,
      reviewManifest: {
        scopeNote:
          "State that the Wallet is a marketplace ledger rather than a bank deposit, and define the reviewed custody and interest posture.",
        decisionRefs: [5004],
        productTruthRefs: [
          "bounded-contexts/settlement/GLOSSARY.md:5-7",
          "bounded-contexts/settlement/features/wallets/domain/domain.ts",
        ],
        openQuestions: [
          "Regulatory classification (money transmission, stored value, prepaid access) requires qualified counsel review per #5004/#4995 before publication; ADR 0020 is ratified product truth, not a counsel opinion.",
          "The draft's no-interest, non-deposit, and FDIC-noninsurance representations are not yet supported by any ratified product-truth source: ADR 0020 and the Settlement glossary define the Wallet as a marketplace-ledger balance container but say nothing about interest, deposit-insurer status, or banking-regulatory posture. This remains an explicit open question pending qualified counsel confirmation before publication, not a productTruthRef-backed fact.",
        ],
        assumptions: [
          {
            assertion:
              "The Wallet is defined in Settlement's ratified vocabulary as a marketplace-ledger balance container, not a separately modeled bank deposit product.",
            evidenceRef: "bounded-contexts/settlement/GLOSSARY.md:5-7",
          },
        ],
        canonicalClaims: walletInterestUnresolvedCanonicalClaims,
      },
    },
    {
      id: "cash-equivalent-and-marketplace-credit",
      title: "Cash-equivalent balance and Marketplace Credit",
      draftText:
        "Amounts credited to your Wallet as ordinary available balance are cash-equivalent: spendable toward marketplace purchases and eligible for payout under the same readiness and clearance rules that apply to any other available balance. Chase Sets does not currently offer Marketplace Credit, a separate, non-withdrawable, promotional or prepaid form of value. If Chase Sets introduces Marketplace Credit in the future, it will be governed by its own terms, will never be summed into your spendable, payoutable Wallet balance, and will be clearly labeled as distinct from cash-equivalent Wallet funds.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Distinguish cash-equivalent Wallet funds, which are spendable and payoutable under normal readiness rules, from any future non-withdrawable Marketplace Credit.",
        decisionRefs: [5004],
        productTruthRefs: ["docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:25,27-35"],
        openQuestions: [],
        assumptions: [
          {
            assertion: "Marketplace Credit is not yet built; only cash-equivalent Wallet balance exists today.",
            evidenceRef: "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:29",
          },
        ],
      },
    },
    {
      id: "adjustment-authority",
      title: "Wallet Adjustment authority",
      draftText:
        "Chase Sets may credit or debit your Wallet outside the ordinary course of a purchase or sale, called a Wallet Adjustment, for reasons that include: correcting a mis-posted ledger entry; correcting the wallet-side consequence of a payment refund; correcting a previously posted fee or fee-related credit; resolving a payment processor dispute; recovering confirmed fraud losses; resolving a support case within Chase Sets' published remedy authority; complying with a court order, regulator directive, or other legal mandate; extending a discretionary goodwill credit; and correcting Chase Sets' own operational errors. Every Wallet Adjustment is requested by one authorized Chase Sets operator and approved by a different authorized operator, who may never approve a request they submitted themselves, and is posted as a single, permanent Wallet ledger entry.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Authorize evidence-backed credits and debits for transaction, refund, fee, dispute, fraud, support, legal, goodwill, and operational-error reasons.",
        decisionRefs: [5004],
        productTruthRefs: [
          "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:41-58,60-68",
          "bounded-contexts/settlement/GLOSSARY.md:148",
        ],
        openQuestions: [
          "The typed request/approve/reject/reverse lifecycle (#4998), platform-admin permissions (#5000), and the wallet-adjustment-controls policy document are implementation work still in progress; this clause states the ratified authority rather than claiming every control surface is already live.",
        ],
        assumptions: [
          {
            assertion: "Wallet Adjustment reason codes are a closed, ADR-ratified taxonomy of ten values.",
            evidenceRef: "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:41-56",
          },
          {
            assertion:
              "Self-approval is never permitted; a second, different authorized operator approves every request.",
            evidenceRef: "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:65-66",
          },
        ],
      },
    },
    {
      id: "provisional-credits-and-reversals",
      title: "Provisional credits, corrections, and linked reversals",
      draftText:
        "A Wallet Adjustment is never edited or deleted once posted. If Chase Sets later determines that a posted Wallet Adjustment was issued in error, in the wrong amount, or as a duplicate, Chase Sets corrects it by posting a new, linked Wallet Adjustment in the opposite direction, never by altering the original entry, so both the original and the correction remain visible in your Wallet history. A credit issued to you may later be corrected this way if it is found to have been posted in error.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe provisional credits, duplicate or error correction, immutable posted adjustments, and new linked opposite-direction reversals.",
        decisionRefs: [5004],
        productTruthRefs: ["docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:37-39,67-69"],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Corrections are always a new linked opposite-direction entry, never an edit or deletion of the original.",
            evidenceRef: "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:39",
          },
        ],
      },
    },
    {
      id: "setoff",
      title: "Setoff",
      draftText:
        "Where your Wallet has a Negative Balance, Chase Sets applies new sale proceeds, shipping allowances, and available adjustment credits to that Negative Balance before any remainder becomes eligible for payout or further spending. Chase Sets may similarly apply amounts it owes you, including future sale proceeds, refunds, and payouts, against amounts you owe Chase Sets under these Terms, to the extent the law allows, before releasing the remaining balance to you.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define lawful setoff against available balance, future proceeds, refunds, or payouts, including required limits and notice.",
        decisionRefs: [5004],
        productTruthRefs: [
          "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:25",
          "bounded-contexts/settlement/GLOSSARY.md:160",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Sale proceeds, shipping allowances, and adjustment credits offset a Negative Balance before normal payout release.",
            evidenceRef: "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:25",
          },
        ],
      },
    },
    {
      id: "negative-balances-and-restrictions",
      title: "Negative balances and capability restrictions",
      draftText:
        "Your Wallet can carry a Negative Balance when chargeback, refund, or payout-recovery obligations exceed your available balance. Creating or increasing a Negative Balance, and any Wallet Adjustment that would benefit the requesting or approving operator's own account or an account under their common control, always requires separation-of-duties approval beyond the ordinary single-approver path; self-benefiting adjustments are blocked outright, with no override. While your Account remains in Negative Balance at or beyond Chase Sets' configured threshold and grace period, Chase Sets may pause new listings and payout requests until the balance is restored to good standing.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe negative-balance creation and recovery, how later funds offset an amount owed, and when marketplace or payout capabilities may be restricted.",
        decisionRefs: [5004],
        productTruthRefs: [
          "bounded-contexts/settlement/GLOSSARY.md:149,152-170",
          "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:70-82",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Collections pauses new listings (Marketplace Seller Listing Availability, operations reason) and payout requests until the Wallet returns to in-good-standing.",
            evidenceRef: "bounded-contexts/settlement/GLOSSARY.md:162-170",
          },
        ],
      },
    },
    {
      id: "history-notice-and-disputes",
      title: "Itemized history, notice, and disputes",
      draftText:
        "Every Wallet Adjustment and other Wallet ledger entry is recorded permanently and is available to you in your Account's money summary. If you believe a Wallet entry is incorrect, you may raise it as a Support Request; Chase Sets investigates, responds, and records the resolution, and may correct the entry with a new, linked Wallet Adjustment where warranted. Chase Sets' published Help Center describes current response-time practice for order- and payment-related Support Requests.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Explain itemized Wallet history and notices, the support dispute method, response expectations, and review timing.",
        decisionRefs: [5004],
        productTruthRefs: [
          "bounded-contexts/settlement/routes/marketplace/account-desk-money.tsx:63-73,157",
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:5-79",
        ],
        openQuestions: [
          "Response-time practice is published operational copy in the Help Center rather than a contractual SLA; confirm the Help Center article this subject should point to before publication.",
        ],
        assumptions: [
          {
            assertion: "Account holders can view itemized Wallet ledger entries in the account money summary.",
            evidenceRef: "bounded-contexts/settlement/routes/marketplace/account-desk-money.tsx:63-73,157",
          },
        ],
      },
    },
    {
      id: "suspension-closure-and-holds",
      title: "Suspension, closure, dormant balances, and legal holds",
      draftText:
        "Chase Sets may suspend or close your Account under these Terms and the policies that govern Account status. While your Account is suspended or closed, or while your Wallet is in Collections for a Negative Balance at or beyond Chase Sets' configured threshold, Chase Sets may pause new listings and payout requests, and may hold Wallet funds to the extent needed to satisfy obligations you owe under these Terms, a legal process, or an active dispute. Chase Sets releases remaining Wallet funds once the restriction giving rise to the hold is resolved, subject to any legal process directing otherwise.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define the treatment of Wallet funds during account suspension or closure, dormancy, legal holds, and lawful release of remaining funds.",
        decisionRefs: [5004],
        productTruthRefs: [
          "bounded-contexts/identity/features/accounts/domain/domain.ts:21,75-85,186-218,301-306 (AccountStatus and account enforcement commands/lifecycle)",
          "bounded-contexts/settlement/GLOSSARY.md:162-170",
        ],
        openQuestions: [
          "A dedicated dormant-balance lifecycle and a formal legal-hold workflow distinct from ordinary Collections/account suspension were not found in the current codebase; this clause states Chase Sets' reserved authority rather than describing a shipped self-service dormancy or hold feature. Consider a fixed-scope product issue if dedicated dormancy/legal-hold surfaces are needed before launch.",
        ],
        assumptions: [
          {
            assertion:
              "Identity Account status supports active/suspended/closed; there is no separate dormant-balance or legal-hold state machine today.",
            evidenceRef:
              "bounded-contexts/identity/features/accounts/domain/domain.ts:34-42,133-135,301-306 (Account enforcement latest/open state and lifecycle events)",
          },
        ],
      },
    },
    {
      id: "effective-date-notice-and-acceptance",
      title: "Effective date, change notice, and acceptance",
      draftText:
        "This Wallet Adjustment authority takes effect on the version's effective date recorded in this artifact's publication metadata. Chase Sets describes any material change to this Wallet Adjustment authority in a future version of these Terms and requires renewed acceptance under the changes-notice-and-acceptance subject below before the change applies to your Account.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define the effective date, material-change notice, version acceptance, and any counsel-approved continued-use semantics.",
        decisionRefs: [5004],
        productTruthRefs: [
          "bounded-contexts/identity/features/consents/domain/terms-of-service-policy.ts:28-59",
          "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:12-13",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Wallet Adjustment authority is published as part of the single versioned Terms of Service artifact, not a separately versioned document.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts",
          },
        ],
      },
    },
    {
      id: "evidence-and-fair-use",
      title: "Evidence-backed and fair use",
      draftText:
        "Chase Sets bases every Wallet Adjustment on the reason code, explanation, and evidence recorded at the time of the request, and requires a mandatory written explanation for any adjustment that does not fit a more specific reason code. Wallet Adjustments are a governed correction mechanism, not a discretionary source of forfeiture: Chase Sets does not debit your Wallet to punish you or to seize funds without a stated, evidence-backed reason connected to the categories described in the Wallet Adjustment authority subject above.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Constrain Wallet Adjustments to fair, supportable uses and state that arbitrary forfeiture is not permitted.",
        decisionRefs: [5004],
        productTruthRefs: ["docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:56"],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "Only the catch-all reason code requires mandatory free-text detail; every other reason code may carry optional detail but must not depend on it for its meaning.",
            evidenceRef: "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:56",
          },
        ],
      },
    },
    {
      id: "marketplace-role-and-limited-payments-agent",
      title: "Marketplace role and limited payments agent",
      draftText:
        "Chase Sets operates an online marketplace that connects buyers and sellers of trading cards and related collectibles. When you sell through Chase Sets, you, not Chase Sets, are the seller of the item, responsible for its description, condition, and lawful sale; when you buy through Chase Sets, your contract for the item is with the seller, not with Chase Sets, apart from the marketplace, payment-collection, and platform services Chase Sets itself provides under these Terms. Chase Sets processes buyer payments through its payment processor and initially collects those funds on Chase Sets' own platform account. Chase Sets then remits the seller's net proceeds, after the fees described in the Marketplace Sales Fee Schedule and the Marketplace Checkout Fee, to the seller's connected payout account once the seller requests and qualifies for payout under Chase Sets' payout-readiness rules. In this capacity, Chase Sets acts as the seller's limited payments collection agent for the sole purpose of collecting and remitting sale proceeds, and Chase Sets' acceptance of a buyer's payment satisfies the buyer's payment obligation to the seller for that order.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe Chase Sets' marketplace-operator role, that sellers and buyers contract with each other, and Chase Sets' limited-payments-agent function in collecting and remitting sale proceeds.",
        decisionRefs: [],
        productTruthRefs: [
          "infrastructure/stripe-payments/index.ts:1464-1494",
          "infrastructure/stripe-connect/index.ts:1039-1094",
          "docs/adr/0006-stripe-connect-custom-account-experience.md:15,51-56",
          "docs/adr/0014-stripe-connect-accounts-api-boundary.md:11",
        ],
        openQuestions: [
          "Whether to formally describe Chase Sets as a 'limited payments collection agent' for state money-transmission-exemption purposes is a counsel question distinct from the technical fund-flow description above; confirm this framing during the #5679 counsel engagement, alongside #5688's processor terms and the #5906 Stripe agreement-type proof.",
        ],
        assumptions: [
          {
            assertion:
              "Buyer charges are captured to the Chase Sets platform Stripe account (platform-held); seller proceeds move only later via a separate platform-to-connected-account transfer and on-demand payout, not a Stripe Connect destination charge.",
            evidenceRef:
              "infrastructure/stripe-payments/index.ts:1464-1494; infrastructure/stripe-connect/index.ts:1039-1094",
          },
        ],
      },
    },
    {
      id: "eligibility-and-accounts",
      title: "Eligibility and accounts",
      draftText:
        "You must be at least 18 years old and able to form a binding contract to create a Chase Sets Account. You are responsible for the accuracy of the information you provide when you register, for keeping your contact information current, and for safeguarding your credentials, including any password, passkey, or API key. Chase Sets may screen registration and decline, delay, or condition an Account, including through an invitation or waitlist process. Notify Chase Sets promptly through a Support Request if you believe your Account or credentials have been compromised.",
      reviewStatus: "counsel-required",
      claimDisclosures: accountActivityResponsibilityClaimDisclosures,
      reviewManifest: {
        scopeNote:
          "State the minimum-age and contracting-capacity requirement, and the account holder's registration-accuracy, contact-currency, and credential-security duties.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66,158-176",
          "bounded-contexts/auth/support/api-support/registration-gates.ts:21-25,58-84",
          "bounded-contexts/identity/features/api-keys/domain/domain.ts",
        ],
        openQuestions: [
          "Chase Sets does not currently collect or verify a date of birth or other age attestation at registration; the eighteen-plus requirement is a contractual eligibility requirement Chase Sets relies on the user's representation to satisfy, not a system-enforced age gate. Flag for a product decision on whether an enforced age gate is needed before launch.",
          "This subject states the account holder's registration-accuracy, contact-currency, and credential-safeguarding duties, which are owed on their own terms whether or not the holder authorizes a software agent. It deliberately does not state how far the holder's responsibility reaches for activity a software agent they authorized conducts through the Account; that extent is carried only by this section's canonical claim disclosure. Counsel question: what responsibility or liability, if any, should an account holder bear for an authorized software agent's activity on the Account — universally, bounded to named categories of agent act, or not at all — and where should that allocation be stated relative to the Agent Connector Terms?",
        ],
        assumptions: [
          {
            assertion: "No age or date-of-birth field exists in the registration form or API today.",
            evidenceRef:
              "bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66; bounded-contexts/auth/support/api-support/register-routes.ts:36-58",
          },
          {
            assertion: "Registration may be gated by invitation, waitlist, or disposable-email screening.",
            evidenceRef: "bounded-contexts/auth/support/api-support/registration-gates.ts:21-25,58-84",
          },
        ],
        canonicalClaims: accountActivityResponsibilityCanonicalClaims,
      },
    },
    {
      id: "listings-offers-and-contract-formation",
      title: "Listings, offers, and contract formation",
      draftText:
        "A seller creates a Listing describing an item for sale. A buyer may purchase a Listing directly at checkout or submit an Offer that the seller may accept, counter, or decline. A binding sale contract between buyer and seller forms when Chase Sets' Ordering service records the Order, following direct-purchase checkout or Offer acceptance, a distinct and earlier step from payment capture, and the sale remains subject to the applicable cancellation, payment, and fulfillment terms described in these Terms and Chase Sets' published Help Center, including the buyer's limited self-service cancellation window before shipment. Chase Sets is not a party to the resulting sale contract and does not guarantee that a Listing or Offer is available, accurate, or free of error; sellers are solely responsible for honoring accepted Offers and completed purchases.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe how Listings and Offers work, the point at which a binding sale contract forms, and that Chase Sets is not a party to that contract.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/marketplace/features/offers/domain/domain.ts:72,207-241,289",
          "bounded-contexts/ordering/features/orders/domain/domain.ts:263-300,338-346",
          "bounded-contexts/ordering/README.md:5,73",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "The Order created by Ordering (before pending-payment is recorded and before payment capture) is the commercial commitment between buyer and seller.",
            evidenceRef: "bounded-contexts/ordering/GLOSSARY.md:1-22; bounded-contexts/ordering/README.md:5",
          },
          {
            assertion: "Buyers retain a limited self-service purchase-cancellation window before shipment.",
            evidenceRef: "bounded-contexts/ordering/GLOSSARY.md:76-85",
          },
        ],
      },
    },
    {
      id: "conduct-and-policy-incorporation",
      title: "Conduct and incorporated policies",
      draftText:
        "These Terms incorporate by reference, as if fully set out here, Chase Sets' other published policies to the extent they apply to your use of the marketplace: the Seller Agreement (chasesets.com/seller-agreement) for seller-specific obligations; the Payments Terms (chasesets.com/payments-terms) for payment processing; the Agent Connector Terms (chasesets.com/agent-terms) for automated and agent access; the Authenticity Service Terms (chasesets.com/authenticity-terms) for the optional authenticity-check service; the Privacy Policy (chasesets.com/privacy) for data practices; and, where applicable to a specific offer, the Founders Offer Terms (chasesets.com/founders). Operational conduct standards, including the seller listing condition and photo standards and the buyer order-protection and refunds-and-returns policies, are published in Chase Sets' Help Center and are likewise incorporated by reference. If a specific incorporated policy conflicts with these Terms on the subject it specifically governs, the specific policy controls; these Terms control on every other subject. You agree to use the marketplace lawfully, to deal honestly with other users, and to comply with every incorporated policy.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Enumerate, by slug or href, every other operational and legal-corpus policy this Terms of Service incorporates by reference, so #5695's corpus test can check consistency against the registry.",
        decisionRefs: [],
        productTruthRefs: [
          "contracts/public-docs/policy-corpus.ts:8-28",
          "bounded-contexts/public-presence/features/policies/domain/policy-registry.ts:25-33",
          "contracts/public-docs/generated/help-article-policy-citations.ts",
        ],
        openQuestions: [
          "Chase Sets has not yet published a dedicated prohibited-items or community-guidelines policy document; until one exists, prohibited conduct is governed by this subject and the Seller Agreement together with the Marketplace Report reason codes, rather than a standalone incorporated policy.",
          "#5695 adds the corpus test that checks this subject's slug/href enumeration against the registry; keep this list in sync with contracts/public-docs/policy-corpus.ts if either changes.",
        ],
        assumptions: [
          {
            assertion:
              "The public policy corpus registry is the closed set of legal documents Chase Sets can incorporate by href without inventing an unpublished page.",
            evidenceRef: "contracts/public-docs/policy-corpus.ts:8-28",
          },
        ],
      },
    },
    {
      id: "user-content-license",
      title: "User content license",
      draftText:
        "When you submit content to Chase Sets, including listing photos, listing descriptions, reviews, and review responses, you represent that you own the content or otherwise have the right to submit it, and you grant Chase Sets a non-exclusive, worldwide, royalty-free, sublicensable license to host, store, reproduce, adapt (including normalizing images into Chase Sets' standard formats), display, and distribute that content solely to operate, promote, and improve the marketplace. You retain ownership of your content. Chase Sets may remove or restrict content that violates these Terms, including content reported and confirmed as counterfeit, stolen, prohibited, abusive, or otherwise policy-violating, and may act on a valid intellectual-property complaint sent to the notice address in the governing-law-and-forum subject below.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the content users submit, the license Chase Sets needs to operate the marketplace, and how reported or infringing content is handled.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/marketplace/GLOSSARY.md:19-28,233-246",
          "bounded-contexts/marketplace/features/reports/domain/domain.ts:3-27",
          "bounded-contexts/platform-operations/GLOSSARY.md:70-76",
        ],
        openQuestions: [
          "No prior IP-license grant language exists anywhere in the repository; this is original drafting, not a transcription of an existing artifact.",
          "A formally registered DMCA designated agent is a separate, not-yet-made decision noted under #5677's blast radius; confirm before publication whether a registered agent is required and, if so, record its contact separately from the general notice address.",
        ],
        assumptions: [
          {
            assertion: "Listing photos are normalized into Chase Sets-owned WebP asset variants after upload.",
            evidenceRef: "bounded-contexts/marketplace/GLOSSARY.md:19-28",
          },
          {
            assertion:
              "Listing and review content may be reported; listings can auto-unlist at a distinct-reporter threshold, while review reports never auto-remove.",
            evidenceRef: "bounded-contexts/marketplace/GLOSSARY.md:195-206",
          },
        ],
      },
    },
    {
      id: "electronic-agents-and-automated-access",
      title: "Electronic agents and automated access",
      draftText:
        "Chase Sets publishes a Model Context Protocol interface and a developer portal (chasesets.com/developers) that let you authorize a software agent to act on your Account within a bounded set of permissions you grant. Automated or agent access to Chase Sets is governed by the Agent Connector Terms (chasesets.com/agent-terms) in addition to these Terms; where the two conflict on automated-access-specific subjects, the Agent Connector Terms control.",
      reviewStatus: "counsel-required",
      claimDisclosures: agentBoundaryClaimDisclosures,
      reviewManifest: {
        scopeNote:
          "Cross-reference the Agent Connector Terms for automated and agent access, and describe the repo-provable surface: the Model Context Protocol interface, the developer portal, the bounded permission grant an account holder makes when authorizing a software agent, and which document controls on conflict.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/developer-portal/domain/developer-manifest.ts:24,41-45",
          "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md",
          "bounded-contexts/public-presence/features/policies/domain/agent-connector-terms.ts",
        ],
        openQuestions: [
          "The full Agent Connector Terms subject taxonomy and draft language are #5690's scope, not this issue's; this subject only cross-references it.",
          "This subject describes the authorization surface and the conflict rule only. It deliberately states no allocation of responsibility or liability to the account holder for actions an authorized software agent takes on the Account; that extent is carried only by this section's canonical claim disclosure. Counsel question: what responsibility or liability, if any, should the account holder bear for an authorized software agent's actions, and should that allocation live in these Terms, in the Agent Connector Terms, or in both with one controlling?",
          "This subject also states no grounds, process, or consequences for disabling, suspending, or revoking an authorized software agent's credentials or access, and none for sanctioning the underlying Account because of agent conduct; that boundary is carried only by this section's canonical claim disclosure. Counsel question: on what grounds and with what notice, process, and consequences may agent access be suspended or revoked, and may agent conduct alone support suspending, restricting, or closing the underlying Account?",
        ],
        assumptions: [
          {
            assertion:
              "Agent authorization uses OAuth 2.0 Authorization Code with PKCE; a human authorizes a specific account and scope set before an agent can call the MCP endpoint.",
            evidenceRef:
              "bounded-contexts/public-presence/features/developer-portal/domain/articles/agent-authentication.en.md",
          },
        ],
        canonicalClaims: agentBoundaryUnresolvedCanonicalClaims,
      },
    },
    {
      id: "electronic-communications-and-esign",
      title: "Electronic communications and consent",
      draftText:
        "By creating an Account, you agree that Chase Sets may deliver Account, order, Wallet, and legal notices, including these Terms and any incorporated policy, to you electronically, including by email and by posting to your Account or the applicable Chase Sets webpage, instead of by paper mail. Before Chase Sets treats an electronic disclosure as effective consent for a record category that legally requires it, Chase Sets presents the required disclosure, including your right to receive a paper copy, how to withdraw consent and the consequences of withdrawal, the scope of records covered, how to update your electronic contact information, and any hardware or software needed to access the disclosure, and obtains your affirmative confirmation that you can access records in that format. You may withdraw electronic-delivery consent at any time by submitting a Support Request; withdrawal may limit or end your ability to use Chase Sets services that depend on electronic delivery.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe Chase Sets' target electronic-delivery consent flow per #5685's E-SIGN finding: the required disclosure set, affirmative access confirmation, and withdrawal path.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/identity/features/consents/domain/domain.ts:29-73",
          "bounded-contexts/identity/features/consents/api/route.ts:49-101",
          "bounded-contexts/auth/features/registration/ui/register-page.tsx:130-175,281-330",
        ],
        openQuestions: [
          "Gap confirmed by #5685: registration today captures identity/authentication consent but not the affirmative electronic-delivery disclosure set (paper-copy right, withdrawal, scope, hardware/software requirements, access confirmation) described in this subject. Per #5686's instruction, this subject drafts the target flow rather than only the shipped state; the implementation gap is tracked at #5900 and must land, with the disclosure copy and delivery point reviewed by counsel, before this subject can be marked counsel-approved and published.",
        ],
        assumptions: [
          {
            assertion:
              "Identity's consent machinery can record and withdraw an arbitrary named consent (policy key, version, subject, timestamp), but no registration-time E-SIGN-specific disclosure or access-confirmation capture exists yet.",
            evidenceRef: "bounded-contexts/identity/features/consents/domain/domain.ts:29-73",
          },
        ],
      },
    },
    {
      id: "disclaimers-and-liability-limits",
      title: "Disclaimers and liability limits",
      draftText:
        "Chase Sets provides the marketplace on an as-is, as-available basis and disclaims all warranties not expressly stated in these Terms, to the extent the law allows. Chase Sets does not warrant the authenticity, condition, or description of any Listing except through the optional authenticity-check service described in the Authenticity Service Terms (chasesets.com/authenticity-terms), and even that service is limited to the scope stated in those terms. To the extent the law allows, Chase Sets is not liable for indirect, incidental, special, consequential, or punitive damages, or for lost profits, arising from your use of the marketplace, and Chase Sets' total liability to you for claims arising from these Terms is limited to the greater of the marketplace fees you paid Chase Sets on the transaction giving rise to the claim in the twelve months before the claim, or [LIABILITY-CAP-FLOOR-AMOUNT]. Nothing in this subject limits liability that the law does not allow Chase Sets to limit.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the as-is marketplace disclaimer, the authenticity-check carve-out, and a liability limitation consistent with the two-tier no-prose-number rule.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.ts",
          "bounded-contexts/authenticity/README.md",
          "bounded-contexts/authenticity/GLOSSARY.md",
        ],
        openQuestions: [
          "The liability-cap floor amount is an unresolved business and counsel decision; [LIABILITY-CAP-FLOOR-AMOUNT] is an explicit placeholder pending that decision, consistent with the #5677-style placeholder convention for undecided facts.",
        ],
        assumptions: [
          {
            assertion:
              "The Authenticity Service is an optional, separately terms-governed service, not a general Chase Sets warranty over every Listing.",
            evidenceRef: "bounded-contexts/authenticity/README.md",
          },
        ],
      },
    },
    {
      id: "user-vs-user-dispute-release",
      title: "User-to-user dispute release",
      draftText:
        "Chase Sets is not a party to the sale contract between a buyer and a seller and does not resolve buyer-seller disputes as a private mediator; Chase Sets provides a Support Request process through which you and the other party may submit evidence, and Chase Sets support may determine responsibility and direct a remedy within Chase Sets' published remedy authority, up to and including a refund, replacement, or return. If you have a dispute with another user arising from a Listing, Offer, or Order, you release Chase Sets, its officers, and its operators from claims, damages, and demands arising from that dispute, except for Chase Sets' own acts or omissions in operating the Support Request process; this release does not limit either party's right to submit a Support Request or to pursue an available remedy against the other user directly.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the Support Request process as the platform's buyer-seller dispute avenue, and state a release of Chase Sets for user-to-user disputes consistent with that operator-mediated process.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/platform-operations/GLOSSARY.md:11-13",
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:5-79",
          "bounded-contexts/platform-operations/features/support-requests/domain/domain.ts:32,841,1475,1508",
        ],
        openQuestions: [
          "No self-service, user-initiated mutual release or negotiation mechanism exists in the product today; Support Request is operator-mediated. This subject describes submission to Support Request resolution, consistent with shipped behavior, rather than a private buyer-seller settlement feature.",
        ],
        assumptions: [
          {
            assertion:
              "Support Request is the shipped, operator-mediated avenue for buyer-seller order issues; there is no separate private user-to-user dispute feature.",
            evidenceRef: "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:5-79",
          },
        ],
      },
    },
    {
      id: "dispute-resolution-with-platform",
      title: "Dispute resolution with Chase Sets",
      draftText:
        "Any dispute you have with Chase Sets itself, as opposed to another user, that these Terms and Chase Sets' Support Request process cannot resolve informally will be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, and not by a court or jury, except that either party may bring an individual claim in small-claims court if it qualifies, and either party may seek injunctive relief in court for intellectual-property or unauthorized-access claims. You and Chase Sets each waive the right to a jury trial and to participate in a class, collective, or representative action; the arbitrator may not consolidate more than one person's claims and may not otherwise preside over a class or representative proceeding. Chase Sets pays the administrator's filing and arbitrator fees for an individual claim of $10,000 or less brought in good faith. Before starting arbitration or a small-claims action, you and Chase Sets agree to send a written notice of dispute to the other and try in good faith to resolve it informally for 45 days. You may opt out of this arbitration agreement by sending written notice to the notice address in the governing-law-and-forum subject below within 30 days of the date you first agree to this version of these Terms; opting out does not affect any other part of these Terms. If 25 or more similar arbitration demands are filed by or on behalf of coordinated claimants, Chase Sets and claimants' counsel follow the batch-filing protocol posted with the arbitration administrator's rules, resolving representative cases first before proceeding to the remainder.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Draft the ratified #5681 arbitration posture (individual arbitration, class-action waiver, opt-out, informal-resolution precondition, small-claims carve-out, batch-filing protocol, jury waiver) verbatim from the decision issue's recommended mechanics.",
        decisionRefs: [5681],
        productTruthRefs: [],
        openQuestions: [
          "This subject is legal drafting sourced from the ratified #5681 decision, not a claim about shipped product behavior; the arbitration mechanics numbers (claim threshold, notice windows, batch-filing count) are the ratified terms themselves, not operational values a policy document tracks, so the two-tier no-prose-number rule does not apply to them.",
          "The injunctive-relief carveout for intellectual-property and unauthorized-access claims in this subject's draft text is an unratified drafted addition, not part of #5681's ratified mechanics list (AAA Consumer Arbitration Rules, $10,000 fee floor, 30-day opt-out, 45-day informal notice, small-claims carve-out, 25+ batch-filing protocol, jury waiver); no exact ratified evidence for it was located. Confirm with the #5681 decision owner or remove before counsel handoff.",
        ],
        assumptions: [
          {
            assertion:
              "Option A (individual arbitration, AAA Consumer Arbitration Rules, platform-paid fees under the claim threshold, 30-day opt-out, 45-day informal notice, small-claims carve-out, batch-filing protocol, jury waiver) was ratified by Todd for the Terms of Service, Seller Agreement, and Payments Terms dispute subjects.",
            evidenceRef: "issue #5681 (decision recorded 2026-07-18)",
          },
        ],
      },
    },
    {
      id: "governing-law-and-forum",
      title: "Governing law and forum",
      draftText:
        "These Terms are governed by the laws of the State of Kansas, without regard to its conflict-of-laws rules, except that the Federal Arbitration Act governs the arbitration agreement in the dispute-resolution-with-platform subject above. Subject to that arbitration agreement, you and Chase Sets consent to the exclusive jurisdiction of the state and federal courts located in Kansas for any dispute not subject to arbitration. Chase Sets Limited, registered in Wichita, Kansas, is the contracting entity for these Terms. Send legal notices, including arbitration opt-out notices, to Chase Sets Limited, PO Box 164, Maize, KS 67101-0164, US, or to [NOTICE-EMAIL].",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the contracting entity, governing law, forum, and legal notice address per the ratified #5677 decision, with an explicit placeholder for the fact #5677 did not supply.",
        decisionRefs: [5677, 5679],
        productTruthRefs: ["bounded-contexts/public-presence/routes/marketplace/home.tsx:198-200"],
        openQuestions: [
          "#5677 recorded the entity, state, and mailing notice address (Todd, 2026-07-18) but did not supply a dedicated legal-notice email distinct from the published general support contact (support@chasesets.com); [NOTICE-EMAIL] is an explicit placeholder pending that fact.",
          "Governing-law state follows the entity's registration (Kansas) per #5677's decision comment 'unless counsel (#5679) directs otherwise'; confirm no change during the #5679 counsel engagement before publication.",
        ],
        assumptions: [
          {
            assertion:
              "Contracting entity is Chase Sets Limited, registered in Wichita, Kansas, USA; notice address is PO Box 164, Maize, KS 67101-0164, US.",
            evidenceRef: "issue #5677 (decision recorded 2026-07-18)",
          },
        ],
      },
    },
    {
      id: "changes-notice-and-acceptance",
      title: "Changes, notice, and acceptance",
      draftText:
        "Chase Sets may revise these Terms. A material revision is published as a new, numbered version and takes effect on the version's recorded effective date; Chase Sets notifies you of a material revision and requires you to accept the new version, through the same version-gated acceptance mechanism that gates your current acceptance, before your continued use of features that depend on accepting these Terms proceeds under the new version. A non-material, editorial revision, such as a correction of an incorporated policy's link, does not require a new version or renewed acceptance. Your acceptance is recorded against the specific version you accepted, and Chase Sets' identity systems reject a stale acceptance the same way for every account.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the document-level versioning, material-change notice, and version-gated re-acceptance mechanism for the Terms of Service as a whole.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/identity/features/consents/domain/terms-of-service-policy.ts:28-59",
          "bounded-contexts/identity/features/consents/api/terms-route.ts:31-90",
          "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:26-28",
        ],
        openQuestions: [],
        assumptions: [
          {
            assertion:
              "The active-required-version policy and read model fail closed on missing or outdated acceptance, gating per-version re-acceptance.",
            evidenceRef: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:19-30",
          },
        ],
      },
    },
  ],
};

export function evaluateTermsOfServicePublicationReadiness(
  artifact: TermsOfServicePolicyArtifact,
): PublicPolicyPublicationReadiness {
  return evaluatePublicPolicyPublicationReadiness(artifact, requiredTermsOfServiceSubjectIds);
}
