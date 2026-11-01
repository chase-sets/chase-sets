import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

export const marketplaceAttemptInventoryIgnoreRules = [
  ".gitignore",
  ".git/info/exclude",
  "core.excludesFile (git --exclude-standard)",
];

const offerCallerPattern =
  "submitOffer|updateOfferPrice|acceptOffer|declineOfferMatch|createSubmittedOffer|updateSubmittedOfferPrice|acceptOfferMatch|commandBuyerOfferPolicy|BuyerOfferPolicyServices|createBuyerOfferPolicyRuntime|SubmitOffer|AcceptOffer|DeclineOfferMatch|marketplace\\.(submit-offer|counter-offer|update-offer-price|accept-offer|decline-offer)|decline-offer|offers/submitted|offers/matches/|offer-policies/";

export function readTrackedMarketplaceCallerSources(root, pattern = offerCallerPattern) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  const ignored = new Set(git(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]));
  let matches;
  try {
    matches = git(["grep", "-l", "-z", "-E", pattern, "--", "*.ts", "*.tsx", "*.js", "*.mjs", "*.cjs"]);
  } catch (error) {
    if (error.status !== 1) throw error;
    matches = [];
  }
  const candidates = new Set(matches);
  return git(["ls-files", "-z", "--cached"])
    .filter((file) => candidates.has(file) && /\.[cm]?[jt]sx?$/.test(file) && !ignored.has(file))
    .map((file) => ({ path: file, source: readFileSync(path.join(root, file), "utf8") }));
}

const methods = new Set([
  "submitOffer",
  "updateOfferPrice",
  "acceptOffer",
  "declineOfferMatch",
  "createSubmittedOffer",
  "updateSubmittedOfferPrice",
  "acceptOfferMatch",
  "commandBuyerOfferPolicy",
]);

// Offer and Offer Policy command endpoints, matched on the literal text of a request URL.
const httpOfferCommands = [
  [/\/offers\/submitted$/, "http-submit-offer"],
  [/\/offers\/submitted\/[^/]+\/price$/, "http-update-offer-price"],
  [/\/offers\/matches\/[^/]+\/accept$/, "http-accept-offer"],
  [/\/offers\/matches\/[^/]+\/decline$/, "http-decline-offer"],
  [/\/offer-policies\/[^/]+\/commands$/, "http-offer-policy-command"],
];

function literalUrl(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join("");
  return null;
}

