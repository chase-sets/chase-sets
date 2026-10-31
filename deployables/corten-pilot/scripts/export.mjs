// Exports what the pilot's apps read from Chase Sets' own sources, so their copy, navigation and
// look cannot drift from the web hosts'. Every output is committed; CI runs this with --check.
//
// - admin/locales/en.json: the postage-policy screen's English catalog (ordering.features.postagePolicies.ui.*
//   and the route title), keys in the snake case `messages!` takes.
// - admin/locales/catalog.en.json: the catalog area's English catalog (the dimension, field and
//   catalog item pages, the shared list, detail, lifecycle, bulk lifecycle and realtime reload
//   controls, and the routes' titles).
// - admin/locales/operations.en.json: the platform section's English catalog: the Operations
//   Attention queue's (platformOperations.operationsAttention.*) and Projection Operations'
//   (platformOperations.projectionOperations.* as projections.*), and Support's Reported Content
//   (platformOperations.reportedContent.* as reported.*) and Risk Alerts (platformOperations.riskAlerts.*
//   as risk.*), Provider Connections'
//   (platformOperations.providerConnections.* as pc.*), Offer Economics' (platformOperations.offerEconomics.*
//   as oe.*), the Ops Dashboard's (platformOperations.opsDashboard.* as od.*), the Policy Console's
//   (platformOperations.policyConsole.* as policy.*) and Listing Evidence Policy's
//   (marketplace.features.listingEvidencePolicy.ui.* as lep.*).
// - admin/locales/access.en.json: the access section's English catalog: Access's home, the
//   accounts, users, memberships, invitations and API keys lists, an account's workspace (its
//   tabs, the detail pages' actions and the API key secret reveal), the identity value labels and
//   the routes' titles; and Auth's sessions list and session page (auth.features.sessions.ui.* as
//   sessions.* and session_detail.*, Auth's value labels as auth_value.*, and their titles from
//   adminAuthHostConfig as route.sessions and route.session).
// - admin/locales/commerce.en.json: the commerce section's English catalog: Return Intake's
//   (fulfillment.returnIntake.* as ri.*) and Recovered Returns' (inventory.features.recoveredItems.ui.page.*
//   as rr.*) and Commercial Terms' (commercialTerms.features.home.* as ct.*) and Settlement's Money
//   Health (settlement.features.payouts.ui.moneyHealthPage.* as mh.*) and Payout Operations
//   (settlement.features.payouts.ui.payoutOperationsPage.* as po.*), with the payout amount
//   headings both use (payout.*), and the Wallet Workbench (settlement.features.wallets.ui.walletWorkbenchPage.*
//   as ww.*, its guided flow, approval, reversal, copy and sign-in link as wa.flow.*, wa.approval.*,
//   wa.reversal.*, wa.copy.* and wa.reauth.*), and the routes' titles.
// - admin/locales/support.en.json: the support section's English catalog: Reference Lookup's page
//   (support.features.supportReferenceLookup.ui.supportReferenceLookupPage.* as lookup.*) and its
//   route's text (support.routes.admin.supportReferenceLookup.* as lookup_route.*), and the CSAT
//   dashboard's (experience.csatAdmin.* as csat.*), and Platform Feedback's (experience.platformFeedbackAdmin.*
//   as fb.*, its topics and workflows as fb_topic.* and fb_workflow.*, and its two route titles as
//   fb_route.*), and the Support operations workbench's (support.features.supportRequests.ui.supportOperationsPage.*
//   as ops.*, and its routes' text as ops_route.* and ops_detail_route.*), and the eBay
//   account-deletion lookup's (channels.ebayDeletion.* as ebay.*), and Customer Feedback's attention
//   queue's (customer-feedback.attention.* as cfa.*).
// - admin/support-responsibility-reasons.json: each support flow's responsibility reasons an
//   operator may choose (getSupportResponsibilityReasonDefinitions), while the ops detail read does
//   not return them.
// - admin/nav.json: admin-web's primary-nav contributions from every bounded context's context.json.
// - admin/defaults.json: the default postage policy (contracts/product-measures), which a new draft
//   starts from.
// - admin/reported-content-actions.json: each reported target type's moderation actions
//   (`platformOperationsReportedContentActionsByTargetType`), the buttons a target's page offers.
// - admin/scope-domains.json: the Catalog's scope product domains (`catalogScopeProductDomains`),
//   the scopes list's domain filter.
// - marketplace/locales/en.json: the storage-locations screen's English catalog
//   (inventory.features.storageLocations.ui.storageLocationPage.*, inventory.recovery.*, the route's
//   title and description).
// - marketplace/locales/restock.en.json: the restock decisions screen's English catalog
//   (inventory.features.restockDecisions.ui.queue.*, the route's title and description, and the
//   resource route's "could not be verified").
// - marketplace/locales/inventory.en.json: the inventory list's English catalog
//   (inventory.features.inventoryItems.ui.inventoryItemListPage.* as list.*, .offlineSaleForm.* as sale.*,
//   inventory.routes.marketplace.accountInventory.* as route.*, the item page's .inventoryItemDetailPage.*
//   as item.* and .accountInventoryItem.* as item_route.*, and the language labels).
// - marketplace/locales/cart.en.json: the cart page's English catalog (checkout.features.cart.ui.cartPage.*
//   and checkout.routes.accountCart.*, the route's title, description and messages, and the
//   language labels a line's badge uses).
// - marketplace/locales/sign_in.en.json: marketplace's sign-in, registration, magic-link landing and
//   account selection (auth.features.signIn.ui.signInPage.* as page.*,
//   auth.features.registration.ui.registerPage.* as register.*, the invitation's page
//   (auth.features.invitationAcceptance.ui.invitationAcceptancePage.* as invite.*,
//   auth.invitationAttempt.* as invite_attempt.*, and its title as invite_title), the auth host's and API's refusals as
//   host.*, password.*, phone.*, magic_api.* and gate.*, the magic-link landing as magic.*, the
//   account gate's context as context.*, account selection's refusals as selection_api.*, social
//   sign-in's refusals as social.*, and auth.features.accountSelection.ui.accountSelectionPage.*
//   as select.*).
// - marketplace/locales/sell_list.en.json: the Sell List page's English catalog
//   (checkout.features.sellList.ui.sellListPage.* as page.*, checkout.routes.accountSellList.* as route.*,
//   marketplace.features.listings.evidenceCoverage.* as coverage.*).
// - marketplace/locales/sell_checkout.en.json: seller checkout's English catalog
//   (checkout.features.sellList.ui.signedInSellCheckoutPage.* as signed.*, .guestSellCheckoutPage.* as guest.*,
//   checkout.routes.sellCheckoutSession.* as route.*, and checkout.shared.policyLinks.* as policy.*).
// - marketplace/locales/checkout.en.json: the buy checkout page's English catalog
//   (checkout.features.sessions.ui.checkoutPage.* as page.*, checkout.routes.checkoutSession.* as
//   route.*, checkout.routes.checkoutRecovery.* as recovery.*, checkout.shared.policyLinks.* as policy.*, and checkout
//   start's checkout.routes.checkoutStart.* as start.*).
// - marketplace/locales/item.en.json: the item page's English catalog (discovery.features.itemDetail.ui.itemDetailPage.*,
//   its page view's, product selector's, similar items' and market panel's, discovery.routes.itemDetail.*, the language
//   labels the details list uses, an item's display identity, and Collections' Add to List words,
//   collections.features.savedLists.ui.addToList.* and .api.route.*).
// - marketplace/locales/search.en.json: marketplace search's English catalog (discovery.features.search.ui.searchPage.*,
//   discovery.routes.search.*, the home page's discovery.features.home.ui.homeMerchandising.*, a set's page's
//   discovery.routes.set.*, and the listing card's, language labels' and display identity's words).
// - marketplace/locales/listing.en.json: a listing's public page's English catalog (discovery.routes.publicListing.*,
//   and the item page's words for a price without a currency).
// - marketplace/locales/account.en.json: an account's public page's English catalog (discovery.routes.publicAccount.*,
//   the account badges' words, and Reputation's review report and scoring context,
//   reputation.features.reviews.ui.reviewReportAction.* and .reviewScoringContext.*).
// - marketplace/locales/notifications.en.json: the notification center's English catalog
//   (notifications.features.notificationCenter.ui.page.* and .shell.*, and notifications.routes.accountNotifications.*).
// - marketplace/locales/orders.en.json: the account's order pages' English catalog
//   (ordering.features.orders.ui.orderListPage.*, .orderDetailPage.*, .moneyTimeline.*, .orderOutcome.* and
//   .orderReviewOpportunityCallout.*, and ordering.routes.accountPurchases.*, .accountPurchase.*, .accountSales.* and .accountSale.*).
// - marketplace/locales/imports.en.json: the inventory import page's English catalog
//   (inventory.features.importBatches.ui.importBatchPage.* as page.*, .api.route.* as api.*,
//   inventory.routes.marketplace.accountInventoryImports.* as route.*, and inventory.import.* as import.*).
// - marketplace/locales/shipments.en.json: the shipment pages' English catalog
//   (fulfillment.features.shipments.ui.shipmentListPage.* and .shipmentDetailPage.*, and
//   fulfillment.routes.marketplace.accountShipments.*, .accountShipment.* and .accountSaleShipment.*;
//   the packing page's .shipmentPackingPage.* as packing.* and .accountSaleShipmentPacking.* as
//   pack_route.*, and the packing slips' .packingSlipPage.* as slip.* and
//   .accountSaleShipmentPackingSlips.* as slips_route.*).
// - marketplace/locales/addresses.en.json: the shipping addresses page's English catalog
//   (identity.features.shippingAddresses.ui.shippingAddressPage.* and .errors.*, Identity's account-management
//   states and address choice, identity.accountManagement.*, the route's words,
//   identity.routes.marketplace.accountShippingAddresses.*, and identity.support.routeSupport.accountActionErrors.*).
// - marketplace/locales/account-home.en.json: the account's own page's English catalog
//   (identity.features.accounts.ui.accountProfilePage.* as page.*, .currentActorDisplayCue.* as actor.*,
//   .accountBadges.* as badges.*, the account types, statuses and membership roles Identity's value labels
//   use, their unrecognized words, Identity's account-management states, identity.accountManagement.*, as
//   manage.*, identity.support.routeSupport.accountActionErrors.* as action.*, and the route's title).
// - marketplace/locales/security.en.json: the security page's English catalog
//   (identity.features.apiKeys.ui.accountSecurityPage.* as page.*, .apiKeySecretReveal.* as reveal.*, the API
//   key statuses' words as key_status.*, the user name labels, the authentication methods, their families,
//   the unrecognized words, identity.accountManagement.* as manage.*, the action errors, and the route's title).
// - marketplace/locales/consents.en.json: the consent history page's English catalog
//   (identity.features.consents.ui.consentHistoryPage.* as page.*, the consent policies as policy.*,
//   the policy and status families, the version and date words and the unrecognized words as value.*,
//   identity.accountManagement.* as manage.*, the action errors, and the route's words as route.*).
// - marketplace/locales/reviews.en.json: the account's review pages' English catalog (Reputation's
//   accountReviewSummaryPage.* as summary.*, reviewListPage.* as list.*, reviewDetailPage.* as
//   detail.*, reviewDetailRecoveryPage.* as recover.*, reviewReportAction.* as report.*,
//   reviewScoringContext.* as scoring.*, the context-only explanation, the four routes' words as
//   route.summary.*, route.received.*, route.written.* and route.detail.*, and marketplace's
//   authored-text guidance and recovery as guidance.* and recovery.*).
// - marketplace/locales/team.en.json: the team page's English catalog
//   (identity.features.memberships.ui.accountTeamPage.* as page.*, the membership roles as role.*, the
//   membership and invitation statuses' words, their families and the unrecognized words as value.*,
//   identity.accountManagement.* as manage.*, the action errors, and the route's title).
// - marketplace/locales/sessions.en.json: the sessions pages' English catalog
//   (auth.features.sessions.ui.sessionListPage.* as list.*, .sessionDetailPage.* as detail.*, Auth's
//   session status family and unrecognized words as value.*, and Identity's authentication methods
//   with their family as method.*, which `authenticationMethodLabel` reads).
// - marketplace/locales/agents.en.json: the connected agents pages' English catalog
//   (auth.features.agentGrants.ui.agentGrantListPage.* as list.*, .agentGrantDetailPage.* as detail.*,
//   .agentConsentPage.* as consent.*, .agentGrantPresentation.* as presentation.*, and Auth's grant status
//   and activity outcome words with their families and the unrecognized words as value.*).
// - marketplace/agent-scopes.json: the scope families Auth recognizes (contracts/auth-context's
//   AGENT_OAUTH_KNOWN_SCOPE_FAMILIES), each family's label and its scopes' labels and descriptions, which
//   a grant's and a consent's scopes are listed by.
// - marketplace/locales/listing-new.en.json: Create listing's English catalog
// - marketplace/locales/seller-listing.en.json: the seller's listing page's English catalog
//   (marketplace.features.listings.ui.listingCreatePage.* as page.*, marketplace.routes.accountListingsNew.* as
//   route.*, the evidence checklist's marketplace.features.listings.ui.evidence.* and the API's coverage words
//   marketplace.features.listings.evidenceCoverage.* as coverage.*, and the authored-text guidance,
//   marketplace.features.reviews.ui.authoredTextGuidance.*, as guidance.*).
// - marketplace/locales/seller-listings.en.json: the seller's list of listings' English catalog
//   (marketplace.features.listings.ui.listingListPage.* as list.*, marketplace.routes.accountListings.* as
//   route.*, the listing API's refusals marketplace.features.listings.api.route.error.* as error.*, the seller
//   desk's degraded words, and the language labels).
// - marketplace/locales/desk.en.json: the Seller Desk home's English catalog (marketplace.features.sellerDesk.*,
//   and the channel words its summaries use: channels.manualSync.attention.* as manual.*,
//   channels.attention.reason.* as channel_reason.*, and the order counts).
// - marketplace/locales/money.en.json: the Seller Desk money page's English catalog
//   (settlement.features.moneyDashboard.ui.* as page.*, the payout words it shares as payout.*, a wallet
//   adjustment's account-facing status, direction and reason as adjustment_status.*, adjustment_direction.*
//   and reason.*, and contracts/http's money status labels as status.*, their codes' dashes as underscores).
// - marketplace/locales/payment.en.json: a buyer's payment page's English catalog
//   (payments.routes.marketplace.accountPayment.*, at the root).
// - marketplace/locales/payment_start.en.json: starting a payment for a buyer's orders again
//   (payments.routes.marketplace.accountPaymentNew.*, at the root).
// - marketplace/locales/payment_methods.en.json: the saved payment methods page's English catalog
//   (payments.routes.marketplace.accountPaymentMethods.*, at the root, and the secure step's words from
//   payments.routes.marketplace.accountPayment.* as step.*).
// - marketplace/locales/support.en.json: a Support Request participant page's English catalog
//   (support.features.supportRequests.ui.supportRequestDetailPage.* as page.*, the route's words as route.*,
//   the support operations page's deadline words as deadline.* and not_applicable, and
//   support.participantAttempt.* as attempt.*; the evidence and response types' dashes as underscores),
//   and the list page's: supportRequestListPage.* as list.*, customerRemedyStatus.* as remedy.*,
//   returnShipping.* as shipping.*, attachments.* as attachments.*, the support operations page's
//   resolution words as resolution.*, and support.routes.marketplace.accountSupport.* as list_route.*.
// - marketplace/locales/repricing.en.json: the Seller Desk repricing page's English catalog
//   (pricing.features.repricingPolicies.ui.{shared,policyList,editor,activity}.* as shared.*, list.*,
//   editor.* and activity.*, a policy's page's .policyDetail.*, .policyBody.* and .goal.* as detail.*,
//   body.* and goal.*, the route's words as route.*, bulk reprice's page and route as bulk.* and
//   bulk_route.*, the recommendations' page and route as recs.* and recs_route.*, and Pricing
//   Health's title).
// - marketplace/locales/channels.en.json: the channel screens' English catalog
//   (channels.connections.*, channels.publication.* and channels.manualSync.* as manual_sync.*).
// - marketplace/locales/offer-matches.en.json: the seller's offer matches' English catalog
// - marketplace/locales/submitted-offers.en.json: the buyer's submitted offers' English catalog
//   (marketplace.features.offers.ui.offerMatchListPage.* as list.*, .offerMatchDetailPage.* as detail.*,
//   .priceGap.* as gap.*, marketplace.routes.accountOfferMatch(es).* as route.* and routes.*, and the
//   managed offer states marketplace.marketFollowing.seller.* as managed.*).
// - public/locales/market.en.json: public-web's market page's English catalog (pricing.features.publicMarketPages.ui.marketPriceHistoryPage.*
//   and .routes.marketPriceHistory.*), with public-web's error and not-found words (publicPresence.appRoot.*).
// - public/locales/home.en.json: public-web's home and welcome pages' English catalog (publicPresence.home.*,
//   .waitlist.*, .nav.*, .footer.*, .faq.*, .routes.home.*, .welcome.*, .routes.welcome.* as route_welcome.*,
//   the brand and the footer's four agreement names).
// - public/locales/policy.en.json: the policy pages' English catalog (publicPresence.info.policies.* as
//   policies.*, .info.terms.* as terms.*, each document's eyebrow as eyebrow.*, and each policy route's
//   meta title and description as meta.*).
// - public/policies.json: the policy corpus as its pages draw it (features/policies/domain's
//   publicPolicyRegistry): each document's metadata, whether it is published (see policies()), and
//   each section's title, counsel badge, text (split at the links to sibling pages) and claim
//   disclosures.
// - public/help.json: the help center's articles as public-web compiles them (features/help/domain's
//   generated helpArticles: each article's place, title, description, review date, headings, blocks and
//   the policy values it cites) and the public policy value whitelist's types and value contracts, which
//   a live value is checked against before it is shown.
// - public/locales/help.en.json: the help center's English catalog (publicPresence.help.*).
// - public/developers.json: the developer portal (features/developer-portal's generated articles and
//   MCP tool catalog, the supported MCP protocol versions and the Agent Connector Terms' address).
// - public/locales/developers.en.json: the developer portal's English catalog
//   (publicPresence.developers.*).
// - public/locales/compare.en.json: the compare pages' and Contact's English catalog
//   (publicPresence.compare.*, each compare route's meta as meta.tcgplayer.* and meta.ebay.*,
//   .info.contact.* as contact.*, and Contact's meta as meta.contact.*).
// - public/favicon.svg: the design system's logo (chaseSetsLogoSvg), public-web's favicon. Not
//   committed (see GENERATED).
// - marketplace/favicon.svg: the same logo, marketplace-web's favicon. Not committed (see GENERATED).
// - marketplace/locales/site.en.json: marketplace-web's offline page and its web app manifest's
//   description (marketplace.app.routes.offline.* as offline.*, and
//   marketplace.app.routes.manifest.description as manifest_description).
// - marketplace/static/icons/: marketplace-web's four app icons (public/icons), which its manifest names.
// - admin/favicon.svg: the same logo, admin-web's favicon. Not committed (see GENERATED).
// - admin/locales/site.en.json: admin-web's offline page and its web app manifest's description
//   (adminWeb.app.routes.offline.* as offline.*, and adminWeb.app.routes.manifest.description as
//   manifest_description).
// - admin/static/icons/: admin-web's four app icons (public/icons), which its manifest names.
// - public/static/home/: public-web's home page's hero picture (three widths) and social cards.
// - marketplace/nav.json: marketplace-web's top-nav contributions, each group with its children.
// - platform/tokens.json: the design system's light and dark values (packages/design-system styles.css)
//   for the tokens the pilot uses, in the format of Corten's `tokens!`. Not committed (see GENERATED).
// - <app>/static/fonts/: the three @fontsource files the screens use, in each app's static folder.
//
// <app>/locales/pilot.en.json is each app's own text (its shell and input checks) and is not exported.
//
// Usage: node --import tsx deployables/corten-pilot/scripts/export.mjs [--check]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pilot = path.resolve(here, "..");
const repo = path.resolve(pilot, "../..");
const check = process.argv.includes("--check");
const apps = ["admin", "marketplace", "public"];

