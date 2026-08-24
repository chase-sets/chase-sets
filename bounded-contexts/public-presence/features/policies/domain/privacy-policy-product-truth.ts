import type { PublicPolicyArtifact } from "./policy-artifact";

/**
 * The explicit classification registry that sits between the code-shape
 * product-truth inventory and the Privacy Policy candidate.
 *
 * Every derived source fact carries exactly one stable binding tuple:
 *
 *   factId -> { noticeBoundary, factFamily } -> exact evidence refs
 *          -> source-entailed factual summary -> consuming Privacy section ids
 *
 * The classification is a closed pair, and every default arm is failure:
 * missing, orphan, duplicate, multiply classified, unresolved, stale,
 * unknown-family, and unknown-boundary bindings are all violations. An
 * operator-only fact stays counsel-visible in the review manifest and is
 * proved OUTSIDE the consumer disclosure boundary rather than omitted.
 *
 * This module is pure data plus pure evaluation. It imports no Node built-in,
 * so the Privacy artifact — and therefore the /privacy route bundle — can
 * consume it. Derivation itself lives in
 * ../integrations/privacy-product-truth-inventory.mjs and runs only in tests
 * and the policy compiler.
 */

export const privacyNoticeBoundaries = ["consumer-notice", "operator-only"] as const;
export type PrivacyNoticeBoundary = (typeof privacyNoticeBoundaries)[number];

export const privacyFactFamilies = [
  "first-party-cookie",
  "web-storage",
  "provider-injected-client-storage",
  "cache-storage",
  "social-provider-profile",
] as const;
export type PrivacyFactFamily = (typeof privacyFactFamilies)[number];

export type PrivacyProductTruthClassification = Readonly<{
  noticeBoundary: PrivacyNoticeBoundary;
  factFamily: PrivacyFactFamily;
}>;

/**
 * Which Privacy section consumes a fact, and which derived tokens that
 * section's operative copy must actually disclose. Every required token must
 * itself be entailed by the derived inventory fact, so a disclosure
 * requirement can never be a hand-invented claim.
 */
export type PrivacyProductTruthDisclosure = Readonly<{
  sectionId: string;
  requiredTokens: readonly string[];
}>;

export type PrivacyProductTruthBinding = Readonly<{
  factId: string;
  classification: PrivacyProductTruthClassification;
  inventorySubject: string;
  evidenceRefs: readonly string[];
  factualSummary: string;
  disclosures: readonly PrivacyProductTruthDisclosure[];
}>;

export type PrivacyExternalClientPackageClassification = Readonly<{
  /**
   * `client-script-loader` means the package's job is to fetch and execute a
   * provider-controlled script in the visitor's browser, so the surfaces that
   * call it are provider-injected client-storage surfaces. `bundled-library`
   * means the package's code ships inside the Chase Sets bundle (or runs only
   * on the server) and injects no external script.
   */
  kind: "client-script-loader" | "bundled-library";
  reason: string;
  /** Absolute external origins the loader is permitted to fetch from, matched
   *  against committed CSP `script-src`/`frame-src` policy. */
  scriptOrigins?: readonly string[];
}>;

/**
 * Every non-workspace package imported by a consumer-route-reachable
 * production module must be classified here. A dependency added upstream
 * cannot default to handled: an unclassified package makes the inventory
 * indeterminate, which fails the binding integrity evaluation.
 */
export const privacyExternalClientPackageClassifications: Readonly<
  Record<string, PrivacyExternalClientPackageClassification>
