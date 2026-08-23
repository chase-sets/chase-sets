import { paymentChargeTimingAndCaptureProductTruthRefs } from "./canonical-claims";
import type { PublicPolicyArtifact } from "./policy-artifact";
import { privacyProductTruthRefsForSection } from "./privacy-policy-product-truth";

export const requiredPrivacyPolicySubjectIds = [
  "privacy-notice-scope",
  "data-categories-and-sources",
  "purposes-of-use",
  "recipients-and-disclosures",
  "stripe-managed-processing",
  "cookies-and-analytics",
  "gpc-and-sale-share",
  "privacy-rights-and-requests",
  "retention",
  "children",
  "state-supplements",
  "automated-decisionmaking-technology",
] as const;

export type PrivacyPolicySubjectId = (typeof requiredPrivacyPolicySubjectIds)[number];

/**
 * The draft Chase Sets privacy notice, prepared for qualified-counsel review.
 *
 * Every section stays `counsel-required` and the artifact stays fail-closed:
 * non-published, non-effective, empty rollout scope, and non-consent-
 * activatable until qualified counsel reviews this exact candidate and a
 * separately authorized change records that approval. Bracketed [ALL-CAPS]
 * tokens are explicit placeholders for counsel-owned conclusions, never
 * operative statements.
 *
 * Operative prose describes provider relationships by function, never by legal
 * role: the `service provider` characterization is reserved for the N6
 * counsel-owned manifest question below and must not appear in any
 * `draftText`.
 *
 * Every inventory-backed `productTruthRef` resolves through the binding tuples
 * in `privacy-policy-product-truth.ts`, which are in turn bound to the
 * code-shape derivation in
 * `../integrations/privacy-product-truth-inventory.mjs`. Citations are never
 * typed twice, so a section cannot drift from the source it claims.
 */