const snake = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * The entries of a localization catalog the rules pick, renamed: a rule is [prefix, name] for
 * every key under `prefix` (named `name.<rest>`, or `<rest>` for an empty name) or [key, name]
 * for one key.
 */
async function catalog(file, exportName, rules) {
  const all = (await import(pathToFileURL(path.join(repo, "contracts/localization/locales/en", file)).href))[
    exportName
  ];
  const out = {};
  for (const [key, text] of Object.entries(all)) {
    let name;
    for (const [match, rename] of rules) {
      if (match.endsWith(".") && key.startsWith(match)) {
        const rest = key.slice(match.length);
        name = rename ? `${rename}.${rest}` : rest;
      } else if (key === match) name = rename;
      if (name) break;
    }
    if (!name) continue;
    // An argument is {name} as the catalog has it; any other brace is text, which `messages!`
    // takes doubled.
    out[name.split(".").map(snake).join(".")] = text.replace(/\{([A-Za-z0-9_]+)\}|[{}]/g, (brace, arg) =>
      arg ? brace : brace + brace,
    );
  }
  return out;
}

/** Every bounded context's shell contributions to `deployable`'s `slot`. */
function contributions(deployable, slot) {
  const contexts = path.join(repo, "bounded-contexts");
  const items = [];
  for (const name of readdirSync(contexts).sort()) {
    const file = path.join(contexts, name, "context.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const item of manifest.shellContributions ?? []) {
      if (item.deployable === deployable && item.slot === slot) items.push({ context: name, item });
    }
  }
  return items;
}