> = {
  "@stripe/stripe-js": {
    kind: "client-script-loader",
    reason: "Stripe.js loader: fetches and executes Stripe's own browser script on the calling surface.",
    scriptOrigins: ["https://js.stripe.com"],
  },
  "@stripe/connect-js": {
    kind: "client-script-loader",
    reason:
      "Stripe Connect.js loader: fetches and executes Stripe's own embedded-component browser scripts on the calling surface.",
    scriptOrigins: ["https://connect-js.stripe.com", "https://js.stripe.com"],
  },
  "@aws-sdk/client-s3": {
    kind: "bundled-library",
    reason: "Server-side object-storage client; never reaches the browser.",
  },
  "@base-ui/react": {
    kind: "bundled-library",
    reason: "Headless React primitives bundled into the app; loads no external script.",
  },
  "@opentelemetry/api": { kind: "bundled-library", reason: "Server-side telemetry API; never reaches the browser." },
  "@opentelemetry/auto-instrumentations-node": {
    kind: "bundled-library",
    reason: "Node-only auto-instrumentation; never reaches the browser.",
  },
  "@opentelemetry/exporter-metrics-otlp-http": {
    kind: "bundled-library",
    reason: "Server-side OTLP metrics exporter; never reaches the browser.",
  },
  "@opentelemetry/exporter-trace-otlp-http": {
    kind: "bundled-library",
    reason: "Server-side OTLP trace exporter; never reaches the browser.",
  },
  "@opentelemetry/resources": {
    kind: "bundled-library",
    reason: "Server-side telemetry resource helper; never reaches the browser.",
  },
  "@opentelemetry/sdk-metrics": {
    kind: "bundled-library",
    reason: "Server-side telemetry SDK; never reaches the browser.",
  },
  "@opentelemetry/sdk-node": { kind: "bundled-library", reason: "Node-only telemetry SDK; never reaches the browser." },
  hono: { kind: "bundled-library", reason: "Server-side HTTP router; never reaches the browser." },
  "lucide-react": {
    kind: "bundled-library",
    reason: "Icon components bundled into the app; loads no external script.",
  },
  motion: { kind: "bundled-library", reason: "Animation library bundled into the app; loads no external script." },
  pg: { kind: "bundled-library", reason: "Server-side PostgreSQL driver; never reaches the browser." },
  react: { kind: "bundled-library", reason: "UI runtime bundled into the app; loads no external script." },
  "react-router": {
    kind: "bundled-library",
    reason: "Routing runtime bundled into the app; loads no external script.",
  },
  sharp: { kind: "bundled-library", reason: "Server-side image processing; never reaches the browser." },
  ulid: { kind: "bundled-library", reason: "Identifier helper bundled into the app; loads no external script." },
  zod: { kind: "bundled-library", reason: "Schema validation bundled into the app; loads no external script." },
};

const cookiesSection = "cookies-and-analytics";
const sourcesSection = "data-categories-and-sources";
const recipientsSection = "recipients-and-disclosures";

function cookieBinding(
  factId: string,
  subject: string,
  evidenceRefs: readonly string[],
  factualSummary: string,
): PrivacyProductTruthBinding {
  return {
    factId,
    classification: { noticeBoundary: "consumer-notice", factFamily: "first-party-cookie" },
    inventorySubject: subject,
    evidenceRefs,
    factualSummary,
    disclosures: [{ sectionId: cookiesSection, requiredTokens: [subject] }],
  };
}

/**
 * The complete binding set for the facts the current-source inventory derives.
 * Evidence refs are the exact code-shape-derived ranges the collector
 * resolved; an adjacent-but-resolving range is a stale-evidence violation, not
 * a near miss.
 */