export function enumerateMarketplaceAttemptCallers(sources) {
  const callers = [];
  for (const file of sources) {
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
    const isTest = imports.some((name) => /^(vitest|node:test|@playwright\/test)$/.test(name));
    const policy = imports.some((name) => /offer-policy.*runtime/.test(name));
    const aliases = new Map();
    function collectAliases(node) {
      if (ts.isImportSpecifier(node) && methods.has(node.propertyName?.text ?? node.name.text))
        aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        methods.has(node.propertyName.text)
      )
        aliases.set(node.name.text, node.propertyName.text);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        methods.has(node.initializer.name.text)
      )
        aliases.set(node.name.text, node.initializer.name.text);
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(ast);
    const add = (node, method, call = node.getText(ast)) => {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      callers.push({ path: file.path, method, line, call });
    };
    function visit(node) {
      if (ts.isCallExpression(node)) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          const property = (name) =>
            argument.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(ast) === name);
          const tool = property("name")?.initializer;
          const args = property("arguments")?.initializer;
          if (
            tool &&
            ts.isStringLiteral(tool) &&
            /^marketplace\.(submit-offer|counter-offer|update-offer-price|accept-offer|decline-offer)$/.test(
              tool.text,
            ) &&
            args
          ) {
            add(node, "mcp-offer-command", args.getText(ast));
          }
        }
        const expression = node.expression;
        const rawName = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text
            : ts.isIdentifier(expression)
              ? expression.text
              : "";
        const name = aliases.get(rawName) ?? rawName;
        const offerCommand =
          name === "commandHandler" &&
          /type:\s*["'](?:SubmitOffer|AcceptOffer|UpdateOfferPrice|DeclineOfferMatch)["']/.test(node.getText(ast));
        const policyCommand = name === "execute" && policy;
        // Handler fixtures deliberately exercise invalid commands; transport callers are never exempt.
        if (!isTest && (methods.has(name) || offerCommand || policyCommand)) add(node, name);
        // HTTP transport producers (e.g. Playwright `request.post(url, { data })`). Route registrations
        // pass a handler, not an options object, so they never match.
        const [target, options] = node.arguments;
        const url = target && literalUrl(target);
        if (
          url &&
          options &&
          ts.isObjectLiteralExpression(options) &&
          ts.isPropertyAccessExpression(expression) &&
          /^(post|patch|put)$/.test(expression.name.text)
        ) {
          const command = httpOfferCommands.find(([pattern]) => pattern.test(url.split("?")[0]));
          if (command) add(node, command[1], options.getText(ast));
        }
      }
      if (ts.isJsxElement(node) && /^(Form|RouterForm)$/.test(node.openingElement.tagName.getText(ast))) {
        const call = node.getText(ast);
        if (/name=["']intent["']\s+value=["'](?:decline-offer|accept-offer)["']/.test(call)) {
          add(node, "offer-command-form");
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return callers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

// Every row is a command boundary or a named deterministic authoring exemption.
export const marketplaceOfferCallerPartition = new Map([
  ["deployables/platform-api/__tests__/mcp-sdk-agent-journey.e2e.test.ts::mcp-offer-command", "mcp-attempt-fields"],
  ["deployables/platform-api/__tests__/seller-desk-journey.e2e.test.ts::mcp-offer-command", "mcp-attempt-fields"],
  ["bounded-contexts/marketplace/features/offers/ui/offer-match-list-page.tsx::offer-command-form", "form-attemptId"],
  ["bounded-contexts/marketplace/features/offers/ui/offer-match-detail-page.tsx::offer-command-form", "form-attemptId"],
  [
    "bounded-contexts/platform-operations/features/support-requests/ui/support-request-detail-page.tsx::offer-command-form",
    "not a Marketplace command: Support Request offer response; identity owned by participant-client",
  ],
  ["bounded-contexts/checkout/routes/account-sell-list.tsx::declineOfferMatch", "attemptId"],
  ["bounded-contexts/checkout/support/request-support/checkout-confirmation.ts::createSubmittedOffer", "attemptId"],
  [
    "bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts::acceptOfferMatch",
    "Checkout selected/match sourceActionKey forwarded through the imported client interface",
  ],
  [
    "bounded-contexts/marketplace/features/offer-policy/api/route.ts::execute",
    "buyerOfferPolicyRequestSchema requires attemptId",
  ],
  [
    "bounded-contexts/marketplace/features/offer-policy/api/submitted-offer-route.ts::commandBuyerOfferPolicy",
    "buyerOfferPolicyRequestSchema requires attemptId; deterministic draft uses policyId",
  ],
  ["bounded-contexts/marketplace/features/offers/api/mcp.ts::submitOffer", "attemptId"],
  ["bounded-contexts/marketplace/features/offers/api/mcp.ts::updateOfferPrice", "attemptId"],
  ["bounded-contexts/marketplace/features/offers/api/mcp.ts::acceptOffer", "sourceActionKey"],
  ["bounded-contexts/marketplace/features/offers/api/mcp.ts::declineOfferMatch", "attemptId"],
  ["bounded-contexts/marketplace/features/offers/api/route.ts::submitOffer", "attemptId"],
  ["bounded-contexts/marketplace/features/offers/api/route.ts::updateOfferPrice", "attemptId"],
  ["bounded-contexts/marketplace/features/offers/api/route.ts::acceptOffer", "sourceActionKey"],
  ["bounded-contexts/marketplace/features/offers/api/route.ts::declineOfferMatch", "attemptId"],
  ["bounded-contexts/marketplace/routes/account-offer-match.tsx::acceptOfferMatch", "sourceActionKey"],
  ["bounded-contexts/marketplace/routes/account-offer-match.tsx::declineOfferMatch", "attemptId"],
  [
    "bounded-contexts/marketplace/routes/account-offers-submitted.tsx::commandBuyerOfferPolicy",
    "typed client forwarding, no new identity",
  ],
  [
    "bounded-contexts/marketplace/support/runtime-support/seed.ts::commandHandler",
    "deterministic exemption: reserved Offer stream; complete owner-history reconciliation before authoring",
  ],
  ["contracts/catalog-seed/representative-commerce-state.ts::submitOffer", "attemptId"],
  ["contracts/catalog-seed/representative-commerce-state.ts::acceptOffer", "sourceActionKey"],
  ["deployables/marketplace/e2e/accepted-offer-sales-handoff.spec.ts::http-submit-offer", "attemptId"],
  ["deployables/marketplace/e2e/accepted-offer-sales-handoff.spec.ts::http-accept-offer", "sourceActionKey"],
  ["deployables/marketplace/e2e/market-following-offers.spec.ts::http-submit-offer", "attemptId"],
  ["deployables/marketplace/e2e/market-following-offers.spec.ts::http-accept-offer", "sourceActionKey"],
  ["deployables/marketplace/e2e/market-following-offers.spec.ts::http-offer-policy-command", "attemptId"],
]);

export function unpartitionedMarketplaceOfferCallers(callers) {
  return callers.filter((caller) => {
    const proof = marketplaceOfferCallerPartition.get(`${caller.path}::${caller.method}`);
    return (
      !proof ||
      (["attemptId", "sourceActionKey"].includes(proof) && !new RegExp(`\\b${proof}\\s*:`).test(caller.call)) ||
      (proof === "mcp-attempt-fields" &&
        (!/\battemptId\s*:/.test(caller.call) ||
          !/\brequestHash\s*:/.test(caller.call) ||
          /\bsourceActionKey\s*:/.test(caller.call))) ||
      (proof === "form-attemptId" && !/name=["']attemptId["']/.test(caller.call))
    );
  });
}

// ---- Listing family (#9733): the same tracked-file, code-shape census for Listing commands. ----

export const listingCallerPattern =
  "createListing|createListingFromInventorySnapshot|createBatchDraftListingFromInventorySnapshot|createListingWithPhotos|publishListing|updateListingPrice|updateListingQuantityCap|updateListingPurchaseLimits|pauseListing|withdrawListing|SellerListingAvailability|SellerAwayWindow|ScheduledAwayWindow|SellerOrderCapacity|applyBulkListingPriceUpdates|PauseListing|PublishListing|WithdrawListing|CreateListing|UpdateListingPrice|marketplace\\.(create-listing|update-listing-price|publish-listing|unpublish-listing)|account/listings|listing-availability|order-capacity|upload-bulk-reprice";

const listingMethods = new Set([
  "createListing",
  "createListingFromInventorySnapshot",
  "createBatchDraftListingFromInventorySnapshot",
  "createListingWithPhotos",
  "publishListing",
  "updateListingPrice",
  "updateListingQuantityCap",
  "updateListingPurchaseLimits",
  "pauseListing",
  "withdrawListing",
  "disableSellerListingAvailability",
  "enableSellerListingAvailability",
  "scheduleSellerAwayWindow",
  "cancelScheduledAwayWindow",
  "setSellerOrderCapacity",
  "clearSellerOrderCapacity",
  "applyBulkListingPriceUpdates",
]);

const listingCommandTypes =
  /type:\s*["'](?:CreateListing|PublishListing|UpdateListingPrice|UpdateListingQuantityCap|UpdateListingPurchaseLimits|PauseListing|WithdrawListing|DisableSellerListingAvailability|EnableSellerListingAvailability|ScheduleSellerAwayWindow|CancelScheduledAwayWindow|SetSellerOrderCapacity|ClearSellerOrderCapacity)["']/;

// Listing and seller-account command endpoints, matched on the literal text of a request URL.
const httpListingCommands = [
  [/\/account\/listings$/, "http-create-listing"],
  [/\/account\/listings\/[^/]+\/(price|quantity-cap|purchase-limits|publish|pause|withdraw)$/, "http-listing-command"],
  [/\/account\/listings\/prices\/bulk$/, "http-bulk-listing-prices"],
  [/\/account\/listing-availability\/(disable|enable|away-window)$/, "http-seller-availability"],
  [/\/account\/order-capacity$/, "http-seller-order-capacity"],
];

const listingFormIntents =
  /name=["']intent["']\s+value=["'](?:update-price|update-quantity-cap|update-purchase-limits|publish|pause|withdraw|create-listing|create-and-publish-listing|list-at-price|bulk-pause-listings|bulk-withdraw-listings|disable-listing-availability|enable-listing-availability|schedule-away-window|cancel-away-window|set-order-capacity|clear-order-capacity|upload-bulk-reprice)["']/;

function calledName(expression) {
  let node = expression;
  while (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
    return node.argumentExpression.text;
  return ts.isIdentifier(node) ? node.text : "";
}

export function enumerateListingAttemptCallers(sources) {
  const callers = [];
  for (const file of sources) {
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
    const isTest = imports.some((name) => /^(vitest|node:test|@playwright\/test)$/.test(name));
    const aliases = new Map();
    function collectAliases(node) {
      if (ts.isImportSpecifier(node) && listingMethods.has(node.propertyName?.text ?? node.name.text))
        aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        listingMethods.has(node.propertyName.text)
      )
        aliases.set(node.name.text, node.propertyName.text);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        listingMethods.has(node.initializer.name.text)
      )
        aliases.set(node.name.text, node.initializer.name.text);
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(ast);
    const add = (node, method, call = node.getText(ast)) => {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      callers.push({ path: file.path, method, line, call });
    };
    function visit(node) {
      if (ts.isCallExpression(node)) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          const property = (name) =>
            argument.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(ast) === name);
          const tool = property("name")?.initializer;
          const args = property("arguments")?.initializer;
          if (
            tool &&
            ts.isStringLiteral(tool) &&
            /^marketplace\.(create-listing|update-listing-price|publish-listing|unpublish-listing)$/.test(tool.text) &&
            args
          )
            add(node, "mcp-listing-command", args.getText(ast));
        }
        const rawName = calledName(node.expression);
        const name = aliases.get(rawName) ?? rawName;
        const handlerCommand =
          /^(commandHandler|sellerAvailabilityCommandHandler|orderCapacityCommandHandler)$/.test(name) &&
          listingCommandTypes.test(node.getText(ast));
        // Handler fixtures deliberately exercise invalid commands; transport callers are never exempt.
        if (!isTest && (listingMethods.has(name) || handlerCommand))
          add(node, handlerCommand ? "commandHandler" : name);
        const [target, options] = node.arguments;
        const url = target && literalUrl(target);
        const expression = node.expression;
        if (
          url &&
          options &&
          ts.isObjectLiteralExpression(options) &&
          ts.isPropertyAccessExpression(expression) &&
          /^(post|patch|put|delete)$/.test(expression.name.text)
        ) {
          const command = httpListingCommands.find(([pattern]) => pattern.test(url.split("?")[0]));
          if (command) add(node, command[1], options.getText(ast));
        }
      }
      if (ts.isJsxElement(node) && /^(Form|RouterForm)$/.test(node.openingElement.tagName.getText(ast))) {
        if (listingFormIntents.test(node.getText(ast))) add(node, "listing-command-form");
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return callers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

const carriesKey = /\bidempotencyKey\b/;
const carriesAttempt = /\battempt\b|\.\.\.attempt\b/;
const carriesFormAttempt = /name=["']attemptId["']|SellerAttemptInput/;
const repricingEngine =
  "exempt: repricing-engine `repricing:` keys and expectedVersion stay as shipped (#7161 D4); price replays compare amount and currency";

/**
 * Every tracked Listing caller is attempt-producing (its own call text carries the named carrier) or a named
 * exemption. A RegExp row is a carrier the caller's call text must contain; a string row is an exemption
 * (`exempt:`), a typed forwarder that adds no identity (`forwarded:`), or a same-named non-Listing call.
 */
export const marketplaceListingCallerPartition = new Map([
  [
    "bounded-contexts/channels/features/outbound-sync/api/runtime.ts::publishListing",
    "not-a-command: Channels publication port publishes an external channel draft, not a Marketplace Listing",
  ],
  [
    "bounded-contexts/channels/features/publication-port/api/registry.ts::publishListing",
    "not-a-command: Channels publication port registry, not a Marketplace Listing",
  ],
  [
    "bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts::createListing",
    carriesKey,
  ],
  [
    "bounded-contexts/checkout/support/route-support/sell-checkout-session/sell-checkout-handoff.ts::publishListing",
    carriesKey,
  ],
  ["bounded-contexts/discovery/support/route-support/item-detail/action.ts::createListing", carriesKey],
  ["bounded-contexts/discovery/support/route-support/item-detail/action.ts::publishListing", carriesKey],
  ["bounded-contexts/discovery/support/route-support/item-detail/action.ts::updateListingPrice", carriesKey],
  ["bounded-contexts/discovery/support/route-support/item-detail/action.ts::updateListingQuantityCap", carriesKey],
  [
    "bounded-contexts/inventory/features/inventory-items/ui/list-from-inventory-drawer.tsx::listing-command-form",
    carriesFormAttempt,
  ],
  [
    "bounded-contexts/marketplace/features/channel-inbound-clamp/api/runtime.ts::commandHandler",
    "exempt: the engage pause is fenced by its observed stream version; a pending row is reconciled against the authoritative stream version and pause reason before any repeat (channel-inbound-clamp/api/runtime.test.ts)",
  ],
  [
    "bounded-contexts/marketplace/features/channel-inbound-clamp/api/runtime.ts::publishListing",
    /clampReleaseAttemptKey\(/,
  ],
  [
    "bounded-contexts/marketplace/features/listings/api/inventory-draft-consumer.ts::createBatchDraftListingFromInventorySnapshot",
    "exempt: deterministic import-row Listing id; inspectDraft reads the authoritative stream and a created stream is returned, never re-created",
  ],
  ["bounded-contexts/marketplace/features/listings/api/mcp.ts::createListing", /\.\.\.attempt\b/],
  ["bounded-contexts/marketplace/features/listings/api/mcp.ts::pauseListing", /\.\.\.attempt\b/],
  ["bounded-contexts/marketplace/features/listings/api/mcp.ts::publishListing", /\.\.\.attempt\b/],
  ["bounded-contexts/marketplace/features/listings/api/mcp.ts::updateListingPrice", /\.\.\.attempt\b/],
  [
    "bounded-contexts/marketplace/features/listings/api/route.ts::applyBulkListingPriceUpdates",
    /parseBulkListingPriceUpdates\(/,
  ],
  ...[
    "cancelScheduledAwayWindow",
    "clearSellerOrderCapacity",
    "disableSellerListingAvailability",
    "enableSellerListingAvailability",
    "pauseListing",
    "publishListing",
    "scheduleSellerAwayWindow",
    "setSellerOrderCapacity",
    "updateListingPrice",
    "updateListingPurchaseLimits",
    "updateListingQuantityCap",
    "withdrawListing",
  ].map((method) => [
    `bounded-contexts/marketplace/features/listings/api/route.ts::${method}`,
    /listingAttemptInput\(/,
  ]),
  ["bounded-contexts/marketplace/features/listings/api/route.ts::createListing", /\.\.\.attempt\b/],
  [
    "bounded-contexts/marketplace/features/listings/api/route.ts::createListingFromInventorySnapshot",
    /\.\.\.attempt\b/,
  ],
  [
    "bounded-contexts/marketplace/features/listings/api/runtime.ts::commandHandler",
    "exempt: scheduled availability sweeps are compare-and-swap guarded by dueBy on the authoritative stream; a repeated sweep no-ops",
  ],
  [
    "bounded-contexts/marketplace/features/listings/api/runtime.ts::createListing",
    "forwarded: runtime composition passes its caller's attempt or deterministic import-row Listing id",
  ],
  [
    "bounded-contexts/marketplace/features/listings/integrations/settlement/negative-balance-projection.ts::disableSellerListingAvailability",
    carriesKey,
  ],
  [
    "bounded-contexts/marketplace/features/listings/ui/listing-create-page.tsx::listing-command-form",
    carriesFormAttempt,
  ],
  [
    "bounded-contexts/marketplace/features/listings/ui/listing-detail-page.tsx::listing-command-form",
    carriesFormAttempt,
  ],
  [
    "bounded-contexts/marketplace/features/listings/ui/listing-list-page.tsx::listing-command-form",
    /name=["']batchId["']/,
  ],
  [
    "bounded-contexts/marketplace/features/listings/ui/time-away-capacity-card.tsx::listing-command-form",
    carriesFormAttempt,
  ],
  ...[
    "pauseListing",
    "publishListing",
    "updateListingPrice",
    "updateListingPurchaseLimits",
    "updateListingQuantityCap",
    "withdrawListing",
  ].map((method) => [`bounded-contexts/marketplace/routes/account-listing.tsx::${method}`, carriesAttempt]),
  ...[
    "cancelScheduledAwayWindow",
    "clearSellerOrderCapacity",
    "disableSellerListingAvailability",
    "enableSellerListingAvailability",
    "scheduleSellerAwayWindow",
    "setSellerOrderCapacity",
  ].map((method) => [`bounded-contexts/marketplace/routes/account-listings.tsx::${method}`, carriesAttempt]),
  ["bounded-contexts/marketplace/routes/account-listings.tsx::pauseListing", /batchAttempt/],
  ["bounded-contexts/marketplace/routes/account-listings.tsx::withdrawListing", /batchAttempt/],
  ["bounded-contexts/marketplace/routes/account-listings-new.tsx::createListing", carriesKey],
  ["bounded-contexts/marketplace/routes/account-listings-new.tsx::createListingWithPhotos", carriesKey],
  ["bounded-contexts/marketplace/routes/account-listings-new.tsx::publishListing", carriesKey],
  ...["createListing", "pauseListing", "publishListing", "withdrawListing"].map((method) => [
    `bounded-contexts/marketplace/support/runtime-support/seed.ts::${method}`,
    /seedListingAttemptKey\(/,
  ]),
  ["bounded-contexts/pricing/features/bulk-reprice-ingestion/api/runtime.ts::applyBulkListingPriceUpdates", carriesKey],
  [
    "bounded-contexts/pricing/features/bulk-reprice-ingestion/ui/bulk-reprice-page.tsx::listing-command-form",
    carriesFormAttempt,
  ],
  [
    "bounded-contexts/pricing/features/recommendations/api/runtime.ts::applyBulkListingPriceUpdates",
    /recommendationAttemptKey\(/,
  ],
  ["bounded-contexts/pricing/features/recommendations/api/runtime.ts::createListing", /recommendationAttemptKey\(/],
  ["bounded-contexts/pricing/features/repricing-engine/api/runtime.ts::applyBulkListingPriceUpdates", repricingEngine],
  ["bounded-contexts/pricing/features/repricing-engine/api/runtime.ts::pauseListing", repricingEngine],
  ["bounded-contexts/pricing/features/repricing-engine/api/runtime.ts::publishListing", repricingEngine],
  [
    "bounded-contexts/pricing/support/request-support/marketplace-listings.ts::applyBulkListingPriceUpdates",
    "forwarded: typed Pricing gateway body requires batchId and a per-target key",
  ],
  [
    "bounded-contexts/pricing/support/request-support/marketplace-listings.ts::createListing",
    "forwarded: typed Pricing gateway body requires idempotencyKey",
  ],
  ...["createListing", "publishListing", "updateListingPrice"].map((method) => [
    `contracts/catalog-seed/representative-commerce-state.ts::${method}`,
    /representativeListingAttemptKey\(/,
  ]),
  ["deployables/marketplace/e2e/accepted-offer-sales-handoff.spec.ts::http-create-listing", carriesKey],
  ["deployables/marketplace/e2e/accepted-offer-sales-handoff.spec.ts::http-listing-command", carriesKey],
  ["deployables/marketplace/e2e/channel-connection-connect.spec.ts::http-create-listing", carriesKey],
  ["deployables/marketplace/e2e/market-following-offers.spec.ts::http-create-listing", carriesKey],
  ["deployables/marketplace/e2e/market-following-offers.spec.ts::http-listing-command", carriesKey],
  [
    "deployables/platform-api/src/app.ts::createBatchDraftListingFromInventorySnapshot",
    "forwarded: composition root forwards the Inventory draft creator's deterministic import-row Listing id",
  ],
  [
    "deployables/platform-worker/src/main.ts::applyBulkListingPriceUpdates",
    "forwarded: worker gateways pass the typed per-target keys of their Pricing callers",
  ],
  [
    "deployables/platform-worker/src/main.ts::createBatchDraftListingFromInventorySnapshot",
    "forwarded: composition root forwards the Inventory draft creator's deterministic import-row Listing id",
  ],
  [
    "deployables/platform-worker/src/main.ts::createListing",
    "forwarded: worker gateway spreads the typed recommendation key",
  ],
  ["deployables/platform-worker/src/main.ts::pauseListing", repricingEngine],
  ["deployables/platform-worker/src/main.ts::publishListing", /idempotencyKey: body\.idempotencyKey/],
  ["infrastructure/platform-runtime/mcp.test.ts::mcp-listing-command", /\bidempotencyKey\s*:[\s\S]*\brequestHash\s*:/],
  [
    "packages/design-system/src/__tests__/form-system.test.tsx::listing-command-form",
    "not-a-command: design-system Form fixture with no Marketplace route",
  ],
]);

export function unpartitionedListingCallers(callers) {
  return callers.filter((caller) => {
    const proof = marketplaceListingCallerPartition.get(`${caller.path}::${caller.method}`);
    if (proof === undefined) return true;
    return proof instanceof RegExp ? !proof.test(caller.call) : !/^(exempt|forwarded|not-a-command): /.test(proof);
  });
}