const keep = (item) => ({
  key: item.key,
  label: item.label,
  ...(item.href ? { href: item.href } : {}),
  order: item.order,
  visibility: item.visibility ?? "signed-in",
  requiredPermissions: item.requiredPermissions ?? [],
  requiredPermissionsMatch: item.requiredPermissionsMatch ?? "all",
  excludedRoleKeys: item.excludedRoleKeys ?? [],
  ...(item.children ? { children: item.children.map(keep) } : {}),
});

function adminNav() {
  return contributions("admin-web", "primary-nav")
    .filter(({ item }) => item.section)
    .map(({ context, item }) => {
      if (item.parentKey)
        throw new Error(`${context}: ${item.key} has a parentKey, which the pilot's nav does not compose`);
      return { section: item.section, ...keep(item) };
    });
}

/** marketplace-web's top nav: the entries without a parent, each with the entries that name it. */
function marketplaceNav() {
  const all = contributions("marketplace-web", "top-nav").map(({ item }) => item);
  const keys = new Set(all.map((item) => item.key));
  for (const item of all) {
    if (item.parentKey && !keys.has(item.parentKey)) throw new Error(`${item.key}: no top-nav entry ${item.parentKey}`);
  }
  return all
    .filter((item) => !item.parentKey)
    .map((item) => {
      const children = [...(item.children ?? []), ...all.filter((child) => child.parentKey === item.key)];
      return keep({ ...item, ...(children.length ? { children } : {}) });
    });
}

// Token name in the pilot -> custom property in the design system. Dark values are the same
// property with a --dark- prefix.
const colors = {
  background: "background",
  surface: "card",
  "surface-2": "surface-2",
  "surface-3": "surface-3",
  border: "border",
  "border-strong": "border-strong",
  input: "input",
  ring: "ring",
  text: "foreground",
  "text-secondary": "text-secondary",
  "text-muted": "text-muted",
  primary: "primary",
  "primary-hover": "primary-hover",
  "primary-foreground": "primary-foreground",
  "primary-soft": "primary-soft",
  secondary: "secondary",
  "secondary-foreground": "secondary-foreground",
  success: "success",
  "success-soft": "success-soft",
  warning: "warning",
  "warning-soft": "warning-soft",
  danger: "danger",
  "danger-soft": "danger-soft",
  "danger-hover": "danger-hover",
  "danger-contrast": "danger-contrast",
  info: "info",
  "info-soft": "info-soft",
  overlay: "overlay",
  // The brand foil (BrandFoilText, the logo): public-web's home page title.
  "logo-start": "chase-logo-start",
  "logo-mid": "chase-logo-mid",
  "logo-end": "chase-logo-end",
};
const shadows = { sm: "shadow-sm", md: "shadow-md", lg: "shadow-lg", overlay: "shadow-overlay" };

function tokens() {
  const css = readFileSync(path.join(repo, "packages/design-system/src/styles/styles.css"), "utf8");
  const vars = new Map();
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (!vars.has(match[1])) vars.set(match[1], match[2].trim());
  }
  const value = (name) => {
    const found = vars.get(name);
    if (!found) throw new Error(`styles.css has no --${name}`);
    const alias = /^var\(--([a-z0-9-]+)\)$/.exec(found);
    return alias ? value(alias[1]) : found;
  };
  const scale = (map, prefix = "") =>
    Object.fromEntries(Object.entries(map).map(([token, name]) => [token, value(`${prefix}${name}`)]));
  const space = Object.fromEntries(Array.from({ length: 13 }, (_, n) => [String(n), value(`space-${n}`)]));
  return {
    breakpoints: { md: "48rem", lg: "64rem" },
    scales: {
      color: scale(colors),
      space,
      radius: { md: value("radius"), lg: value("radius-lg"), xl: value("radius-xl"), full: value("radius-full") },
      shadow: scale(shadows),
      font: { display: value("display-font"), body: value("body-font"), mono: value("mono-font") },
      control: { height: value("control-md-height"), px: value("control-md-px"), py: value("control-md-py") },
    },
    themes: {
      '[data-theme="dark"]': {
        "@media": { "(prefers-color-scheme: dark)": ':root:not([data-theme="light"])' },
        color: scale(colors, "dark-"),
        shadow: scale(shadows, "dark-"),
      },
    },
    utilities: { gap: { property: "gap", scale: "space" } },
  };
}

const fonts = [
  ["@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
  ["@fontsource/ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2"],
  ["@fontsource/space-grotesk", "space-grotesk-latin-600-normal.woff2"],
];

// public-web's home page's pictures (features/waitlist/ui/assets): the hero in its three widths
// and the social cards, in public/static/home/.
const homeAssets = [
  "chase-sets-prelaunch-hero-800w.webp",
  "chase-sets-prelaunch-hero-1200w.webp",
  "chase-sets-prelaunch-hero.webp",
  "chase-sets-og-default.png",
  "chase-sets-og-pokemon.png",
  "chase-sets-og-magic-the-gathering.png",
  "chase-sets-og-yu-gi-oh.png",
  "chase-sets-og-disney-lorcana.png",
  "chase-sets-og-one-piece-card-game.png",
  "chase-sets-og-founders.png",
];

// marketplace-web's and admin-web's app icons (deployables/<app>/public/icons), which their web app
// manifests name, in each pilot app's static/icons/.
const appIcons = [
  [
    "marketplace",
    "marketplace",
    ["chase-sets-192.png", "chase-sets-512.png", "chase-sets-maskable-192.png", "chase-sets-maskable-512.png"],
  ],
  [
    "admin-web",
    "admin",
    [
      "chase-sets-admin-192.png",
      "chase-sets-admin-512.png",
      "chase-sets-admin-maskable-192.png",
      "chase-sets-admin-maskable-512.png",
    ],
  ],
];

/** An article as the help center and the developer portal draw it. */
const article = (a) => ({
  slug: a.slug,
  locale: a.locale,
  title: a.title,
  description: a.description,
  audience: a.audience,
  category: a.category,
  reviewed_at: a.reviewedAt,
  href: a.href,
  headings: a.headings,
  blocks: a.blocks,
  policy_value_keys: a.policyValueKeys,
});

/**
 * The developer portal (features/developer-portal): its articles, the MCP tool catalog (each tool
 * as the manifest lists it, and its schemas as the page prints them), the protocol versions the
 * MCP endpoint supports, and the Agent Connector Terms' address.
 */
async function developers() {
  const load = (file) => import(pathToFileURL(path.join(repo, file)).href);
  const { developerArticles } = await load(
    "bounded-contexts/public-presence/features/developer-portal/domain/generated/articles.ts",
  );
  const { mcpToolCatalog } = await load(
    "bounded-contexts/public-presence/features/developer-portal/domain/generated/mcp-tool-catalog.ts",
  );
  const { SUPPORTED_MCP_PROTOCOL_VERSIONS } = await load("infrastructure/platform-runtime/mcp-protocol.ts");
  const { publicPolicyHrefsByKey } = await load("contracts/public-docs/policy-corpus.ts");
  return {
    articles: developerArticles.map(article),
    tools: mcpToolCatalog.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      available: tool.availability === "available",
      service: tool.serviceId,
      risk: tool.risk,
      scope: tool.permissionBoundary.scope,
      permissions: tool.permissionBoundary.requiredPermissions,
      scopes: tool.permissionBoundary.requiredScopes ?? [],
      usage: tool.expectedUsage,
      confirmation: tool.guardrails.confirmation.required,
      idempotency: tool.guardrails.idempotencyKey,
      dry_run: tool.guardrails.dryRunSupported,
      input_schema: JSON.stringify(tool.inputSchema, null, 2),
      output_schema: tool.outputSchema ? JSON.stringify(tool.outputSchema, null, 2) : null,
      manifest: tool,
    })),
    protocol_versions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
    agent_terms: publicPolicyHrefsByKey["agent-connector-terms"],
  };
}

/** The help center's articles and the whitelist their live values are checked against. */
async function help() {
  const { helpArticles } = await import(
    pathToFileURL(path.join(repo, "bounded-contexts/public-presence/features/help/domain/generated/articles.ts")).href
  );
  const { publicPolicyValueWhitelist } = await import(
    pathToFileURL(
      path.join(repo, "bounded-contexts/public-presence/features/help/domain/public-policy-value-whitelist.mjs"),
    ).href
  );
  return {
    articles: helpArticles.map(article),
    values: publicPolicyValueWhitelist.map((p) => ({
      key: p.key,
      type: p.type,
      ...(p.currency ? { currency: p.currency } : {}),
      contract: p.valueContract,
    })),
  };
}

/**
 * The policy corpus as policy-artifact-page.tsx draws it. Two of its rules are in that UI module,
 * which imports pictures Node cannot load, so they are repeated here: a document is published
 * only when it is ready and carries a valid effective date (resolvePolicyArtifactPublicationPosture),
 * and a section's text links its mentions of the sibling pages (linkPolicyReferences).
 */