export const privacyProductTruthBindings: readonly PrivacyProductTruthBinding[] = [
  cookieBinding(
    "cookie-session",
    "chase_sets_session",
    [
      "bounded-contexts/auth/support/auth-support/http.ts:87-90",
      "bounded-contexts/auth/support/auth-support/http.ts:94-97",
      "bounded-contexts/auth/support/request-support/cookies.ts:1",
      "contracts/auth-context/index.ts:3",
    ],
    "Auth sets and clears a first-party cookie named chase_sets_session that carries the signed-in session token, with its Max-Age derived from the server-issued expiry. Two tracked constants declare the same shipped name.",
  ),
  cookieBinding(
    "cookie-account-selection",
    "chase_sets_account_selection",
    [
      "bounded-contexts/auth/support/auth-support/http.ts:106-109",
      "bounded-contexts/auth/support/auth-support/http.ts:113-116",
      "bounded-contexts/auth/support/request-support/cookies.ts:2",
    ],
    "Auth sets and clears a first-party cookie named chase_sets_account_selection that carries the selected-account token.",
  ),
  cookieBinding(
    "cookie-guest-checkout",
    "chase_sets_guest_checkout",
    [
      "bounded-contexts/auth/support/auth-support/http.ts:120-123",
      "bounded-contexts/auth/support/request-support/cookies.ts:3",
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:5",
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:88",
    ],
    "Checkout sets and Auth clears a first-party cookie named chase_sets_guest_checkout carrying the guest-checkout token, with its Max-Age tracking the token's expiry. Two tracked constants declare the same shipped name.",
  ),
  cookieBinding(
    "cookie-anonymous-cart",
    "chase_sets_anonymous_cart",
    [
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:3",
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:64-67",
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:92",
    ],
    "Checkout sets and clears a first-party cookie named chase_sets_anonymous_cart that identifies a signed-out visitor's cart.",
  ),
  cookieBinding(
    "cookie-anonymous-sell-list",
    "chase_sets_anonymous_sell_list",
    [
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:4",
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:71-74",
      "bounded-contexts/checkout/support/request-support/guest-checkout.ts:96",
    ],
    "Checkout sets and clears a first-party cookie named chase_sets_anonymous_sell_list that identifies a signed-out visitor's sell list.",
  ),
  cookieBinding(
    "cookie-anonymous-saved-lists",
    "chase_sets_anonymous_saved_lists",
    [
      "bounded-contexts/collections/features/saved-lists/api/anonymous-cookie.ts:17-20",
      "bounded-contexts/collections/features/saved-lists/api/anonymous-cookie.ts:3",
    ],
    "Collections sets a first-party cookie named chase_sets_anonymous_saved_lists that identifies a signed-out visitor's saved lists.",
  ),
  cookieBinding(
    "cookie-anonymous-product-alerts",
    "chase_sets_anonymous_product_alerts",
    [
      "bounded-contexts/discovery/support/request-support/anonymous-product-alert.ts:3",
      "bounded-contexts/discovery/support/request-support/anonymous-product-alert.ts:53-56",
    ],
    "Discovery sets a first-party cookie named chase_sets_anonymous_product_alerts that identifies a signed-out visitor's product alerts.",
  ),
  cookieBinding(
    "cookie-anonymous-listing-drafts",
    "chase_sets_anonymous_listing_drafts",
    [
      "bounded-contexts/marketplace/support/request-support/anonymous-listing-draft.ts:3",
      "bounded-contexts/marketplace/support/request-support/anonymous-listing-draft.ts:54-57",
    ],
    "Marketplace sets a first-party cookie named chase_sets_anonymous_listing_drafts that identifies a signed-out visitor's listing drafts.",
  ),
  cookieBinding(
    "cookie-anonymous-reports",
    "chase_sets_anonymous_reports",
    [
      "bounded-contexts/marketplace/support/request-support/anonymous-listing-draft.ts:4",
      "bounded-contexts/marketplace/support/request-support/anonymous-listing-draft.ts:70-73",
    ],
    "Marketplace sets a first-party cookie named chase_sets_anonymous_reports that identifies a signed-out visitor's listing reports.",
  ),
  cookieBinding(
    "cookie-color-mode",
    "chase_sets_color_mode",
    [
      "bounded-contexts/identity/features/preferences/api/color-mode-cookie.ts:3",
      "bounded-contexts/identity/features/preferences/api/color-mode-cookie.ts:64",
    ],
    "Identity sets a first-party cookie named chase_sets_color_mode that carries the visitor's colour-mode preference.",
  ),

  {
    factId: "web-storage-recent-searches",
    classification: { noticeBoundary: "consumer-notice", factFamily: "web-storage" },
    inventorySubject: "chase-sets:marketplace:recent-searches",
    evidenceRefs: [
      "bounded-contexts/discovery/features/search/ui/header-search.tsx:173",
      "bounded-contexts/discovery/features/search/ui/header-search.tsx:197",
      "bounded-contexts/discovery/features/search/ui/header-search.tsx:205",
    ],
    factualSummary:
      "The header search box reads, writes, and removes a localStorage entry named chase-sets:marketplace:recent-searches holding the visitor's recent search terms.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["chase-sets:marketplace:recent-searches"] }],
  },
  {
    factId: "web-storage-theme-preference",
    classification: { noticeBoundary: "consumer-notice", factFamily: "web-storage" },
    inventorySubject: "chase-sets-theme",
    evidenceRefs: [
      "packages/design-system/src/theme/theme-toggle.tsx:54",
      "packages/design-system/src/theme/theme-toggle.tsx:70",
    ],
    factualSummary:
      "The theme toggle reads and writes a localStorage entry named chase-sets-theme holding the visitor's light/dark/system theme preference.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["chase-sets-theme"] }],
  },
  {
    factId: "web-storage-review-draft",
    classification: { noticeBoundary: "consumer-notice", factFamily: "web-storage" },
    inventorySubject: "chase-sets:review-draft:*",
    evidenceRefs: [
      "bounded-contexts/marketplace/features/reviews/ui/review-submission-page.tsx:101",
      "bounded-contexts/marketplace/features/reviews/ui/review-submission-page.tsx:127",
      "bounded-contexts/marketplace/features/reviews/ui/review-submission-page.tsx:161-164",
    ],
    factualSummary:
      "The review submission page reads, writes, and removes sessionStorage entries in the order-scoped chase-sets:review-draft: key family holding an unfinished review's rating, feedback text, and problem categories.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["chase-sets:review-draft:"] }],
  },
  {
    factId: "web-storage-search-restoration",
    classification: { noticeBoundary: "consumer-notice", factFamily: "web-storage" },
    inventorySubject: "discovery.search.restoration.v2",
    evidenceRefs: [
      "bounded-contexts/discovery/features/search/ui/search-scroll-restoration.ts:104",
      "bounded-contexts/discovery/features/search/ui/search-scroll-restoration.ts:107",
      "bounded-contexts/discovery/features/search/ui/search-scroll-restoration.ts:151",
      "bounded-contexts/discovery/features/search/ui/search-scroll-restoration.ts:56",
      "bounded-contexts/discovery/features/search/ui/search-scroll-restoration.ts:63",
    ],
    factualSummary:
      "Search restoration reads, writes, and removes a browser storage entry named discovery.search.restoration.v2 through an injected Pick<Storage, ...> seam. The stored value holds the result-set identity (search text, category, tag, language, market activity, price bounds, in-stock flag, sort, and dynamic filters), the scroll position, and a bounded number of already-fetched result pages.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["discovery.search.restoration.v2"] }],
  },
  {
    factId: "web-storage-search-loader-cache",
    classification: { noticeBoundary: "consumer-notice", factFamily: "web-storage" },
    inventorySubject: "discovery.search.loader-cache.v1",
    evidenceRefs: [
      "bounded-contexts/discovery/features/search/ui/search-loader-cache.ts:103",
      "bounded-contexts/discovery/features/search/ui/search-loader-cache.ts:141",
      "bounded-contexts/discovery/features/search/ui/search-loader-cache.ts:43",
      "bounded-contexts/discovery/features/search/ui/search-loader-cache.ts:50",
      "bounded-contexts/discovery/features/search/ui/search-loader-cache.ts:95",
    ],
    factualSummary:
      "The search loader cache reads, writes, and removes a browser storage entry named discovery.search.loader-cache.v1 through an injected Pick<Storage, ...> seam. The stored value holds a bounded, time-limited set of loader payloads keyed by the search URL that produced them.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["discovery.search.loader-cache.v1"] }],
  },
  {
    factId: "web-storage-operator-primary-workbench-selection",
    classification: { noticeBoundary: "operator-only", factFamily: "web-storage" },
    inventorySubject: "catalog.primaryWorkbench.observationSelection.*",
    evidenceRefs: [
      "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-selection-store.ts:58",
      "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-selection-store.ts:76",
      "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-selection-store.ts:79",
    ],
    factualSummary:
      "The Catalog primary workbench reads, writes, and removes sessionStorage entries in the catalog.primaryWorkbench.observationSelection. key family holding an operator's review working set. The surface is operator-only, so it sits outside the consumer notice boundary and stays a counsel-owned question.",
    disclosures: [],
  },

  {
    factId: "provider-loader-stripe-js-confirmation-card",
    classification: { noticeBoundary: "consumer-notice", factFamily: "provider-injected-client-storage" },
    inventorySubject:
      "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx",
    evidenceRefs: [
      "bounded-contexts/payments/features/payments/ui/account-payment/stripe-confirmation-card.tsx:172",
      "bounded-contexts/payments/package.json:42",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:7",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:9",
      "deployables/marketplace/package.json:34",
    ],
    factualSummary:
      "The payment confirmation card calls the Stripe.js loader, so Stripe's own browser script loads on /checkout/buy/session/:sessionId, /account/payments/:paymentId, and /checkout/payments/:paymentId. Payments and the Marketplace deployable declare @stripe/stripe-js@9.9.0, and the committed embedded-component CSP permits https://js.stripe.com for scripts and frames. Source entails only that the provider script loads on those surfaces and may use provider-controlled client-side storage.",
    disclosures: [
      {
        sectionId: cookiesSection,
        requiredTokens: [
          "/checkout/buy/session/:sessionId",
          "/account/payments/:paymentId",
          "/checkout/payments/:paymentId",
        ],
      },
    ],
  },
  {
    factId: "provider-loader-stripe-js-setup-card",
    classification: { noticeBoundary: "consumer-notice", factFamily: "provider-injected-client-storage" },
    inventorySubject:
      "@stripe/stripe-js@bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx",
    evidenceRefs: [
      "bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx:67",
      "bounded-contexts/payments/package.json:42",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:7",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:9",
      "deployables/marketplace/package.json:34",
    ],
    factualSummary:
      "The payment-method setup card calls the Stripe.js loader, so Stripe's own browser script loads on /account/payment-methods. Payments and the Marketplace deployable declare @stripe/stripe-js@9.9.0, and the committed embedded-component CSP permits https://js.stripe.com for scripts and frames. Source entails only that the provider script loads on that surface and may use provider-controlled client-side storage.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["/account/payment-methods"] }],
  },
  {
    factId: "provider-loader-connect-js-payout-setup-page",
    classification: { noticeBoundary: "consumer-notice", factFamily: "provider-injected-client-storage" },
    inventorySubject:
      "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
    evidenceRefs: [
      "bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx:62-67",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:7",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:9",
      "bounded-contexts/settlement/package.json:44",
    ],
    factualSummary:
      "The payout setup page calls the Stripe Connect.js loader, so Stripe's own embedded-component browser script loads on /account/desk/settings. Settlement declares @stripe/connect-js@3.4.5, and the committed embedded-component CSP permits https://connect-js.stripe.com and https://js.stripe.com for scripts and frames. Source entails only that the provider script loads on that surface and may use provider-controlled client-side storage.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["/account/desk/settings"] }],
  },
  {
    factId: "provider-loader-connect-js-notification-banner",
    classification: { noticeBoundary: "consumer-notice", factFamily: "provider-injected-client-storage" },
    inventorySubject:
      "@stripe/connect-js@bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx",
    evidenceRefs: [
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:7",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-csp.ts:9",
      "bounded-contexts/settlement/features/payout-readiness/ui/stripe-connect-notification-banner.tsx:89-101",
      "bounded-contexts/settlement/package.json:44",
    ],
    factualSummary:
      "The Stripe Connect notification banner calls the Stripe Connect.js loader, so Stripe's own embedded-component browser script loads on /account/desk/settings. Settlement declares @stripe/connect-js@3.4.5, and the committed embedded-component CSP permits https://connect-js.stripe.com and https://js.stripe.com for scripts and frames. Source entails only that the provider script loads on that surface and may use provider-controlled client-side storage.",
    disclosures: [{ sectionId: cookiesSection, requiredTokens: ["/account/desk/settings"] }],
  },

  {
    factId: "cache-storage-marketplace-pwa",
    classification: { noticeBoundary: "consumer-notice", factFamily: "cache-storage" },
    inventorySubject: "chase-sets-marketplace-pwa-v1",
    evidenceRefs: [
      "deployables/marketplace/app/pwa/service-worker-source.ts:34",
      "deployables/marketplace/app/pwa/service-worker-source.ts:8-24",
      "deployables/marketplace/app/root.tsx:220",
      "deployables/marketplace/app/routes/service-worker.ts:4",
    ],
    factualSummary:
      "The Marketplace deployable declares a typed service-worker policy whose CacheStorage cache is named chase-sets-marketplace-pwa-v1. The Marketplace root registers the worker, the worker is served from /service-worker.js, and registration happens only in production builds. The policy sets credentialedRequestHandling to skip and excludes the exact paths /guest-checkout/exit, /sign-in, /sign-out, and /register plus the path prefixes /api/, /account, /checkout, /payment, /payments, and /orders. These are technical facts about which responses the browser cache holds, not a legal classification.",
    disclosures: [
      { sectionId: cookiesSection, requiredTokens: ["chase-sets-marketplace-pwa-v1", "/service-worker.js"] },
    ],
  },
  {
    factId: "cache-storage-admin-pwa",
    classification: { noticeBoundary: "operator-only", factFamily: "cache-storage" },
    inventorySubject: "chase-sets-admin-pwa-v1",
    evidenceRefs: [
      "deployables/admin-web/app/pwa/service-worker-source.ts:41",
      "deployables/admin-web/app/pwa/service-worker-source.ts:8-31",
      "deployables/admin-web/app/root.tsx:40",
      "deployables/admin-web/app/routes/service-worker.ts:4",
    ],
    factualSummary:
      "The Admin deployable declares a typed service-worker policy whose CacheStorage cache is named chase-sets-admin-pwa-v1, registered by the Admin root and served from the Admin worker route. The Admin deployable is the operator surface, so this cache family sits outside the consumer notice boundary and stays a counsel-owned question.",
    disclosures: [],
  },

  {
    factId: "social-provider-google",
    classification: { noticeBoundary: "consumer-notice", factFamily: "social-provider-profile" },
    inventorySubject: "google",
    evidenceRefs: [
      "bounded-contexts/auth/support/social-login-support/providers.ts:165-174",
      "deployables/platform-api/src/main.ts:193-196",
    ],
    factualSummary:
      "A registered social-login provider named google maps a provider profile containing providerName, providerSubject, email, emailVerified, hostedDomain, displayName, givenName, and familyName. The platform API registers the provider executably.",
    disclosures: [
      { sectionId: sourcesSection, requiredTokens: ["google", "hostedDomain"] },
      { sectionId: recipientsSection, requiredTokens: ["google"] },
    ],
  },
  {
    factId: "social-provider-facebook",
    classification: { noticeBoundary: "consumer-notice", factFamily: "social-provider-profile" },
    inventorySubject: "facebook",
    evidenceRefs: [
      "bounded-contexts/auth/support/social-login-support/providers.ts:197-205",
      "deployables/platform-api/src/main.ts:201-204",
    ],
    factualSummary:
      "A registered social-login provider named facebook maps a provider profile containing providerName, providerSubject, email, emailVerified, displayName, givenName, and familyName. The platform API registers the provider executably.",
    disclosures: [
      { sectionId: sourcesSection, requiredTokens: ["facebook"] },
      { sectionId: recipientsSection, requiredTokens: ["facebook"] },
    ],
  },
];