export const privacyPolicyArtifact: PublicPolicyArtifact<"privacy-policy", PrivacyPolicySubjectId> = {
  metadata: {
    policyKey: "privacy-policy",
    version: "v1",
    locale: "en",
    href: "/privacy",
    publicationStatus: "counsel-review-required",
    effectiveAt: null,
    counselApprovalReference: null,
    rolloutJurisdictionsOrProductLimits: [],
    launchRequired: true,
  },
  title: "Privacy policy",
  description:
    "This versioned artifact carries the draft Chase Sets privacy notice for the public policy corpus: what personal information the marketplace collects, why, who receives it, and the choices and rights that apply. Every section requires qualified counsel review, and nothing in it takes effect before counsel approves the final language, launch scope, and external approval reference.",
  sections: [
    {
      id: "privacy-notice-scope",
      title: "What this notice covers",
      draftText:
        "This privacy notice describes how Chase Sets Limited (“Chase Sets”) collects, uses, shares, and retains personal information when you visit the Chase Sets website, join the waitlist, create an Account, buy or sell trading cards and related collectibles, set up payouts, or contact support. It applies to the Chase Sets marketplace and its account, developer, and support surfaces. It does not replace the Terms of Service or the other policies that govern your use of the marketplace, and it does not cover the independent practices of other users or of providers acting under their own notices, such as the payment processing described in the Stripe-managed processing section below.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Define who the notice speaks for (the #5677 contracting entity), which surfaces it covers, and where its coverage ends relative to other users' and providers' own notices.",
        decisionRefs: [5677, 5679],
        productTruthRefs: ["bounded-contexts/public-presence/features/policies/domain/policy-registry.ts:25-33"],
        openQuestions: [
          "Launch jurisdiction scope is undecided: metadata.rolloutJurisdictionsOrProductLimits stays empty until counsel fixes the launch scope, and no jurisdiction claim is made in this draft.",
          "E-SIGN and INFORM Consumers Act conclusions from the #5685 discovery remain counsel-owned; whether INFORM verification or disclosure duties change what this notice must say about seller information is part of the #5679 engagement (E-SIGN capture itself is #5900).",
          "The dedicated legal/privacy notice email is a counsel-owned selection ([NOTICE-EMAIL] in the rights section); this draft does not designate the general support contact as the privacy contact.",
        ],
        assumptions: [
          {
            assertion:
              "The Privacy Policy is a registered member of the seven-document public policy corpus and renders at the canonical /privacy route.",
            evidenceRef: "bounded-contexts/public-presence/features/policies/domain/policy-registry.ts:25-33",
          },
          {
            assertion:
              "Chase Sets Limited (Wichita/Kansas; PO Box 164, Maize, KS 67101-0164 US) is the contracting entity.",
            evidenceRef: "issue #5677 (decision recorded 2026-07-18)",
          },
        ],
      },
    },
    {
      id: "data-categories-and-sources",
      title: "Information Chase Sets collects, and where it comes from",
      draftText:
        "Chase Sets collects account and profile information you provide when you register, such as your display name, email address, a phone number when you provide one for phone-based sign-in, and your password, passkey, or other sign-in credential. When you choose Google or Facebook social login, Chase Sets receives a mapped profile from that identity provider: the provider's own subject identifier for you, any available email address and whether that provider treats it as verified, your display name, and your given and family names where available. For Google, that mapped profile also includes the hosted domain (the Google Workspace domain claim) when the signing-in account has one. Before launch, the waitlist collects your email address, whether you want to buy or sell, your interests, an email consent timestamp, a separate optional marketing consent timestamp, and, for seller signups, a self-reported inventory-size bucket. Using the marketplace creates activity records: Listings and the evidence images you attach to them, Offers, Orders, reviews, Wallet ledger entries, and payout requests. Fulfilling an order uses the destination address the order is delivered to, which also determines the order's tax jurisdiction. Contacting Chase Sets creates support and feedback records: Support Requests, the evidence you and the other party attach to them, and survey or feedback responses. Your browser also supplies technical information: the first-party cookies and browser storage described in the cookies section below, and bounded analytics events that include the page path, campaign (UTM) parameters, and the referrer of the page you arrived from. Chase Sets collects this information directly from you and your device; from Google or Facebook when you choose that provider for social login; from other users, for example when a buyer or seller opens a Support Request about your order or reports a Listing; and from its payment processor, in the form of provider references and provider-neutral payout-readiness statuses rather than the underlying verification details.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Enumerate the personal-information categories and sources that shipped surfaces actually collect, without inventing categories no surface captures.",
        decisionRefs: [5685],
        productTruthRefs: [
          ...privacyProductTruthRefsForSection("data-categories-and-sources"),
          "bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66",
          "bounded-contexts/auth/docs/security-lifetimes.md:3",
          "bounded-contexts/public-presence/features/waitlist/domain/common.ts:27-40",
          "bounded-contexts/public-presence/features/waitlist/domain/common.ts:42-50",
          "bounded-contexts/public-presence/features/waitlist/domain/domain.ts:77-85",
          "bounded-contexts/marketplace/GLOSSARY.md:19-28",
          "bounded-contexts/ordering/GLOSSARY.md:172",
          "bounded-contexts/settlement/routes/marketplace/account-desk-money.tsx:63-75",
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:32-50",
          "bounded-contexts/public-presence/docs/landing-page-analytics.md:27-34",
          "docs/adr/0006-stripe-connect-custom-account-experience.md:58-64",
        ],
        openQuestions: [
          "Mapping these operational categories onto a state-law category taxonomy (identifiers, commercial information, internet activity, and any sensitive-personal-information classification) is a counsel judgment for the state-supplements section.",
          "Whether any collected element (for example precise payout or identity data held only by Stripe) must still be disclosed as 'collected' by Chase Sets under state law is a counsel judgment tied to the Stripe recipient characterization.",
          "Whether the Google hosted-domain claim is itself a category requiring separate treatment, and whether its workspace-account signal carries any employment-context implication, is a counsel judgment; this draft states only what the shipped provider mapping produces.",
        ],
        assumptions: [
          {
            assertion:
              "Registration captures display name, email, phone, and password; no date-of-birth or government-identifier field exists in the registration details.",
            evidenceRef: "bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66",
          },
          {
            assertion:
              "Waitlist signup captures email, commerce intent, interests, an email consent timestamp, a separate marketing consent timestamp, a bucketed self-reported inventory size, and a source record limited to page path, referrer, and the five UTM parameters.",
            evidenceRef:
              "bounded-contexts/public-presence/features/waitlist/domain/domain.ts:77-85; bounded-contexts/public-presence/features/waitlist/domain/common.ts:27-40; bounded-contexts/public-presence/features/waitlist/domain/common.ts:42-50",
          },
          {
            assertion:
              "The shipped social-login provider registrations are Google and Facebook; their mapped profiles are derived by code shape from the executable provider profile mappers, and only Google's mapping carries a hosted-domain field.",
            evidenceRef:
              "bounded-contexts/auth/support/social-login-support/providers.ts:165-174; bounded-contexts/auth/support/social-login-support/providers.ts:197-205",
          },
        ],
      },
    },
    {
      id: "purposes-of-use",
      title: "How Chase Sets uses personal information",
      draftText:
        "Chase Sets uses personal information to operate the marketplace: to create and secure your Account and sign-in sessions; to publish Listings, form Orders, and process purchases, refunds, Wallet activity, and payouts; to verify shipping addresses, buy postage, and deliver orders; to determine the tax jurisdiction of an order from its destination address; to run the Support Request process and resolve order problems; to detect and limit fraud and abuse, including screening registrations while admission is invitation-gated, applying the sale-clearance qualifiers described in the automated-decisions section, and identifying accounts that share payment-instrument or shipping-address risk signals; to send transactional email and text messages about your Account, orders, and payouts; to send early-access updates to waitlist signups and, where you separately opted in, additional product updates; to measure landing-page and campaign funnels with bounded, provider-neutral analytics; and to keep the records Chase Sets needs for legal, tax, audit, and security obligations.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the purposes shipped surfaces actually serve, in plain language, each anchored to the surface that performs it.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/auth/support/api-support/registration-gates.ts:4-25",
          "bounded-contexts/settlement/features/wallets/domain/clearance-policy.ts:5-18",
          "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-projection.ts:14-59",
          "bounded-contexts/ordering/GLOSSARY.md:172",
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:5-30",
          "infrastructure/ses-email/index.ts:1-7",
          "infrastructure/twilio-messaging/index.ts:1-20",
          "infrastructure/easypost-postage/index.ts:77-100",
          "bounded-contexts/public-presence/features/waitlist/domain/domain.ts:77-85",
          "bounded-contexts/public-presence/docs/landing-page-analytics.md:3-7",
        ],
        openQuestions: [
          "Whether purposes must be broken out per category (a per-category purpose matrix) or may be stated as one purpose list is a counsel formatting judgment for the state supplements.",
          "No general marketing program beyond the waitlist early-access and opt-in product-update emails was found shipped; counsel should confirm no broader marketing purpose is stated until one exists.",
        ],
        assumptions: [
          {
            assertion:
              "Registration admission defaults to invitation mode with disposable-email screening in log-only mode; both are configuration, not permanent posture.",
            evidenceRef: "bounded-contexts/auth/support/api-support/registration-gates.ts:4-25",
          },
        ],
      },
    },
    {
      id: "recipients-and-disclosures",
      title: "Who receives personal information",
      draftText:
        "Chase Sets shares personal information with the companies that perform specific functions for the marketplace: Stripe, which processes payments and payout-account onboarding as described in the next section; a postage provider, which verifies shipping addresses and creates shipping labels; an email-delivery provider and a text-messaging provider, which deliver transactional messages; and the cloud infrastructure providers that host the marketplace and store uploaded images. Separately, when you choose Google or Facebook social login, Chase Sets sends that identity provider an authentication request identifying that you are signing in to Chase Sets, and receives that provider's mapped profile in return. Chase Sets also shares information with other users when a transaction requires it — for example, the order and delivery details a sale needs to be fulfilled, and the evidence both parties can see inside a Support Request — and with authorities or other parties where Chase Sets believes in good faith that disclosure is required or permitted by law, including responding to legal process and protecting the marketplace and its users. Chase Sets' public landing pages do not load third-party advertising or analytics scripts.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Enumerate recipient categories from the shipped provider adapters and marketplace flows using neutral factual function wording; leave every recipient-relationship characterization to counsel.",
        decisionRefs: [5679, 5685],
        productTruthRefs: [
          ...privacyProductTruthRefsForSection("recipients-and-disclosures"),
          "infrastructure/stripe-payments/index.ts:1464-1494",
          "infrastructure/easypost-postage/index.ts:77-100",
          "infrastructure/ses-email/index.ts:1-7",
          "infrastructure/twilio-messaging/index.ts:1-20",
          "bounded-contexts/marketplace/GLOSSARY.md:26-27",
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:32-50",
          "bounded-contexts/public-presence/docs/landing-page-analytics.md:5",
        ],
        openQuestions: [
          "(N6) Whether each provider (Stripe, the postage, email, messaging, and hosting providers) is a 'service provider', 'contractor', 'processor', or an independent business under applicable state law, and whether the required contract terms are in place, is a counsel judgment. The operative copy above deliberately names functions rather than legal roles, and that exact 'service provider' characterization must stay in this question until counsel resolves it.",
          "Whether Google or Facebook has a particular legal role in the social-login interaction, and whether that role requires additional characterization, is a counsel judgment; this draft identifies the authentication interaction and the mapped profile without assigning either provider a legal role.",
          "Whether the notice must name providers individually or may describe categories is a counsel formatting judgment.",
          "Exactly which order and account fields a counterparty (buyer or seller) sees at each order stage has no single citable source line; before publication, the counsel packet should attach a concrete counterparty-visibility inventory rather than rely on this section's summary sentence.",
        ],
        assumptions: [
          {
            assertion:
              "The shipped outbound-provider surface consists of Google and Facebook social login, Stripe payments and Connect onboarding, EasyPost-backed postage and address verification, SES-backed transactional email, Twilio-backed SMS/RCS messaging, and cloud-hosted infrastructure with an environment asset bucket for images; no advertising-network adapter exists.",
            evidenceRef:
              "bounded-contexts/auth/support/social-login-support/providers.ts:165-174; infrastructure/easypost-postage/index.ts:77-100; infrastructure/ses-email/index.ts:1-7; infrastructure/twilio-messaging/index.ts:1-20; bounded-contexts/marketplace/GLOSSARY.md:26-27",
          },
        ],
      },
    },
    {
      id: "stripe-managed-processing",
      title: "Payments and payout onboarding handled by Stripe",
      draftText:
        "Payments and payout accounts run on Stripe. When you pay, Stripe collects and processes your payment method details, and Stripe charges your selected payment method as part of completing the purchase; Chase Sets holds the purchase funds on its own platform account until seller payout. When you set up payouts as a seller, Stripe collects the onboarding and verification information it requires — identity details, verification documents, and your payout bank details — directly through Stripe-rendered components embedded in the Chase Sets account area, and Stripe presents its own terms as part of that onboarding. Chase Sets stores provider references, provider-neutral payout-readiness statuses, missing-requirement identifiers, timestamps, and user-safe failure reasons; Chase Sets does not store your bank account numbers, tax identity values, verification documents, or raw provider payloads.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the Stripe-managed collection boundary factually: what Stripe collects directly, what Chase Sets stores, and the platform-held funds path, without characterizing the legal relationship or the Stripe agreement type.",
        decisionRefs: [5685],
        productTruthRefs: [
          "docs/adr/0006-stripe-connect-custom-account-experience.md:15",
          "docs/adr/0006-stripe-connect-custom-account-experience.md:29",
          "docs/adr/0006-stripe-connect-custom-account-experience.md:54",
          "docs/adr/0006-stripe-connect-custom-account-experience.md:58-64",
          "infrastructure/stripe-payments/index.ts:1464-1494",
        ],
        openQuestions: [
          "The recipient and contract characterization of Stripe, and any statement about which Stripe agreement type applies, are counsel-owned; per the #5685 finding, Chase Sets must not claim a Stripe agreement type or statutory conclusion the captured evidence does not establish.",
          "Whether this section must link Stripe's own privacy notice, and which one, is a counsel judgment.",
        ],
        assumptions: [
          {
            assertion:
              "Buyer charges are captured to the Chase Sets platform account with a platform-held funds strategy; seller onboarding uses Stripe embedded components, and Stripe owns verification rules, sensitive requirement collection, and service-agreement presentation.",
            evidenceRef:
              "infrastructure/stripe-payments/index.ts:1464-1494; docs/adr/0006-stripe-connect-custom-account-experience.md:15; docs/adr/0006-stripe-connect-custom-account-experience.md:29; docs/adr/0006-stripe-connect-custom-account-experience.md:54",
          },
        ],
        canonicalClaims: [
          {
            claimId: "payment-charge-timing-and-capture",
            productTruthRefs: paymentChargeTimingAndCaptureProductTruthRefs,
          },
        ],
      },
    },
    {
      id: "cookies-and-analytics",
      title: "Cookies, browser storage, and analytics",
      draftText:
        "Chase Sets sets first-party cookies for sign-in sessions (chase_sets_session), selecting which Account to act as (chase_sets_account_selection), guest checkout (chase_sets_guest_checkout), a signed-out cart (chase_sets_anonymous_cart), a signed-out sell list (chase_sets_anonymous_sell_list), signed-out saved lists (chase_sets_anonymous_saved_lists), signed-out product alerts (chase_sets_anonymous_product_alerts), signed-out Listing drafts (chase_sets_anonymous_listing_drafts), signed-out Listing reports (chase_sets_anonymous_reports), and your colour-mode preference (chase_sets_color_mode). This section names the cookies the marketplace sets today rather than asserting a fixed total; it is re-derived from the shipped source whenever that set changes. The sign-in session, account-selection, and guest-checkout lifetimes are deployment settings rather than values an administrator can change from inside the app, and the signed-in session default is fourteen days. " +
        "Your browser also stores information for the marketplace itself. In local storage, chase-sets:marketplace:recent-searches holds your recent search terms and chase-sets-theme holds your light, dark, or system theme preference. In session storage, keys in the chase-sets:review-draft: family hold an unfinished review's rating, feedback text, and problem categories for a specific order; discovery.search.restoration.v2 holds the identity of the search result set you last viewed — the search text, category, tag, language, market activity, price bounds, in-stock filter, sort, and dynamic filters — together with your scroll position and a bounded number of already-fetched result pages; and discovery.search.loader-cache.v1 holds a bounded, time-limited set of search responses keyed by the search URL that produced them. The search page is public, so this browser-side search state can exist before you sign in or create an Account. " +
        "Some pages load a payment provider's own browser script. Stripe.js loads on /checkout/buy/session/:sessionId, /account/payments/:paymentId, /checkout/payments/:paymentId, and /account/payment-methods; Stripe Connect.js loads on /account/desk/settings. Those scripts are controlled by Stripe and may use provider-controlled client-side storage in your browser. Chase Sets' own source establishes only that the scripts load on those pages; which storage each provider script uses, how long it lasts, and what it is for are described by that provider rather than by Chase Sets. " +
        "In production builds the marketplace also registers a service worker served from /service-worker.js. It keeps a browser cache named chase-sets-marketplace-pwa-v1 holding static assets and an offline page. That cache skips requests carrying credentials, and it excludes /guest-checkout/exit, /sign-in, /sign-out, and /register as well as anything under /api/, /account, /checkout, /payment, /payments, and /orders. " +
        "Chase Sets' landing-page and campaign analytics are first-party and provider-neutral: no third-party analytics SDK, vendor cookie, or third-party script is added to the page. Analytics events carry bounded properties such as the page path, section, and status, together with the campaign parameters utm_source, utm_medium, utm_campaign, utm_content, and utm_term, and the referrer of the page you arrived from, so Chase Sets can measure which campaigns and referring pages bring visitors to the marketplace. These events are kept free of email addresses, account identifiers, and raw URLs.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Disclose the derived first-party cookie set, the derived consumer browser-storage subjects, the provider-injected script surfaces, the consumer service-worker cache family, the provider-neutral analytics posture, and the UTM/referrer campaign attribution the campaign-start gate reads from this canonical source.",
        decisionRefs: [],
        productTruthRefs: [
          ...privacyProductTruthRefsForSection("cookies-and-analytics"),
          "bounded-contexts/auth/docs/security-lifetimes.md:13-25",
          "bounded-contexts/discovery/routes/search.tsx:1157-1163",
          "bounded-contexts/public-presence/docs/landing-page-analytics.md:3-7",
          "bounded-contexts/public-presence/docs/landing-page-analytics.md:27-34",
          "bounded-contexts/public-presence/features/waitlist/domain/common.ts:42-50",
        ],
        openQuestions: [
          "Cookie and tracking-technology classification (strictly necessary versus functional or analytics, and whether any consent banner or cookie-preference control is required in a launch jurisdiction) is a counsel judgment. Nothing in the derived inventory decides it.",
          "The provider-controlled storage that Stripe.js and Stripe Connect.js may set — its names, contents, durations, purposes, and cookie classification — is not entailed by Chase Sets source. It is a Stripe-documentation and counsel question, and the operative copy deliberately states only that those scripts load and may use provider-controlled client-side storage.",
          "Whether the marketplace service-worker cache chase-sets-marketplace-pwa-v1 is material to a privacy notice at all, and whether its credential-skipping and excluded-path behaviour needs describing, are counsel judgments; the operative copy states the technical facts without drawing a legal conclusion.",
          "(N9) Whether the operator-only browser-storage families — the Catalog primary-workbench working set in the catalog.primaryWorkbench.observationSelection. session-storage key family, and the Admin service-worker cache chase-sets-admin-pwa-v1 — belong in a consumer-facing notice is a counsel judgment. Both are derived and classified operator-only in the product-truth inventory and are deliberately kept out of the operative copy above.",
          "(N8) Whether to retain the campaign-start gate's canonical-subject locator against this section, or replace it with a different mechanism once this Slice has proved it fail-closed, is an open follow-up rather than a drafting question.",
          "If a third-party analytics or advertising provider is ever added behind the provider-neutral event bridge, this section and the sale/share section must be re-reviewed before that provider ships.",
        ],
        assumptions: [
          {
            assertion:
              "The first-party cookie subjects, consumer browser-storage subjects, provider-injected script surfaces, and the marketplace CacheStorage family named above are derived by code shape from the Git-tracked production TypeScript partition, not from a hand-maintained list, and every derived subject is classified or fails closed.",
            evidenceRef:
              "bounded-contexts/public-presence/features/policies/integrations/privacy-product-truth-inventory.mjs; bounded-contexts/public-presence/features/policies/domain/privacy-policy-product-truth.ts",
          },
          {
            assertion:
              "Auth session and guest-checkout cookie lifetimes derive from the nine environment-tier security lifetimes, with a fourteen-day session default.",
            evidenceRef: "bounded-contexts/auth/docs/security-lifetimes.md:13-25",
          },
          {
            assertion:
              "The public search route supplies session storage to the restoration and loader-cache modules, so their browser-side state exists on an unauthenticated surface.",
            evidenceRef: "bounded-contexts/discovery/routes/search.tsx:1157-1163",
          },
        ],
      },
    },
    {
      id: "gpc-and-sale-share",
      title: "Selling, sharing, and Global Privacy Control",
      draftText:
        "Chase Sets' shipped analytics are first-party and provider-neutral, and Chase Sets' public landing pages do not load third-party advertising trackers or cross-context behavioural-advertising scripts. [SALE-SHARE-AND-GPC-STATEMENT: counsel's conclusion on whether any Chase Sets practice is a “sale” or “sharing” of personal information under applicable state law, and the operative description of how Chase Sets responds to Global Privacy Control and other opt-out preference signals, will be stated here before this notice takes effect.]",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Record the factual no-ad-network, first-party-analytics posture and reserve the sale/share conclusion and the GPC response behaviour for counsel.",
        decisionRefs: [5679],
        productTruthRefs: ["bounded-contexts/public-presence/docs/landing-page-analytics.md:5"],
        openQuestions: [
          "Whether any current practice constitutes a 'sale' or 'sharing' under CCPA/CPRA or another state law is a counsel judgment; this draft asserts no conclusion either way.",
          "No Global Privacy Control or opt-out-preference-signal handling is implemented in the product today; if counsel concludes a signal-honouring obligation applies at launch, that is a new fixed-scope product issue, not a drafting change.",
          "Whether the 'Do Not Sell or Share My Personal Information' link obligation applies, and where it must appear, is a counsel judgment tied to the sale/share conclusion.",
        ],
        assumptions: [
          {
            assertion:
              "The shipped landing-page analytics bridge adds no vendor SDK, vendor cookie, or third-party script to the page.",
            evidenceRef: "bounded-contexts/public-presence/docs/landing-page-analytics.md:5",
          },
        ],
      },
    },
    {
      id: "privacy-rights-and-requests",
      title: "Your privacy rights and how to make a request",
      draftText:
        "Depending on where you live, you may have rights over your personal information, such as the right to know what Chase Sets has collected about you, to access a copy of it, to correct it, to delete it, and to exercise those rights without being treated worse for doing so. You can submit a privacy request from your Account through a Support Request, or by writing to Chase Sets Limited, PO Box 164, Maize, KS 67101-0164, US, or to [NOTICE-EMAIL]. Chase Sets needs to confirm that a request comes from you, or from an agent you have authorized, before acting on it. [RIGHTS-VERIFICATION-AND-RESPONSE: counsel's operative description of the verification method, authorized-agent handling, response timing, and any appeal process will be stated here before this notice takes effect.] Independent of any request, your Wallet history, orders, and account records remain visible to you in your account area.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Describe the request intake that exists today (Support Request plus the #5677 mailing address) and reserve rights scope, verification, timing, and appeal for counsel.",
        decisionRefs: [5677, 5679],
        productTruthRefs: [
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:5-30",
          "bounded-contexts/settlement/routes/marketplace/account-desk-money.tsx:63-75",
        ],
        openQuestions: [
          "Which rights apply in which launch states, the verification standard per request type, authorized-agent handling, response timing, and any appeal path are counsel judgments.",
          "The shipped Support Request flow types are order-centric (product-not-received, return-request, payment-problem, and similar); no dedicated privacy-request flow type or self-service data-export surface exists today. If counsel requires a dedicated intake or export mechanism at launch, that is a new fixed-scope product issue.",
          "Internally, redaction machinery exists only for Customer Feedback data; fulfilling account-wide deletion requests has no shipped end-to-end mechanism and needs counsel-guided product work before rights language promises it.",
          "The notice email ([NOTICE-EMAIL]) remains a counsel-owned selection per #5677.",
        ],
        assumptions: [
          {
            assertion:
              "Account holders can already see their itemized Wallet ledger, payouts, and payout readiness in the account money area without filing a request.",
            evidenceRef: "bounded-contexts/settlement/routes/marketplace/account-desk-money.tsx:63-75",
          },
        ],
      },
    },
    {
      id: "retention",
      title: "How long Chase Sets keeps personal information",
      draftText:
        "Chase Sets keeps personal information for as long as it is needed for the purposes described in this notice and for legal, tax, audit, dispute, and security obligations, and then deletes, redacts, or de-identifies it. Where a shipped, versioned retention schedule exists, that schedule controls. Today that is true for customer feedback: survey response content and its direct identifiers are redacted 365 days after submission, invitation diagnostics after 90 days, and operator case notes 365 days after the case closes; follow-up delivery artifacts are deleted after 30 days and generated exports after 24 hours; and content-free structural audit facts are kept for 2,555 days (about seven years) to support security and compliance investigations. Marketplace money records work differently: Wallet ledger entries, including Wallet Adjustments, are permanent records that are never edited or deleted — a correction is posted as a new, linked, opposite-direction entry, so both the original and the correction stay visible in your history.",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the general retention principle, the one shipped versioned schedule (Customer Feedback), and the permanence of settlement ledger records; reserve sufficiency and everything unscheduled for counsel.",
        decisionRefs: [],
        productTruthRefs: [
          "bounded-contexts/customer-feedback/features/privacy/domain/policy.ts:16-24",
          "bounded-contexts/customer-feedback/features/privacy/domain/policy.ts:55-105",
          "bounded-contexts/customer-feedback/docs/privacy-and-retention.md:9-19",
          "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:37-39",
        ],
        openQuestions: [
          "No platform-wide retention schedule exists for account, order, listing, analytics-log, or backup data (the Customer Feedback policy explicitly does not introduce one); whether per-category retention periods must be disclosed, and whether the current posture is sufficient, is a counsel judgment.",
          "The event-sourced stores retain original event bytes even after projection-level redaction, with backups holding pre-redaction bytes until encrypted backup expiry; counsel owns whether that residual-history posture needs disclosure language or product change.",
          "Whether stating the permanent Wallet-ledger posture satisfies state-law retention-disclosure requirements for financial records is a counsel judgment.",
        ],
        assumptions: [
          {
            assertion:
              "The Customer Feedback retention schedule (365/365/90/365-day redactions, 30-day and 24-hour deletions, 2,555-day audit retention) is the only shipped versioned retention schedule, and it is scoped to Customer Feedback data only.",
            evidenceRef:
              "bounded-contexts/customer-feedback/features/privacy/domain/policy.ts:16-24; bounded-contexts/customer-feedback/docs/privacy-and-retention.md:5",
          },
        ],
      },
    },
    {
      id: "children",
      title: "Children",
      draftText:
        "The Chase Sets marketplace is for adults. Under the Terms of Service you must be at least 18 years old to create an Account, and Chase Sets does not offer services directed to children. Chase Sets does not ask for a date of birth at registration; the age requirement is a condition of the Terms of Service that Chase Sets relies on you to meet. [CHILDREN-STATEMENT: counsel's operative children's-privacy language, including any COPPA conclusion and the commitment Chase Sets makes if it learns it holds a child's personal information, will be stated here before this notice takes effect.]",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "State the adult-marketplace facts (18+ contractual requirement, no age gate) and reserve children's-privacy conclusions and commitments for counsel.",
        decisionRefs: [5679],
        productTruthRefs: [
          "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:370",
          "bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66",
        ],
        openQuestions: [
          "Children's-privacy language, including any COPPA applicability conclusion and the learn-and-delete commitment, is counsel-owned.",
          "Registration has no enforced age gate (no date-of-birth or age attestation is collected); the same gap is flagged in the Terms of Service eligibility subject as a possible pre-launch product decision.",
        ],
        assumptions: [
          {
            assertion:
              "The Terms of Service eligibility draft requires account holders to be at least 18; registration collects no age or date-of-birth field.",
            evidenceRef:
              "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:370; bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66",
          },
        ],
      },
    },
    {
      id: "state-supplements",
      title: "State-specific information",
      draftText:
        "Some U.S. states give their residents additional privacy rights and require additional, state-specific disclosures. The rights section above describes how to submit a request wherever you live. [STATE-SUPPLEMENTS: counsel's state-specific supplements — including any California notice-at-collection presentation of categories, sources, purposes, and recipients, and equivalent disclosures for the other states in the approved launch scope — will be stated here before this notice takes effect.]",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Reserve the state-supplement placement and content for counsel; the launch-state list is coupled to the undecided rollout scope in this artifact's metadata.",
        decisionRefs: [5679],
        productTruthRefs: [],
        openQuestions: [
          "Which states need supplements depends on the counsel-owned launch scope (metadata.rolloutJurisdictionsOrProductLimits is deliberately empty in this candidate).",
          "The category/source/purpose/recipient table format for California, and any state-specific defined-term usage, are counsel judgments; the data-categories, purposes, and recipients sections above are the product-truth inputs for that table.",
        ],
        assumptions: [],
      },
    },
    {
      id: "automated-decisionmaking-technology",
      title: "Automated decisions and human review",
      draftText:
        "Chase Sets uses a small set of automated rules to run the marketplace today. Registration screening can require an invitation while admission is invitation-gated and can screen disposable email domains. Sale-clearance rules decide whether a seller's sale credit matures on the base or the extended clearance schedule using qualifiers such as trusted-seller standing, manual review, zero reviews, high order value, and linked-risk clusters. Risk signals group accounts that share the same payment instrument or shipping address. People stay in the loop for consequential actions: a Wallet Adjustment must be requested by one authorized operator and approved by a different one, and a Support Request resolution can rest on an operator's finding as well as on deterministic policy. Stripe, not Chase Sets, decides payout-account verification outcomes under Stripe's own rules. Chase Sets does not currently use card-scanning or image-recognition technology to make decisions about you. The California Consumer Privacy Act regulations addressing automated decisionmaking technology became effective on January 1, 2026, and the relevant compliance obligation begins on January 1, 2027 for businesses whose use of automated decisionmaking technology is in scope. [ADMT-APPLICABILITY: counsel's conclusion on whether and how those regulations apply to Chase Sets, and any resulting pre-use notice, opt-out, or access rights, will be stated here before this notice takes effect.]",
      reviewStatus: "counsel-required",
      reviewManifest: {
        scopeNote:
          "Distinguish the shipped automated and human decision surfaces from unshipped #4929 scanning work, state the CPPA effective and compliance dates without asserting Chase Sets applicability, and reserve the applicability conclusion for counsel.",
        decisionRefs: [5679],
        productTruthRefs: [
          "bounded-contexts/auth/support/api-support/registration-gates.ts:4-25",
          "bounded-contexts/settlement/features/wallets/domain/clearance-policy.ts:5-18",
          "bounded-contexts/settlement/features/wallets/integrations/account-risk-source/account-risk-source-projection.ts:14-59",
          "docs/adr/0020-wallet-adjustment-authority-and-balance-types.md:65-66",
          "bounded-contexts/platform-operations/features/support-requests/domain/common.ts:74-79",
          "docs/adr/0006-stripe-connect-custom-account-experience.md:54",
        ],
        openQuestions: [
          "ADMT applicability to Chase Sets, the classification of the surfaces above under the ADMT definitions, and any resulting pre-use notice, opt-out, or access obligations are counsel judgments; this draft states timing only, per the two official CPPA sources.",
          "Card scanning (#4929) and any capability-registry work remain unshipped; if they ship before counsel review completes, this section must be redrafted before publication.",
        ],
        assumptions: [
          {
            assertion:
              "The CCPA updates rulemaking (including the ADMT regulations) became effective January 1, 2026, and the ADMT compliance obligation for in-scope businesses begins January 1, 2027.",
            evidenceRef:
              "official CPPA sources per issue #5689: https://cppa.ca.gov/announcements/2025/20250923.html and https://cppa.ca.gov/regulations/ccpa_updates.html",
          },
          {
            assertion:
              "No card-scanning or image-recognition decision surface exists in the codebase; issue #4929 remains unshipped.",
            evidenceRef: "issue #4929 (open)",
          },
        ],
      },
    },
  ],
};