async function policies() {
  const domain = (file) =>
    import(pathToFileURL(path.join(repo, "bounded-contexts/public-presence/features/policies/domain", file)).href);
  const { publicPolicyRegistry } = await domain("policy-registry.ts");
  const { evaluatePublicPolicyPublicationReadiness, isPublicPolicyEffectiveAt } = await domain("policy-artifact.ts");
  const { resolveUnresolvedPublicDisclosureText } = await domain("canonical-claims.ts");
  const references =
    /(?<![\w./@-])chasesets\.com\/(seller-agreement|payments-terms|agent-terms|authenticity-terms|privacy|founders)(?![\w/-]|\.\w)/g;
  const parts = (text) => {
    const out = [];
    let offset = 0;
    for (const match of text.matchAll(references)) {
      out.push({ text: text.slice(offset, match.index) });
      out.push({ text: match[0], href: `/${match[1]}` });
      offset = match.index + match[0].length;
    }
    out.push({ text: text.slice(offset) });
    return out.filter((part) => part.text.length > 0);
  };
  return publicPolicyRegistry.map(({ artifact, requiredSubjectIds }) => {
    const { metadata } = artifact;
    const published =
      evaluatePublicPolicyPublicationReadiness(artifact, requiredSubjectIds).ready &&
      isPublicPolicyEffectiveAt(metadata.effectiveAt);
    return {
      key: metadata.policyKey,
      href: metadata.href,
      version: metadata.version,
      locale: metadata.locale,
      title: artifact.title,
      description: artifact.description,
      effective_at: published ? metadata.effectiveAt : null,
      sections: artifact.sections.map((section) => ({
        id: section.id,
        title: section.title,
        counsel_required: section.reviewStatus === "counsel-required",
        text: section.draftText.trim().length > 0 ? parts(section.draftText) : [],
        disclosures: (section.claimDisclosures ?? []).map((disclosure) =>
          resolveUnresolvedPublicDisclosureText(disclosure.claimId),
        ),
      })),
    };
  });
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const { catalogScopeProductDomains } = await import(
  pathToFileURL(path.join(repo, "bounded-contexts/catalog/features/scope-registry/domain/contract.ts")).href
);
const { platformOperationsReportedContentActionsByTargetType } = await import(
  pathToFileURL(path.join(repo, "contracts/event-core/public-event-payloads/platform-operations.ts")).href
);
const { getSupportResponsibilityReasonDefinitions } = await import(
  pathToFileURL(
    path.join(repo, "bounded-contexts/platform-operations/features/support-requests/domain/responsibility.ts"),
  ).href
);
const { supportFlowCatalog } = await import(
  pathToFileURL(
    path.join(repo, "bounded-contexts/platform-operations/features/support-requests/domain/flow-catalog.ts"),
  ).href
);

/** Each flow's responsibility reasons an operator may choose, as the Resolve form offers them. */
function supportResponsibilityReasons() {
  return Object.fromEntries(
    supportFlowCatalog.map(({ flowType }) => [
      flowType,
      getSupportResponsibilityReasonDefinitions(flowType)
        .filter(({ operatorSelectable }) => operatorSelectable)
        .map(({ code, responsibility, operatorLabel }) => ({ code, responsibility, label: operatorLabel })),
    ]),
  );
}
const { defaultPostagePolicy } = await import(
  pathToFileURL(path.join(repo, "contracts/product-measures/index.ts")).href
);
const { AGENT_OAUTH_KNOWN_SCOPE_FAMILIES } = await import(
  pathToFileURL(path.join(repo, "contracts/auth-context/index.ts")).href
);
const agentScopes = AGENT_OAUTH_KNOWN_SCOPE_FAMILIES.map(({ family, label, scopes }) => ({
  family,
  label,
  scopes: scopes.map(({ scope, label, description }) => ({ scope, label, description })),
}));
const { adminAuthHostConfig } = await import(
  pathToFileURL(path.join(repo, "bounded-contexts/auth/support/route-support/host-config.ts")).href
);
const { moneyStatusLabels } = await import(pathToFileURL(path.join(repo, "contracts/http/money-status.ts")).href);
const outputs = [
  [
    "admin/locales/en.json",
    json(
      await catalog("ordering.ts", "orderingEnglishTranslations", [
        ["ordering.features.postagePolicies.ui.", ""],
        ["ordering.routes.admin.postagePolicies.title", "route.title"],
      ]),
    ),
  ],
  [
    "admin/locales/catalog.en.json",
    json(
      await catalog("catalog.ts", "catalogEnglishTranslations", [
        ["catalog.features.dimensions.ui.dimensionListPage.", "dimension_list"],
        ["catalog.features.dimensions.ui.dimensionDetailPage.", "dimension"],
        ["catalog.features.fields.ui.fieldListPage.", "field_list"],
        ["catalog.features.fields.ui.fieldDetailPage.", "field"],
        ["catalog.features.categories.ui.categoryListPage.", "category_list"],
        ["catalog.features.categories.ui.categoryDetailPage.", "category"],
        ["catalog.features.components.ui.componentListPage.", "component_list"],
        ["catalog.features.components.ui.componentDetailPage.", "component"],
        ["catalog.features.blueprints.ui.blueprintListPage.", "blueprint_list"],
        ["catalog.features.blueprints.ui.blueprintDetailPage.", "blueprint"],
        ["catalog.features.displayTemplates.ui.displayTemplateListPage.", "template_list"],
        ["catalog.features.displayTemplates.ui.displayTemplateDetailPage.", "template"],
        ["catalog.features.displayTemplates.ui.target.", "target"],
        ["catalog.features.referenceData.ui.referenceTypeListPage.", "ref_type_list"],
        ["catalog.features.referenceData.ui.referenceTypeDetailPage.", "ref_type"],
        ["catalog.features.referenceData.ui.referenceRecordListPage.", "ref_record_list"],
        ["catalog.features.referenceData.ui.referenceRecordDetailPage.", "ref_record"],
        ["catalog.features.referenceData.ui.referenceDataForm.", "ref_form"],
        ["catalog.support.shellSupport.ui.entityListPage.", "list"],
        ["catalog.support.shellSupport.ui.entityDetailPage.", "detail"],
        ["catalog.support.shellSupport.ui.lifecycleControls.", "lifecycle"],
        ["catalog.support.shellSupport.ui.bulkLifecycleActions.", "bulk"],
        ["catalog.support.shellSupport.ui.realtimeReloadActionBar.", "realtime"],
        ["catalog.support.shellSupport.ui.realtimeConnectionStatus.", "live_status"],
        ["catalog.features.sourceObservations.ui.scopeLanding.", "scopes"],
        ["catalog.features.sourceObservations.ui.scopeDetail.", "scope_detail"],
        ["catalog.features.sourceObservations.ui.detail.", "obs"],
        ["catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.", "coverage"],
        ["catalog.features.providerScopeMapping.ui.unmappedScopeInboxPage.", "inbox"],
        ["catalog.routes.admin.scopeCoverage.unmapped.scope.inbox.catalog.admin", "route.scope_inbox"],
        ["catalog.routes.admin.scopeCoverageDetail.scope.coverage.catalog.admin", "route.scope_coverage"],
        ["catalog.features.scopeSyncBatches.ui.", "ssb.ui"],
        ["catalog.features.scopeSyncBatches.count.", "ssb.count"],
        ["catalog.features.scopeSyncBatches.routes.", "ssb.routes"],
        ["catalog.features.sourceObservations.ui.aliasReview.action.", "alias_action"],
        ["catalog.features.attentionQueue.", "attention"],
        ["catalog.features.sourceObservations.ui.primaryWorkbench.command.feedback.", "feedback"],
        ["catalog.features.catalogItems.ui.catalogItemListPage.", "item_list"],
        ["catalog.features.catalogItems.ui.catalogItemDetailPage.", "item"],
        ["catalog.routes.admin.dimensions.dimensions.catalog.admin", "route.dimensions"],
        ["catalog.routes.admin.dimensionsDetail.dimension.catalog.admin", "route.dimension"],
        ["catalog.routes.admin.fields.fields.catalog.admin", "route.fields"],
        ["catalog.routes.admin.fieldsDetail.field.catalog.admin", "route.field"],
        ["catalog.routes.admin.categories.categories.catalog.admin", "route.categories"],
        ["catalog.routes.admin.categoriesDetail.category.catalog.admin", "route.category"],
        ["catalog.routes.admin.components.components.catalog.admin", "route.components"],
        ["catalog.routes.admin.componentsDetail.component.catalog.admin", "route.component"],
        ["catalog.routes.admin.blueprints.blueprints.catalog.admin", "route.blueprints"],
        ["catalog.routes.admin.blueprintsDetail.blueprint.catalog.admin", "route.blueprint"],
        ["catalog.routes.admin.displayTemplates.display.templates.catalog.admin", "route.templates"],
        ["catalog.routes.admin.displayTemplatesDetail.display.template.catalog.admin", "route.template"],
        ["catalog.routes.admin.referenceTypes.reference.types.catalog.admin", "route.ref_types"],
        ["catalog.routes.admin.referenceTypesDetail.reference.type.catalog.admin", "route.ref_type"],
        ["catalog.routes.admin.referenceRecords.reference.records.catalog.admin", "route.ref_records"],
        ["catalog.routes.admin.referenceRecordsDetail.reference.record.catalog.admin", "route.ref_record"],
        ["catalog.routes.admin.catalogItems.catalog.items.catalog.admin", "route.items"],
        ["catalog.routes.admin.catalogItemsDetail.catalog.item.catalog.admin", "route.item"],
        ["catalog.routes.admin.scopeLanding.scopes.catalog.admin", "route.scopes"],
        ["catalog.routes.admin.scopeDetail.scope.catalog.admin", "route.scope"],
        ["catalog.routes.admin.sourceObservationsDetail.named.title", "route.obs_named"],
        ["catalog.routes.admin.sourceObservationsDetail.source.observation.catalog.admin", "route.obs"],
      ]),
    ),
  ],
  [
    "admin/locales/operations.en.json",
    json({
      ...(await catalog("platform-operations.ts", "platformOperationsEnglishTranslations", [
        ["platformOperations.operationsAttention.", "attention"],
        ["platformOperations.projectionOperations.", "projections"],
        ["platformOperations.reportedContent.", "reported"],
        ["platformOperations.riskAlerts.", "risk"],
        ["platformOperations.providerConnections.", "pc"],
        ["platformOperations.offerEconomics.", "oe"],
        ["platformOperations.opsDashboard.", "od"],
        ["platformOperations.policyConsole.", "policy"],
      ])),
      ...(await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.listingEvidencePolicy.ui.", "lep"],
      ])),
    }),
  ],
  [
    "admin/locales/support.en.json",
    json({
      ...(await catalog("support.ts", "supportEnglishTranslations", [
        ["support.features.supportReferenceLookup.ui.supportReferenceLookupPage.", "lookup"],
        ["support.routes.admin.supportReferenceLookup.", "lookup_route"],
      ])),
      ...(await catalog("experience.ts", "experienceEnglishTranslations", [
        ["experience.csatAdmin.", "csat"],
        ["experience.platformFeedbackAdmin.", "fb"],
        ["experience.platformFeedback.topic.", "fb_topic"],
        ["experience.platformFeedback.workflow.", "fb_workflow"],
        ["experience.routes.admin.platformFeedback.platform.feedback.experience.admin", "fb_route.list"],
        ["experience.routes.admin.platformFeedbackDetail.platform.feedback.detail", "fb_route.detail"],
      ])),
      ...(await catalog("support.ts", "supportEnglishTranslations", [
        ["support.features.supportRequests.ui.supportOperationsPage.", "ops"],
        ["support.routes.admin.operationsQueue.", "ops_route"],
        ["support.routes.admin.operationsRequestDetail.", "ops_detail_route"],
        ["support.features.supportRequests.ui.attachments.", "att"],
      ])),
      ...(await catalog("channels.ts", "channelsEnglishTranslations", [["channels.ebayDeletion.", "ebay"]])),
      ...(await catalog("customer-feedback.ts", "customerFeedbackEnglishTranslations", [
        ["customer-feedback.attention.", "cfa"],
      ])),
    }),
  ],
  [
    "admin/locales/access.en.json",
    json({
      ...(await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.features.accessHub.ui.accessHome.", "home"],
        ["identity.features.accounts.ui.accountListPage.", "accounts"],
        ["identity.features.accounts.ui.accountBadges.", "badges"],
        ["identity.features.users.ui.userListPage.", "users"],
        ["identity.features.memberships.ui.membershipListPage.", "memberships"],
        ["identity.features.memberships.ui.role.", "role"],
        ["identity.features.invitations.ui.invitationListPage.", "invitations"],
        ["identity.features.apiKeys.ui.apiKeyListPage.", "api_keys"],
        ["identity.features.accessHub.ui.account.", "account"],
        ["identity.features.accounts.ui.accountDetailPage.", "account_detail"],
        ["identity.features.users.ui.userDetailPage.", "user_detail"],
        ["identity.features.memberships.ui.membershipDetailPage.", "membership_detail"],
        ["identity.features.memberships.ui.accountTeamPage.", "team"],
        ["identity.features.invitations.ui.invitationDetailPage.", "invitation_detail"],
        ["identity.features.apiKeys.ui.apiKeyDetailPage.", "api_key_detail"],
        ["identity.features.apiKeys.ui.apiKeySecretReveal.", "secret"],
        ["identity.values.accountType.", "account_type"],
        ["identity.values.authenticationMethod.", "method"],
        ["identity.values.role.platformAdmin", "role.platform_admin"],
        ["identity.values.family.", "family"],
        ["identity.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["identity.values.unrecognized", "value.unrecognized"],
        ["identity.values.date.unavailable", "value.date_unavailable"],
        ["identity.routes.admin.accessHome.access.identity.admin", "route.home"],
        ["identity.routes.admin.accounts.accounts.identity.admin", "route.accounts"],
        ["identity.routes.admin.users.users.identity.admin", "route.users"],
        ["identity.routes.admin.memberships.memberships.identity.admin", "route.memberships"],
        ["identity.routes.admin.invitations.invitations.identity.admin", "route.invitations"],
        ["identity.routes.admin.apiKeys.api.keys.identity.admin", "route.api_keys"],
        ["identity.routes.admin.accountsDetail.account.detail.identity.admin", "route.account"],
      ])),
      ...(await catalog("auth.ts", "authEnglishTranslations", [
        ["auth.features.sessions.ui.sessionListPage.", "sessions"],
        ["auth.features.sessions.ui.sessionDetailPage.", "session_detail"],
        ["auth.values.family.sessionStatus", "auth_value.family_session_status"],
        ["auth.values.unrecognized.withValue", "auth_value.unrecognized_with_value"],
        ["auth.values.unrecognized", "auth_value.unrecognized"],
        ["auth.values.date.unavailable", "auth_value.date_unavailable"],
      ])),
      "route.sessions": adminAuthHostConfig.titles.sessions,
      "route.session": adminAuthHostConfig.titles.sessionDetail,
    }),
  ],
  [
    "admin/locales/commerce.en.json",
    json({
      ...(await catalog("fulfillment.ts", "fulfillmentEnglishTranslations", [["fulfillment.returnIntake.", "ri"]])),
      ...(await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.recoveredItems.ui.page.", "rr"],
        ["inventory.routes.admin.recoveredItems.title", "rr.route_title"],
      ])),
      ...(await catalog("commercial-terms.ts", "commercialTermsEnglishTranslations", [
        ["commercialTerms.features.home.", "ct"],
        ["commercialTerms.support.requestSupport.adminLoaderError.commercial.terms.unavailable", "ct.load_unavailable"],
      ])),
      ...(await catalog("settlement.ts", "settlementEnglishTranslations", [
        ["settlement.features.payouts.ui.moneyHealthPage.", "mh"],
        ["settlement.features.payouts.ui.payoutOperationsPage.", "po"],
        ["settlement.features.payouts.ui.requestedAmount", "payout.requested_amount"],
        ["settlement.features.payouts.ui.payoutFee", "payout.fee"],
        ["settlement.features.payouts.ui.netPayout", "payout.net"],
        ["settlement.routes.admin.moneyHealth.money.health.settlement.admin", "mh.route_title"],
        ["settlement.routes.admin.payoutOperations.payout.operations.settlement.admin", "po.route_title"],
        ["settlement.features.wallets.ui.walletWorkbenchPage.", "ww"],
        ["settlement.features.wallets.ui.walletAdjustmentGuidedFlow.", "wa.flow"],
        ["settlement.features.wallets.ui.walletAdjustmentApprovalActions.", "wa.approval"],
        ["settlement.features.wallets.ui.walletAdjustmentReversalActions.", "wa.reversal"],
        ["settlement.features.wallets.ui.walletAdjustmentCopy.", "wa.copy"],
        ["settlement.features.wallets.ui.walletAdjustmentReauthenticationLink.", "wa.reauth"],
        ["settlement.routes.admin.walletWorkbench.wallet.workbench.settlement.admin", "ww.route_title"],
      ])),
    }),
  ],
  [
    "admin/locales/growth.en.json",
    json({
      ...(await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [
        ["publicPresence.admin.", "admin"],
        ["publicPresence.waitlist.role.", "role"],
        ["publicPresence.waitlist.interest.", "interest"],
        ["publicPresence.waitlist.game.", "game"],
        ["publicPresence.waitlist.inventorySize.", "inventory_size"],
        ["publicPresence.promoBar.", "promo"],
        ["publicPresence.routes.admin.waitlist.meta.title", "route.waitlist"],
        ["publicPresence.routes.admin.campaignAnalytics.meta.title", "route.campaign_analytics"],
        ["publicPresence.routes.admin.promoBar.meta.title", "route.promo_bar"],
      ])),
      // Google Shopping's page copy; the API's and the sync job's own messages stay in Discovery.
      ...(await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.googleShoppingOperations.api.", ""],
        ["discovery.googleShoppingOperations.sync.", ""],
        ["discovery.googleShoppingOperations.", "gs"],
      ]).then((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith("gs."))))),
    }),
  ],
  ["admin/nav.json", json(adminNav())],
  ["admin/defaults.json", json(defaultPostagePolicy)],
  ["admin/scope-domains.json", json(catalogScopeProductDomains)],
  ["admin/reported-content-actions.json", json(platformOperationsReportedContentActionsByTargetType)],
  ["admin/support-responsibility-reasons.json", json(supportResponsibilityReasons())],
  [
    "marketplace/locales/en.json",
    json(
      await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.storageLocations.ui.storageLocationPage.", "page"],
        ["inventory.recovery.", "recovery"],
        ["inventory.routes.marketplace.accountInventoryLocations.inventory.locations.marketplace", "route.title"],
        [
          "inventory.routes.marketplace.accountInventoryLocations.manage.the.storage.locations.and.ship",
          "route.description",
        ],
      ]),
    ),
  ],
  [
    "marketplace/locales/restock.en.json",
    json({
      ...(await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.restockDecisions.ui.queue.", "queue"],
        ["inventory.routes.marketplace.accountInventoryRestockDecisions.title", "route.title"],
        ["inventory.routes.marketplace.accountInventoryRestockDecisions.description", "route.description"],
      ])),
      // What marketplace's resource route says when the read after a write fails for good.
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.routeResource.unverified", "unverified"],
      ])),
    }),
  ],
  [
    "marketplace/locales/inventory.en.json",
    json({
      ...(await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.inventoryItems.ui.inventoryItemListPage.", "list"],
        ["inventory.features.inventoryItems.ui.offlineSaleForm.", "sale"],
        ["inventory.routes.marketplace.accountInventory.", "route"],
        ["inventory.features.inventoryItems.ui.inventoryItemDetailPage.", "item"],
        ["inventory.routes.marketplace.accountInventoryItem.", "item_route"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
      ])),
    }),
  ],
  [
    "marketplace/locales/imports.en.json",
    json(
      await catalog("inventory.ts", "inventoryEnglishTranslations", [
        ["inventory.features.importBatches.ui.importBatchPage.", "page"],
        ["inventory.routes.marketplace.accountInventoryImports.", "route"],
        ["inventory.import.", "import"],
        ["inventory.features.importBatches.api.route.", "api"],
        ["inventory.features.inventoryItems.ui.inventoryItemListPage.create.listing", "list.create.listing"],
      ]),
    ),
  ],
  [
    "marketplace/locales/cart.en.json",
    json({
      ...(await catalog("checkout.ts", "checkoutEnglishTranslations", [
        ["checkout.features.cart.ui.cartPage.", "page"],
        ["checkout.routes.accountCart.", "route"],
      ])),
      // A line's language badge (`formatLanguageCodeLabel`).
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
      ])),
    }),
  ],
  [
    "marketplace/locales/sell_list.en.json",
    json({
      ...(await catalog("checkout.ts", "checkoutEnglishTranslations", [
        ["checkout.features.sellList.ui.sellListPage.", "page"],
        ["checkout.routes.accountSellList.", "route"],
      ])),
      // A listing's unmet evidence codes (`evidenceCoverageCodeLocaleKey`).
      ...(await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.listings.evidenceCoverage.", "coverage"],
      ])),
    }),
  ],
  [
    "marketplace/locales/sell_checkout.en.json",
    json({
      ...(await catalog("checkout.ts", "checkoutEnglishTranslations", [
        ["checkout.features.sellList.ui.signedInSellCheckoutPage.", "signed"],
        ["checkout.features.sellList.ui.guestSellCheckoutPage.", "guest"],
        ["checkout.routes.sellCheckoutSession.", "route"],
        ["checkout.shared.policyLinks.", "policy"],
      ])),
    }),
  ],
  [
    "marketplace/locales/sign_in.en.json",
    json({
      ...(await catalog("auth.ts", "authEnglishTranslations", [
        ["auth.features.signIn.ui.signInPage.", "page"],
        ["auth.features.registration.ui.registerPage.", "register"],
        ["auth.features.invitationAcceptance.ui.invitationAcceptancePage.", "invite"],
        ["auth.invitationAttempt.", "invite_attempt"],
        ["auth.routes.marketplace.invite.meta.title", "invite_title"],
        ["auth.support.routeSupport.authHost.", "host"],
        ["auth.support.routeSupport.magicLinkLanding.", "magic"],
        ["auth.support.apiSupport.passwordRoutes.", "password"],
        ["auth.support.apiSupport.phoneCodeRoutes.", "phone"],
        ["auth.support.apiSupport.magicLinkRoutes.", "magic_api"],
        ["auth.support.apiSupport.registrationGates.", "gate"],
        ["auth.support.apiSupport.accountSelectionRoutes.", "selection_api"],
        ["auth.support.apiSupport.socialLoginRoutes.", "social"],
        ["auth.support.apiSupport.support.authentication.required", "social.authentication.required"],
        ["auth.routes.marketplace.accountGate.", "context"],
        ["auth.features.accountSelection.ui.accountSelectionPage.", "select"],
      ])),
      // A social sign-in that found the display name taken (`socialLoginErrorMessage`'s identity_conflict).
      ...(await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.api.display.name.already.taken", "social.identity.conflict"],
      ])),
    }),
  ],
  [
    "marketplace/locales/checkout.en.json",
    json(
      await catalog("checkout.ts", "checkoutEnglishTranslations", [
        ["checkout.features.sessions.ui.checkoutPage.", "page"],
        ["checkout.routes.checkoutSession.", "route"],
        ["checkout.routes.checkoutRecovery.", "recovery"],
        ["checkout.shared.policyLinks.", "policy"],
        ["checkout.features.sessions.ui.buyCheckoutConfirmationPage.", "confirmation"],
        ["checkout.routes.buyCheckoutConfirmation.", "confirmation_route"],
        ["checkout.routes.checkoutStart.", "start"],
      ]),
    ),
  ],
  [
    "marketplace/locales/item.en.json",
    json({
      ...(await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.features.itemDetail.ui.itemDetailPage.", "page"],
        ["discovery.features.itemDetail.ui.itemDetailPageView.", "view"],
        ["discovery.features.itemDetail.ui.productSelector.", "selector"],
        ["discovery.features.itemDetail.ui.similarItems.", "similar"],
        ["discovery.features.itemDetail.ui.marketPanel.", "panel"],
        ["discovery.routes.itemDetail.", "route"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
        // A similar item's picture's words (`formatDisplayIdentity`).
        ["localization.displayIdentity.", "identity"],
      ])),
      // Add to List (`AddToSavedListControl`) and the Collections API's refusals.
      ...(await catalog("collections.ts", "collectionsEnglishTranslations", [
        ["collections.features.savedLists.ui.addToList.", "saved"],
        ["collections.features.savedLists.api.route.", "saved_api"],
      ])),
    }),
  ],
  [
    "marketplace/locales/search.en.json",
    json({
      ...(await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.features.search.ui.searchPage.", "page"],
        ["discovery.routes.search.", "route"],
        // The home page's featured categories and new arrivals (`HomeMerchandising`).
        ["discovery.features.home.ui.homeMerchandising.", "home"],
        // A set's page (`routes/set.tsx`), whose cards are search's.
        ["discovery.routes.set.", "set"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        // A result's card (`ListingCard`), its language badge and its picture's words.
        ["localization.listingCard.", "card"],
        ["localization.languageCode.", "language"],
        ["localization.displayIdentity.", "identity"],
      ])),
    }),
  ],
  [
    "marketplace/locales/listing.en.json",
    json(
      await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.routes.publicListing.", "page"],
        // A listing without a currency's price (the item page's words, which the listing page uses).
        ["discovery.features.itemDetail.ui.itemDetailPageView.market.price.unavailable", "price_unavailable"],
      ]),
    ),
  ],
  [
    "marketplace/locales/account.en.json",
    json({
      ...(await catalog("discovery.ts", "discoveryEnglishTranslations", [
        ["discovery.routes.publicAccount.", "page"],
        // The trusted seller and founder badges (`features/item-detail/ui/account-badges.tsx`).
        ["discovery.features.itemDetail.ui.accountBadges.", "badges"],
        // A listing without a currency's price (the item page's words).
        ["discovery.features.itemDetail.ui.itemDetailPageView.market.price.unavailable", "price_unavailable"],
      ])),
      ...(await catalog("reputation.ts", "reputationEnglishTranslations", [
        // Report review and how a review counts (marketplace's `features/reviews/ui`).
        ["reputation.features.reviews.ui.reviewReportAction.", "report"],
        ["reputation.features.reviews.ui.reviewScoringContext.", "scoring"],
      ])),
    }),
  ],
  [
    "marketplace/locales/notifications.en.json",
    json(
      await catalog("notifications.ts", "notificationsEnglishTranslations", [
        ["notifications.features.notificationCenter.ui.page.", "page"],
        ["notifications.features.notificationCenter.ui.shell.", "shell"],
        ["notifications.routes.accountNotifications.", "route"],
      ]),
    ),
  ],
  [
    "marketplace/locales/orders.en.json",
    json(
      await catalog("ordering.ts", "orderingEnglishTranslations", [
        ["ordering.features.orders.ui.orderListPage.", "list"],
        ["ordering.features.orders.ui.orderDetailPage.", "detail"],
        ["ordering.features.orders.ui.moneyTimeline.", "money"],
        ["ordering.features.orders.ui.orderOutcome.", "outcome"],
        ["ordering.features.orders.ui.orderReviewOpportunityCallout.", "callout"],
        ["ordering.routes.accountPurchases.", "purchases"],
        ["ordering.routes.accountPurchase.", "purchase"],
        ["ordering.routes.accountSales.", "sales"],
        ["ordering.routes.accountSale.", "sale"],
      ]),
    ),
  ],
  [
    "marketplace/locales/shipments.en.json",
    json(
      await catalog("fulfillment.ts", "fulfillmentEnglishTranslations", [
        ["fulfillment.features.shipments.ui.shipmentListPage.", "list"],
        ["fulfillment.features.shipments.ui.shipmentDetailPage.", "detail"],
        ["fulfillment.routes.marketplace.accountShipments.", "shipments"],
        ["fulfillment.routes.marketplace.accountShipment.", "shipment"],
        ["fulfillment.routes.marketplace.accountSaleShipment.", "sale_shipment"],
        ["fulfillment.features.shipments.ui.shipmentPackingPage.", "packing"],
        ["fulfillment.routes.marketplace.accountSaleShipmentPacking.", "pack_route"],
        ["fulfillment.features.shipments.ui.packingSlipPage.", "slip"],
        ["fulfillment.routes.marketplace.accountSaleShipmentPackingSlips.", "slips_route"],
      ]),
    ),
  ],
  [
    "marketplace/locales/addresses.en.json",
    json(
      await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.features.shippingAddresses.ui.shippingAddressPage.", "page"],
        ["identity.features.shippingAddresses.errors.", "errors"],
        ["identity.accountManagement.", "manage"],
        ["identity.routes.marketplace.accountShippingAddresses.", "route"],
        ["identity.support.routeSupport.accountActionErrors.", "action"],
      ]),
    ),
  ],
  [
    "marketplace/locales/account-home.en.json",
    json(
      await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.features.accounts.ui.accountProfilePage.", "page"],
        ["identity.features.accounts.ui.currentActorDisplayCue.", "actor"],
        ["identity.features.accounts.ui.accountBadges.", "badges"],
        ["identity.values.accountType.", "account_type"],
        ["identity.features.accounts.ui.accountListPage.status.filter.", "status"],
        ["identity.features.memberships.ui.role.", "role"],
        ["identity.values.role.platformAdmin", "role.platform_admin"],
        ["identity.values.family.accountType", "family.account_type"],
        ["identity.values.family.accountStatus", "family.account_status"],
        ["identity.values.family.membershipRole", "family.membership_role"],
        ["identity.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["identity.values.unrecognized", "value.unrecognized"],
        ["identity.values.date.unavailable", "value.date_unavailable"],
        ["identity.accountManagement.", "manage"],
        ["identity.support.routeSupport.accountActionErrors.", "action"],
        ["identity.routes.marketplace.account.account.marketplace", "route.title"],
      ]),
    ),
  ],
  [
    "marketplace/locales/security.en.json",
    json(
      await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.features.apiKeys.ui.accountSecurityPage.", "page"],
        ["identity.features.apiKeys.ui.apiKeySecretReveal.", "reveal"],
        ["identity.features.apiKeys.ui.apiKeyListPage.status.filter.active", "key_status.active"],
        ["identity.features.apiKeys.ui.apiKeyListPage.status.filter.revoked", "key_status.revoked"],
        ["identity.features.users.ui.userDetailPage.display.name", "user.display_name"],
        ["identity.features.users.ui.userDetailPage.given.name", "user.given_name"],
        ["identity.features.users.ui.userDetailPage.family.name", "user.family_name"],
        ["identity.values.authenticationMethod.", "method"],
        ["identity.values.family.apiKeyStatus", "family.api_key_status"],
        ["identity.values.family.authenticationMethod", "family.authentication_method"],
        ["identity.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["identity.values.unrecognized", "value.unrecognized"],
        ["identity.values.date.unavailable", "value.date_unavailable"],
        ["identity.accountManagement.", "manage"],
        ["identity.support.routeSupport.accountActionErrors.", "action"],
        ["identity.routes.marketplace.accountSecurity.security.marketplace", "route.title"],
      ]),
    ),
  ],
  [
    "marketplace/locales/reviews.en.json",
    json({
      ...(await catalog("reputation.ts", "reputationEnglishTranslations", [
        ["reputation.features.reviews.ui.accountReviewSummaryPage.", "summary"],
        ["reputation.features.reviews.ui.reviewListPage.", "list"],
        ["reputation.features.reviews.ui.reviewDetailPage.", "detail"],
        ["reputation.features.reviews.ui.reviewDetailRecoveryPage.", "recover"],
        ["reputation.features.reviews.ui.reviewReportAction.", "report"],
        ["reputation.features.reviews.ui.reviewScoringContext.", "scoring"],
        ["reputation.features.reviews.ui.context.only.rating.explanation", "context_only"],
        ["reputation.routes.marketplace.accountReviewSummary.", "route.summary"],
        ["reputation.routes.marketplace.accountReceivedReviews.", "route.received"],
        ["reputation.routes.marketplace.accountWrittenReviews.", "route.written"],
        ["reputation.routes.marketplace.accountReview.", "route.detail"],
        ["reputation.features.reviews.ui.reviewSubmissionPage.", "write"],
        ["reputation.routes.marketplace.accountPurchaseReview.", "route.purchase_review"],
        ["reputation.routes.marketplace.accountSaleReview.", "route.sale_review"],
      ])),
      ...(await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.reviews.ui.authoredTextGuidance.", "guidance"],
        ["marketplace.features.reviews.ui.authoredTextRecovery.", "recovery"],
      ])),
    }),
  ],
  [
    "marketplace/locales/consents.en.json",
    json(
      await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.features.consents.ui.consentHistoryPage.", "page"],
        ["identity.values.consentPolicy.", "policy"],
        ["identity.values.family.consentPolicy", "family.consent_policy"],
        ["identity.values.family.consentStatus", "family.consent_status"],
        ["identity.values.version.unavailable", "value.version_unavailable"],
        ["identity.values.version", "value.version"],
        ["identity.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["identity.values.unrecognized", "value.unrecognized"],
        ["identity.values.date.unavailable", "value.date_unavailable"],
        ["identity.accountManagement.", "manage"],
        ["identity.support.routeSupport.accountActionErrors.", "action"],
        ["identity.routes.marketplace.accountConsents.", "route"],
      ]),
    ),
  ],
  [
    "marketplace/locales/team.en.json",
    json(
      await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.features.memberships.ui.accountTeamPage.", "page"],
        ["identity.features.memberships.ui.role.", "role"],
        ["identity.values.role.platformAdmin", "role.platform_admin"],
        ["identity.features.memberships.ui.membershipListPage.status.filter.active", "membership_status.active"],
        ["identity.features.memberships.ui.membershipListPage.status.filter.revoked", "membership_status.revoked"],
        ["identity.features.invitations.ui.invitationListPage.status.filter.pending", "invitation_status.pending"],
        ["identity.features.invitations.ui.invitationListPage.status.filter.accepted", "invitation_status.accepted"],
        ["identity.features.invitations.ui.invitationListPage.status.filter.declined", "invitation_status.declined"],
        ["identity.features.invitations.ui.invitationListPage.status.filter.cancelled", "invitation_status.cancelled"],
        ["identity.features.invitations.ui.invitationListPage.status.filter.expired", "invitation_status.expired"],
        ["identity.values.family.membershipRole", "family.membership_role"],
        ["identity.values.family.membershipStatus", "family.membership_status"],
        ["identity.values.family.invitationStatus", "family.invitation_status"],
        ["identity.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["identity.values.unrecognized", "value.unrecognized"],
        ["identity.accountManagement.", "manage"],
        ["identity.support.routeSupport.accountActionErrors.", "action"],
        ["identity.routes.marketplace.accountTeam.team.marketplace", "route.title"],
      ]),
    ),
  ],
  [
    "marketplace/locales/sessions.en.json",
    json({
      ...(await catalog("auth.ts", "authEnglishTranslations", [
        ["auth.features.sessions.ui.sessionListPage.", "list"],
        ["auth.features.sessions.ui.sessionDetailPage.", "detail"],
        ["auth.values.family.sessionStatus", "value.family_session_status"],
        ["auth.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["auth.values.unrecognized", "value.unrecognized"],
        ["auth.values.date.unavailable", "value.date_unavailable"],
      ])),
      ...(await catalog("identity.ts", "identityEnglishTranslations", [
        ["identity.values.authenticationMethod.", "method"],
        ["identity.values.family.authenticationMethod", "method.family"],
        ["identity.values.unrecognized.withValue", "method.unrecognized_with_value"],
        ["identity.values.unrecognized", "method.unrecognized"],
      ])),
    }),
  ],
  [
    "marketplace/locales/agents.en.json",
    json(
      await catalog("auth.ts", "authEnglishTranslations", [
        ["auth.features.agentGrants.ui.agentGrantListPage.", "list"],
        ["auth.features.agentGrants.ui.agentGrantDetailPage.", "detail"],
        ["auth.features.agentGrants.ui.agentConsentPage.", "consent"],
        ["auth.features.agentGrants.ui.agentGrantPresentation.", "presentation"],
        ["auth.values.agentGrantStatus.", "value.status"],
        ["auth.values.agentGrantOutcome.", "value.outcome"],
        ["auth.values.family.agentGrantStatus", "value.family_status"],
        ["auth.values.family.agentGrantOutcome", "value.family_outcome"],
        ["auth.values.unrecognized.withValue", "value.unrecognized_with_value"],
        ["auth.values.unrecognized", "value.unrecognized"],
        ["auth.values.date.unavailable", "value.date_unavailable"],
      ]),
    ),
  ],
  ["marketplace/agent-scopes.json", json(agentScopes)],
  [
    "marketplace/locales/listing-new.en.json",
    json(
      await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.listings.ui.listingCreatePage.", "page"],
        ["marketplace.routes.accountListingsNew.", "route"],
        ["marketplace.features.listings.ui.evidence.", "evidence"],
        ["marketplace.features.listings.evidenceCoverage.", "coverage"],
        ["marketplace.features.reviews.ui.authoredTextGuidance.", "guidance"],
      ]),
    ),
  ],
  [
    "marketplace/locales/seller-listing.en.json",
    json({
      ...(await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.listings.ui.listingDetailPage.", "page"],
        ["marketplace.features.listings.ui.listingDetailRecoveryPage.", "recover"],
        ["marketplace.routes.accountListing.", "route"],
        ["marketplace.features.listings.ui.evidence.", "evidence"],
        ["marketplace.features.listings.evidenceCoverage.", "coverage"],
        ["marketplace.features.reviews.ui.authoredTextGuidance.", "guidance"],
        ["marketplace.features.reviews.ui.authoredTextRecovery.", "recovery"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
      ])),
    }),
  ],
  [
    "marketplace/locales/seller-listings.en.json",
    json({
      ...(await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.listings.ui.listingListPage.", "list"],
        ["marketplace.routes.accountListings.", "route"],
        ["marketplace.features.listings.api.route.error.", "error"],
        ["marketplace.features.sellerDesk.degraded.title", "degraded"],
      ])),
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
      ])),
    }),
  ],
  [
    "marketplace/locales/desk.en.json",
    json({
      ...(await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.sellerDesk.", ""],
      ])),
      ...(await catalog("channels.ts", "channelsEnglishTranslations", [
        ["channels.manualSync.attention.", "manual"],
        ["channels.attention.reason.", "channel_reason"],
        ["channels.attention.ordersCount", "orders_count"],
        ["channels.attention.ordersOverflow", "orders_overflow"],
      ])),
    }),
  ],
  [
    "marketplace/locales/money.en.json",
    json({
      ...(await catalog("settlement.ts", "settlementEnglishTranslations", [
        ["settlement.features.moneyDashboard.ui.", "page"],
        ["settlement.features.payouts.ui.netPayout", "payout.net_payout"],
        ["settlement.features.payouts.ui.netPayoutAmount", "payout.net_payout_amount"],
        ["settlement.features.payouts.ui.payoutDetailPage.", "detail"],
        ["settlement.routes.marketplace.accountPayout.", "route"],
        ["settlement.features.payoutReadiness.ui.payoutSetupPage.", "setup"],
        ["settlement.features.payoutReadiness.ui.payoutReadinessPanel.", "setup_panel"],
        ["settlement.routes.marketplace.accountPayoutSetup.", "setup_route"],
        ["settlement.features.payouts.ui.requestedAmount", "payout.requested_amount"],
        ["settlement.features.payouts.ui.payoutFeeTerms", "payout.fee_terms"],
        ["settlement.features.payouts.ui.payoutFee", "payout.fee"],
        ["settlement.features.payouts.ui.sellerFeesAndDeductions", "payout.seller_fees"],
        ["settlement.features.wallets.ui.walletAdjustmentAccountCopy.status.", "adjustment_status"],
        ["settlement.features.wallets.ui.walletAdjustmentAccountCopy.direction.", "adjustment_direction"],
        [
          "settlement.features.wallets.integrations.transactionalNotifications.walletAdjustmentNotificationIntents.reason.",
          "reason",
        ],
      ])),
      ...Object.fromEntries(
        Object.entries(moneyStatusLabels).map(([code, text]) => [`status.${code.replaceAll("-", "_")}`, text]),
      ),
    }),
  ],
  [
    "marketplace/locales/payment.en.json",
    json(
      await catalog("payments.ts", "paymentsEnglishTranslations", [
        ["payments.routes.marketplace.accountPayment.", ""],
      ]),
    ),
  ],
  [
    "marketplace/locales/payment_start.en.json",
    json(
      await catalog("payments.ts", "paymentsEnglishTranslations", [
        ["payments.routes.marketplace.accountPaymentNew.", ""],
      ]),
    ),
  ],
  [
    "marketplace/locales/payment_methods.en.json",
    json(
      await catalog("payments.ts", "paymentsEnglishTranslations", [
        ["payments.routes.marketplace.accountPaymentMethods.", ""],
        ["payments.routes.marketplace.accountPayment.", "step"],
      ]),
    ),
  ],
  [
    "marketplace/locales/support.en.json",
    json(
      Object.fromEntries(
        Object.entries({
          ...(await catalog("support.ts", "supportEnglishTranslations", [
            ["support.features.supportRequests.ui.supportRequestDetailPage.", "page"],
            ["support.routes.marketplace.accountSupportDetail.", "route"],
            ["support.features.supportRequests.ui.supportOperationsPage.deadline.", "deadline"],
            ["support.features.supportRequests.ui.supportOperationsPage.not.applicable", "not_applicable"],
            ["support.features.supportRequests.ui.supportRequestListPage.", "list"],
            ["support.features.supportRequests.ui.customerRemedyStatus.", "remedy"],
            ["support.features.supportRequests.ui.returnShipping.", "shipping"],
            ["support.features.supportRequests.ui.attachments.", "attachments"],
            ["support.features.supportRequests.ui.supportOperationsPage.resolution.", "resolution"],
            ["support.routes.marketplace.accountSupport.", "list_route"],
          ])),
          ...(await catalog("platform-operations.ts", "platformOperationsEnglishTranslations", [
            ["support.participantAttempt.", "attempt"],
          ])),
        }).map(([key, text]) => [key.replaceAll("-", "_"), text]),
      ),
    ),
  ],
  [
    "marketplace/locales/repricing.en.json",
    json({
      ...(await catalog("pricing.ts", "pricingEnglishTranslations", [
        ["pricing.features.repricingPolicies.ui.shared.", "shared"],
        ["pricing.features.repricingPolicies.ui.policyList.", "list"],
        ["pricing.features.repricingPolicies.ui.editor.", "editor"],
        ["pricing.features.repricingPolicies.ui.activity.", "activity"],
        ["pricing.features.repricingPolicies.ui.policyDetail.", "detail"],
        ["pricing.features.repricingPolicies.ui.policyBody.", "body"],
        ["pricing.features.repricingPolicies.ui.goal.", "goal"],
        ["pricing.routes.marketplace.accountDeskRepricing.", "route"],
        ["pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.", "bulk"],
        ["pricing.features.recommendations.ui.recommendationListPage.", "recs"],
        ["pricing.routes.marketplace.accountRepricing.", "recs_route"],
        ["pricing.routes.marketplace.bulkReprice.", "bulk_route"],
        ["pricing.features.pricingHealth.title", "pricing_health"],
        ["pricing.features.pricingHealth.", "health"],
      ])),
      // A recommendation's item language (`formatLanguageCodeLabel`).
      ...(await catalog("localization.ts", "localizationEnglishTranslations", [
        ["localization.languageCode.", "language"],
      ])),
    }),
  ],
  [
    "marketplace/locales/channels.en.json",
    json(
      await catalog("channels.ts", "channelsEnglishTranslations", [
        ["channels.connections.", "connections"],
        ["channels.publication.", "publication"],
        ["channels.manualSync.", "manual_sync"],
      ]),
    ),
  ],
  [
    "marketplace/locales/offer-matches.en.json",
    json(
      await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.offers.ui.offerMatchListPage.", "list"],
        ["marketplace.features.offers.ui.offerMatchDetailPage.", "detail"],
        ["marketplace.features.offers.ui.priceGap.", "gap"],
        ["marketplace.routes.accountOfferMatch.", "route"],
        ["marketplace.routes.accountOfferMatches.", "routes"],
        ["marketplace.marketFollowing.seller.", "managed"],
      ]),
    ),
  ],
  [
    "marketplace/locales/submitted-offers.en.json",
    json(
      await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.features.offers.ui.submittedOfferListPage.", "list"],
        ["marketplace.features.offers.ui.submittedOfferLifecycle.", "lifecycle"],
        ["marketplace.routes.accountOffersSubmitted.", "route"],
        ["marketplace.features.offers.ui.price.incomplete", "price_incomplete"],
        ["marketplace.features.offers.ui.submittedOfferDetailPage.", "detail"],
        ["marketplace.routes.accountOfferSubmitted.", "detail_route"],
        ["marketplace.features.offers.ui.offerDetailRecoveryPage.", "recovery"],
      ]),
    ),
  ],
  [
    "public/locales/market.en.json",
    json({
      ...(await catalog("pricing.ts", "pricingEnglishTranslations", [
        ["pricing.features.publicMarketPages.ui.marketPriceHistoryPage.", "page"],
        ["pricing.features.publicMarketPages.routes.marketPriceHistory.", "route"],
      ])),
      ...(await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [
        ["publicPresence.appRoot.", "root"],
      ])),
    }),
  ],
  [
    "public/locales/home.en.json",
    json(
      await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [
        ["publicPresence.home.", "home"],
        ["publicPresence.waitlist.", "waitlist"],
        ["publicPresence.nav.", "nav"],
        ["publicPresence.footer.", "footer"],
        ["publicPresence.faq.", "faq"],
        ["publicPresence.routes.home.", "route"],
        ["publicPresence.welcome.", "welcome"],
        ["publicPresence.routes.welcome.", "route_welcome"],
        ["publicPresence.brand", "brand"],
        ["publicPresence.info.sellerAgreement.eyebrow", "info.seller_agreement"],
        ["publicPresence.info.paymentsTerms.eyebrow", "info.payments_terms"],
        ["publicPresence.info.authenticityTerms.eyebrow", "info.authenticity_terms"],
        ["publicPresence.info.agentTerms.eyebrow", "info.agent_terms"],
      ]),
    ),
  ],
  [
    "public/locales/policy.en.json",
    json(
      await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [
        ["publicPresence.info.policies.", "policies"],
        ["publicPresence.info.terms.", "terms"],
        ["publicPresence.info.privacy.eyebrow", "eyebrow.privacy"],
        ["publicPresence.info.founders.eyebrow", "eyebrow.founders"],
        ["publicPresence.info.sellerAgreement.eyebrow", "eyebrow.seller_agreement"],
        ["publicPresence.info.paymentsTerms.eyebrow", "eyebrow.payments_terms"],
        ["publicPresence.info.agentTerms.eyebrow", "eyebrow.agent_terms"],
        ["publicPresence.info.authenticityTerms.eyebrow", "eyebrow.authenticity_terms"],
        ["publicPresence.routes.terms.meta.", "meta.terms"],
        ["publicPresence.routes.privacy.meta.", "meta.privacy"],
        ["publicPresence.routes.founders.meta.", "meta.founders"],
        ["publicPresence.routes.sellerAgreement.meta.", "meta.seller_agreement"],
        ["publicPresence.routes.paymentsTerms.meta.", "meta.payments_terms"],
        ["publicPresence.routes.agentTerms.meta.", "meta.agent_terms"],
        ["publicPresence.routes.authenticityTerms.meta.", "meta.authenticity_terms"],
      ]),
    ),
  ],
  ["public/policies.json", json(await policies())],
  ["public/help.json", json(await help())],
  ["public/developers.json", json(await developers())],
  [
    "public/locales/developers.en.json",
    json(
      await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [["publicPresence.developers.", ""]]),
    ),
  ],
  [
    "public/locales/help.en.json",
    json(await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [["publicPresence.help.", ""]])),
  ],
  [
    "public/locales/compare.en.json",
    json(
      await catalog("public-presence.ts", "publicPresenceEnglishTranslations", [
        ["publicPresence.compare.", ""],
        ["publicPresence.routes.compareTcgplayer.meta.", "meta.tcgplayer"],
        ["publicPresence.routes.compareEbay.meta.", "meta.ebay"],
        ["publicPresence.info.contact.", "contact"],
        ["publicPresence.routes.contact.meta.", "meta.contact"],
      ]),
    ),
  ],
  [
    "public/favicon.svg",
    (await import(pathToFileURL(path.join(repo, "packages/design-system/src/brand/chase-sets-logo.tsx")).href))
      .chaseSetsLogoSvg,
  ],
  [
    "marketplace/favicon.svg",
    (await import(pathToFileURL(path.join(repo, "packages/design-system/src/brand/chase-sets-logo.tsx")).href))
      .chaseSetsLogoSvg,
  ],
  [
    "marketplace/locales/site.en.json",
    json(
      await catalog("marketplace.ts", "marketplaceEnglishTranslations", [
        ["marketplace.app.routes.offline.", "offline"],
        ["marketplace.app.routes.manifest.description", "manifest_description"],
      ]),
    ),
  ],
  [
    "admin/favicon.svg",
    (await import(pathToFileURL(path.join(repo, "packages/design-system/src/brand/chase-sets-logo.tsx")).href))
      .chaseSetsLogoSvg,
  ],
  [
    "admin/locales/site.en.json",
    json(
      await catalog("admin-web.ts", "adminWebEnglishTranslations", [
        ["adminWeb.app.routes.offline.", "offline"],
        ["adminWeb.app.routes.manifest.description", "manifest_description"],
      ]),
    ),
  ],
  ["marketplace/nav.json", json(marketplaceNav())],
  ["platform/tokens.json", json(tokens())],
];
// Outputs that carry the brand foil's values are written on every run, --check included, and are not
// committed: the structure gate (scripts/check-structure/brand-foil-sites.mjs) allows those values
// only in the design system's registered carriers. Run this script before building the pilot.
const GENERATED = new Set([
  "public/favicon.svg",
  "marketplace/favicon.svg",
  "admin/favicon.svg",
  "platform/tokens.json",
]);
const require = createRequire(path.join(repo, "packages/design-system/package.json"));
let stale = 0;
for (const [file, text] of outputs) {
  const target = path.join(pilot, file);
  if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
  if (check && !GENERATED.has(file)) {
    console.error(`${file} is out of date: run node --import tsx deployables/corten-pilot/scripts/export.mjs`);
    stale += 1;
  } else {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`wrote ${file}`);
  }
}
for (const app of apps) {
  mkdirSync(path.join(pilot, app, "static/fonts"), { recursive: true });
  for (const [pkg, name] of fonts) {
    const source = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "files", name);
    const target = path.join(pilot, app, "static/fonts", name);
    if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) continue;
    if (check) {
      console.error(`${app}/static/fonts/${name} is out of date`);
      stale += 1;
    } else {
      copyFileSync(source, target);
      console.log(`wrote ${app}/static/fonts/${name}`);
    }
  }
}
mkdirSync(path.join(pilot, "public/static/home"), { recursive: true });
for (const name of homeAssets) {
  const source = path.join(repo, "bounded-contexts/public-presence/features/waitlist/ui/assets", name);
  const target = path.join(pilot, "public/static/home", name);
  if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) continue;
  if (check) {
    console.error(`public/static/home/${name} is out of date`);
    stale += 1;
  } else {
    copyFileSync(source, target);
    console.log(`wrote public/static/home/${name}`);
  }
}
for (const [deployable, app, names] of appIcons) {
  mkdirSync(path.join(pilot, app, "static/icons"), { recursive: true });
  for (const name of names) {
    const source = path.join(repo, "deployables", deployable, "public/icons", name);
    const target = path.join(pilot, app, "static/icons", name);
    if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) continue;
    if (check) {
      console.error(`${app}/static/icons/${name} is out of date`);
      stale += 1;
    } else {
      copyFileSync(source, target);
      console.log(`wrote ${app}/static/icons/${name}`);
    }
  }
}
process.exit(stale ? 1 : 0);