/** The exact inventory-backed product-truth references a Privacy section
 *  cites, resolved through the binding tuples rather than typed twice. */
export function privacyProductTruthRefsForSection(sectionId: string): readonly string[] {
  return [
    ...new Set(
      privacyProductTruthBindings
        .filter((binding) => binding.disclosures.some((disclosure) => disclosure.sectionId === sectionId))
        .flatMap((binding) => binding.evidenceRefs),
    ),
  ].sort();
}

export function privacyProductTruthConsumingSectionIds(binding: PrivacyProductTruthBinding): readonly string[] {
  return [...new Set(binding.disclosures.map((disclosure) => disclosure.sectionId))].sort();
}

/**
 * Characterizations that a counsel-owned open question reserves. While the
 * question is unresolved, the exact phrase may appear only in the manifest
 * that reserves it — never in operative public prose. This is the
 * manifest/text consistency boundary for role language: the notice describes
 * providers by function, and the legal role stays visibly counsel-owned.
 */
export const privacyReservedCharacterizations = [
  {
    phrase: "service provider",
    reservedBySectionId: "recipients-and-disclosures",
    reason:
      "the N6 counsel question owns whether any provider is a 'service provider', 'contractor', 'processor', or an independent business",
  },
] as const;

export function evaluatePrivacyReservedCharacterizations(artifact: PublicPolicyArtifact): readonly string[] {
  const violations: string[] = [];
  for (const reserved of privacyReservedCharacterizations) {
    const needle = reserved.phrase.toLowerCase();
    for (const section of artifact.sections) {
      if (section.draftText.toLowerCase().includes(needle)) {
        violations.push(
          `Privacy section '${section.id}' uses the reserved characterization '${reserved.phrase}' in operative copy; ${reserved.reason}.`,
        );
      }
    }
    const reservingSection = artifact.sections.find((section) => section.id === reserved.reservedBySectionId);
    if (reservingSection === undefined) {
      violations.push(
        `Privacy is missing the section '${reserved.reservedBySectionId}' that reserves '${reserved.phrase}'.`,
      );
      continue;
    }
    if (!reservingSection.reviewManifest.openQuestions.some((question) => question.toLowerCase().includes(needle))) {
      violations.push(
        `Privacy section '${reserved.reservedBySectionId}' no longer carries the counsel question that reserves '${reserved.phrase}'.`,
      );
    }
  }
  return violations.sort();
}

// ---------------------------------------------------------------------------
// Binding integrity evaluation
// ---------------------------------------------------------------------------

export type PrivacyProductTruthInventoryFact = Readonly<{
  factFamily: string;
  subject: string;
  evidenceRefs: readonly string[];
  trackedGeneratedDerived?: boolean;
  detail: Readonly<Record<string, unknown>>;
}>;

export type PrivacyProductTruthInventory = Readonly<{
  facts: readonly PrivacyProductTruthInventoryFact[];
  indeterminate: readonly Readonly<{ factFamily: string; reason: string }>[];
  readFailures?: readonly Readonly<{ relativePath: string; reason: string }>[];
}>;

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The tokens a fact's own derived evidence entails. A binding may only require
 * a disclosure token drawn from this set, so a disclosure requirement can
 * never assert something the source does not support — in particular, no
 * provider storage name, write, duration, purpose, cookie category, or legal
 * role is derivable here.
 */
export function derivePrivacyDisclosureTokenUniverse(fact: PrivacyProductTruthInventoryFact): readonly string[] {
  const tokens = new Set<string>([fact.subject]);
  if (fact.subject.endsWith("*")) tokens.add(fact.subject.slice(0, -1));
  switch (fact.factFamily) {
    case "first-party-cookie":
      break;
    case "web-storage":
      for (const area of asStringArray(fact.detail.storageAreas)) tokens.add(area);
      break;
    case "provider-injected-client-storage":
      for (const route of asStringArray(fact.detail.consumerRoutes)) tokens.add(route);
      for (const origin of asStringArray(fact.detail.cspScriptOrigins)) tokens.add(origin);
      if (typeof fact.detail.providerPackage === "string") tokens.add(fact.detail.providerPackage);
      break;
    case "cache-storage":
      for (const value of asStringArray(fact.detail.excludedExactPaths)) tokens.add(value);
      for (const value of asStringArray(fact.detail.excludedPathPrefixes)) tokens.add(value);
      if (typeof fact.detail.workerRoutePath === "string") tokens.add(fact.detail.workerRoutePath);
      if (typeof fact.detail.credentialedRequestHandling === "string") {
        tokens.add(fact.detail.credentialedRequestHandling);
      }
      break;
    case "social-provider-profile":
      for (const field of asStringArray(fact.detail.mappedProfileFields)) tokens.add(field);
      break;
    default:
      return [];
  }
  return [...tokens].sort();
}

/** Case- and separator-insensitive containment, so a derived token such as
 *  `hostedDomain` is satisfied by the plain-language phrase "hosted domain"
 *  and a route token by its literal path. */
function normalizeForTokenMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function textDisclosesToken(text: string, token: string): boolean {
  const normalizedToken = normalizeForTokenMatch(token);
  return normalizedToken.length > 0 && normalizeForTokenMatch(text).includes(normalizedToken);
}

/**
 * The one binding-integrity evaluation. Returns a stable, sorted violation
 * list; an empty list is the only passing result.
 */
export function evaluatePrivacyProductTruthBindings(
  input: Readonly<{
    inventory: PrivacyProductTruthInventory;
    artifact: PublicPolicyArtifact;
    bindings?: readonly PrivacyProductTruthBinding[];
  }>,
): readonly string[] {
  const { inventory, artifact } = input;
  const bindings = input.bindings ?? privacyProductTruthBindings;
  const violations: string[] = [];

  for (const failure of inventory.readFailures ?? []) {
    violations.push(`unreadable tracked production module ${failure.relativePath}: ${failure.reason}`);
  }
  for (const entry of inventory.indeterminate) {
    violations.push(`unresolved product-truth derivation [${entry.factFamily}]: ${entry.reason}`);
  }

  const factsByKey = new Map(inventory.facts.map((fact) => [`${fact.factFamily} ${fact.subject}`, fact]));
  const sectionsById = new Map(artifact.sections.map((section) => [section.id, section]));
  const boundKeys = new Set<string>();
  const seenFactIds = new Set<string>();
  const classificationBySubject = new Map<string, string>();

  for (const binding of bindings) {
    const { factId, classification, inventorySubject } = binding;
    if (seenFactIds.has(factId)) {
      violations.push(`duplicate binding factId '${factId}'.`);
      continue;
    }
    seenFactIds.add(factId);

    if (!(privacyNoticeBoundaries as readonly string[]).includes(classification.noticeBoundary)) {
      violations.push(`binding '${factId}' declares unknown notice boundary '${classification.noticeBoundary}'.`);
      continue;
    }
    if (!(privacyFactFamilies as readonly string[]).includes(classification.factFamily)) {
      violations.push(`binding '${factId}' declares unknown fact family '${classification.factFamily}'.`);
      continue;
    }

    const classificationKey = `${classification.noticeBoundary}/${classification.factFamily}`;
    const previous = classificationBySubject.get(inventorySubject);
    if (previous !== undefined && previous !== classificationKey) {
      violations.push(
        `subject '${inventorySubject}' is multiply classified ('${previous}' and '${classificationKey}').`,
      );
    }
    classificationBySubject.set(inventorySubject, classificationKey);

    const key = `${classification.factFamily} ${inventorySubject}`;
    if (boundKeys.has(key)) {
      violations.push(`duplicate binding for ${classification.factFamily} subject '${inventorySubject}'.`);
    }
    boundKeys.add(key);

    const fact = factsByKey.get(key);
    if (fact === undefined) {
      violations.push(
        `orphan binding '${factId}': the inventory derives no ${classification.factFamily} subject '${inventorySubject}'.`,
      );
      continue;
    }

    const bindingRefs = [...binding.evidenceRefs].sort();
    const derivedRefs = [...fact.evidenceRefs].sort();
    if (bindingRefs.length !== derivedRefs.length || bindingRefs.some((ref, at) => ref !== derivedRefs[at])) {
      violations.push(
        `stale evidence on binding '${factId}': cited [${bindingRefs.join(", ")}] but the inventory derives [${derivedRefs.join(", ")}].`,
      );
    }

    if (fact.trackedGeneratedDerived === true) {
      violations.push(
        `binding '${factId}' rests on a tracked generated module; generated modules may reconcile a derived fact but may never be its evidence authority.`,
      );
    }

    if (binding.factualSummary.trim().length === 0) {
      violations.push(`binding '${factId}' has an empty factual summary.`);
    }

    const universe = new Set(derivePrivacyDisclosureTokenUniverse(fact));
    const consumingSectionIds = privacyProductTruthConsumingSectionIds(binding);

    if (classification.noticeBoundary === "consumer-notice" && consumingSectionIds.length === 0) {
      violations.push(`consumer-notice binding '${factId}' names no consuming Privacy section.`);
    }
    if (classification.noticeBoundary === "operator-only" && consumingSectionIds.length > 0) {
      violations.push(
        `operator-only binding '${factId}' names consuming Privacy section(s) [${consumingSectionIds.join(", ")}]; operator-only facts are proved outside the consumer disclosure boundary.`,
      );
    }

    for (const disclosure of binding.disclosures) {
      const section = sectionsById.get(disclosure.sectionId);
      if (section === undefined) {
        violations.push(`binding '${factId}' names unknown consuming section '${disclosure.sectionId}'.`);
        continue;
      }
      if (disclosure.requiredTokens.length === 0) {
        violations.push(`binding '${factId}' requires no disclosure token in section '${disclosure.sectionId}'.`);
      }
      for (const token of disclosure.requiredTokens) {
        if (!universe.has(token)) {
          violations.push(
            `binding '${factId}' requires disclosure token '${token}', which its derived evidence does not entail.`,
          );
          continue;
        }
        if (!textDisclosesToken(section.draftText, token)) {
          violations.push(
            `Privacy section '${disclosure.sectionId}' does not disclose '${token}' required by binding '${factId}'.`,
          );
        }
      }
    }

    if (classification.noticeBoundary === "operator-only") {
      const bare = binding.inventorySubject.endsWith("*")
        ? binding.inventorySubject.slice(0, -1)
        : binding.inventorySubject;
      for (const section of artifact.sections) {
        if (textDisclosesToken(section.draftText, bare)) {
          violations.push(
            `operator-only subject '${binding.inventorySubject}' appears in the operative copy of section '${section.id}'; it must stay outside the consumer disclosure boundary.`,
          );
        }
      }
      const counselVisible = artifact.sections.some((section) =>
        section.reviewManifest.openQuestions.some((question) => textDisclosesToken(question, bare)),
      );
      if (!counselVisible) {
        violations.push(
          `operator-only subject '${binding.inventorySubject}' is not counsel-visible in any Privacy review manifest open question.`,
        );
      }
    }
  }

  for (const fact of inventory.facts) {
    const key = `${fact.factFamily} ${fact.subject}`;
    if (!boundKeys.has(key)) {
      violations.push(
        `missing binding: the inventory derives ${fact.factFamily} subject '${fact.subject}' with no classification binding.`,
      );
    }
  }

  return violations.sort();
}
