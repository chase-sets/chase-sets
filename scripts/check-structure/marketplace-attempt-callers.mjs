import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";

export const marketplaceAttemptInventoryIgnoreRules = [
  ".gitignore",
  ".git/info/exclude",
  "core.excludesFile (git --exclude-standard)",
];

export function readTrackedMarketplaceCallerSources(root) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  const ignored = new Set(git(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]));
  let matches;
  try {
    matches = git([
      "grep",
      "-l",
      "-z",
      "-E",
      "submitOffer|updateOfferPrice|acceptOffer|declineOfferMatch|createSubmittedOffer|updateSubmittedOfferPrice|acceptOfferMatch|commandBuyerOfferPolicy|BuyerOfferPolicyServices|createBuyerOfferPolicyRuntime|SubmitOffer|AcceptOffer|DeclineOfferMatch|marketplace\\.(submit-offer|counter-offer|update-offer-price|accept-offer|decline-offer)|decline-offer|offers/submitted|offers/matches/|offer-policies/|[Ll]isting|SellerAwayWindow|ScheduledAwayWindow|SellerOrderCapacity|[Rr]eview|[Rr]eport",
      "--",
      "*.ts",
      "*.tsx",
      "*.js",
      "*.mjs",
      "*.cjs",
    ]);
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

function literalUrl(node, bindings = new Map(), seen = new Set()) {
  if (ts.isIdentifier(node) && bindings.has(node.text) && !seen.has(node.text))
    return literalUrl(bindings.get(node.text), bindings, new Set([...seen, node.text]));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map((span) => `${literalUrl(span.expression, bindings, seen) ?? "${}"}${span.literal.text}`)
        .join("")
    );
  return null;
}

export function enumerateMarketplaceAttemptCallers(sources, listing = false, reviewReport = false) {
  const activeMethods = reviewReport ? reviewReportMethods : listing ? listingMethods : methods;
  const callers = [];
  for (const file of sources) {
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
    const isTest = imports.some((name) => /^(vitest|node:test|@playwright\/test)$/.test(name));
    const policy = imports.some((name) => /offer-policy.*runtime/.test(name));
    const aliases = new Map();
    const bindings = new Map();
    function collectAliases(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        bindings.set(node.name.text, node.initializer);
      if (ts.isImportSpecifier(node) && activeMethods.has(node.propertyName?.text ?? node.name.text))
        aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        node.propertyName &&
        ts.isIdentifier(node.propertyName) &&
        activeMethods.has(node.propertyName.text)
      )
        aliases.set(node.name.text, node.propertyName.text);
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isPropertyAccessExpression(node.initializer) &&
        activeMethods.has(node.initializer.name.text)
      )
        aliases.set(node.name.text, node.initializer.name.text);
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(ast);
    function expandIdentity(node, seen = new Set()) {
      const evidence = [node.getText(ast)];
      function visitIdentity(child) {
        if (ts.isIdentifier(child) && bindings.has(child.text) && !seen.has(child.text)) {
          seen.add(child.text);
          evidence.push(expandIdentity(bindings.get(child.text), seen));
        } else ts.forEachChild(child, visitIdentity);
      }
      ts.forEachChild(node, visitIdentity);
      return evidence.join("\n");
    }
    const add = (node, method, call = node.getText(ast)) => {
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      callers.push({
        path: file.path,
        method,
        line,
        call,
        ...(listing || reviewReport ? { identityEvidence: expandIdentity(node) + "\n" + imports.join("\n") } : {}),
      });
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
            !reviewReport &&
            tool &&
            ts.isStringLiteral(tool) &&
            (listing
              ? /^marketplace\.(create-listing|update-listing-price|publish-listing|unpublish-listing)$/
              : /^marketplace\.(submit-offer|counter-offer|update-offer-price|accept-offer|decline-offer)$/
            ).test(tool.text) &&
            args
          ) {
            add(node, listing ? "mcp-listing-command" : "mcp-offer-command", args.getText(ast));
          }
        }
        let expression = node.expression;
        while (ts.isNonNullExpression(expression)) expression = expression.expression;
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
        const reviewReportCommand =
          reviewReport &&
          name === "commandHandler" &&
          /type:\s*["'](?:SubmitReview|SubmitReviewReply|SubmitMarketplaceReport)["']/.test(node.getText(ast));
        // Handler fixtures deliberately exercise invalid commands; transport callers are never exempt.
        if (
          (listing || !isTest) &&
          (activeMethods.has(name) ||
            (reviewReport ? reviewReportCommand : !listing && (offerCommand || policyCommand)))
        )
          add(node, name);
        if (
          reviewReport &&
          name === "$post" &&
          /client\.(?:reviews|listings)/.test(expression.getText(ast)) &&
          (/\.report\./.test(expression.getText(ast)) ||
            /^client\.reviews(?:\[.*\]\.reply)?\.\$post$/.test(expression.getText(ast)))
        )
          add(node, "typed-http-review-report");
        // HTTP transport producers (e.g. Playwright `request.post(url, { data })`). Route registrations
        // pass a handler, not an options object, so they never match.
        const [target, options] = node.arguments;
        const url = target && literalUrl(target, bindings);
        if (
          url &&
          options &&
          ts.isObjectLiteralExpression(options) &&
          ts.isPropertyAccessExpression(expression) &&
          /^(post|patch|put)$/.test(expression.name.text)
        ) {
          const command = (
            reviewReport ? httpReviewReportCommands : listing ? httpListingCommands : httpOfferCommands
          ).find(([pattern]) => pattern.test(url.split("?")[0]));
          if (command) add(node, command[1], options.getText(ast));
        }
      }
      if (
        ts.isJsxElement(node) &&
        /^(Form|RouterForm|ReviewMutationForm)$/.test(node.openingElement.tagName.getText(ast))
      ) {
        const call = node.getText(ast);
        if (
          reviewReport &&
          !isTest &&
          /name=["'](?:intent|rating)["']/.test(call) &&
          (/value=["'](?:report-listing|report-review|reply)["']/.test(call) || /name=["']rating["']/.test(call))
        )
          add(node, "review-report-form");
        if (
          !reviewReport &&
          !listing &&
          /name=["']intent["']\s+value=["'](?:decline-offer|accept-offer)["']/.test(call)
        ) {
          add(node, "offer-command-form");
        }
        if (
          listing &&
          (/name=["']intent["']\s+value=["'](?:create-listing|create-and-publish-listing|list-at-price|bulk-pause-listings|bulk-withdraw-listings|update-quantity-cap|update-purchase-limits|schedule-away-window|cancel-away-window|set-order-capacity|clear-order-capacity|disable-listings|enable-listings)["']/.test(
            call,
          ) ||
            imports.some((name) => name.endsWith("/listing-command-form")))
        )
          add(node, "listing-command-form");
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return callers.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

const reviewReportMethods = new Set(["submitReview", "submitReviewReply", "reportListing", "reportReview"]);
const httpReviewReportCommands = [
  [/\/reviews$/, "http-review-submit"],
  [/\/reviews\/[^/]+\/(?:reply|report)$/, "http-review-action"],
  [/\/listings\/[^/]+\/report$/, "http-listing-report"],
];
export function enumerateReviewReportAttemptCallers(sources) {
  return enumerateMarketplaceAttemptCallers(sources, false, true);
}

export const marketplaceReviewReportCallerPartition = new Map([
  ["bounded-contexts/marketplace/features/reviews/api/route.ts", "attempt-input"],
  ["bounded-contexts/marketplace/features/reports/api/route.ts", "attempt-input"],
  ["bounded-contexts/marketplace/support/route-support/review-submission-route.tsx", "attempt-input"],
  ["bounded-contexts/marketplace/support/route-support/review-report-action.ts", "attempt-input"],
  ["bounded-contexts/marketplace/support/route-support/listing-report-action.ts", "attempt-input"],
  ["bounded-contexts/marketplace/support/request-support/reputation-client.ts", "typed-forwarding"],
  ["bounded-contexts/marketplace/client.ts", "typed-forwarding"],
  ["bounded-contexts/marketplace/features/reviews/ui/review-submission-page.tsx", "attempt-form"],
  ["bounded-contexts/marketplace/features/reviews/ui/review-detail-page.tsx", "attempt-form"],
  ["bounded-contexts/marketplace/features/reviews/ui/review-report-action.tsx", "attempt-form"],
  ["bounded-contexts/marketplace/support/runtime-support/seed.ts", "fixed-review-stream-history"],
  ["deployables/corten-pilot/scripts/smoke-market-account.mjs", "invalid-report-probe"],
]);

export function unpartitionedReviewReportAttemptCallers(callers) {
  return callers.filter((caller) => {
    const proof = marketplaceReviewReportCallerPartition.get(caller.path);
    if (!proof) return true;
    const evidence = caller.identityEvidence ?? caller.call;
    if (proof === "attempt-form") return !/^<ReviewMutationForm\b/.test(caller.call);
    if (proof === "attempt-input") return !/\battemptId\b/.test(evidence);
    if (proof === "typed-forwarding") return !/json:\s*body/.test(caller.call);
    if (proof === "invalid-report-probe")
      return caller.method !== "http-review-action" || !/form:\s*\{\s*reason:\s*""\s*,/.test(caller.call);
    return (
      proof !== "fixed-review-stream-history" ||
      caller.method !== "commandHandler" ||
      !/streamId:\s*(buyer|seller)ReviewStreamId/.test(caller.call)
    );
  });
}

const listingMethods = new Set([
  "createListing",
  "createListingFromInventorySnapshot",
  "createListingWithPhotos",
  "publishListing",
  "pauseListing",
  "withdrawListing",
  "updateListingPrice",
  "updateListingQuantityCap",
  "updateListingPurchaseLimits",
  "disableSellerListingAvailability",
  "enableSellerListingAvailability",
  "scheduleSellerAwayWindow",
  "cancelScheduledAwayWindow",
  "setSellerOrderCapacity",
  "clearSellerOrderCapacity",
  "applyListingBatch",
  "applyBulkListingPriceUpdates",
]);
const httpListingCommands = [
  [/\/account\/listings$/, "http-listing-create"],
  [
    /\/account\/listings\/[^/]+\/(?:publish|pause|withdraw|price|quantity-cap|purchase-limits)$/,
    "http-listing-command",
  ],
  [/\/account\/listings\/(?:batch|prices\/bulk)$/, "http-listing-batch"],
  [/\/account\/(?:listing-availability\/(?:enable|disable|away-window)|order-capacity)$/, "http-seller-command"],
];
export function enumerateListingAttemptCallers(sources) {
  return enumerateMarketplaceAttemptCallers(sources, true);
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
  ["bounded-contexts/checkout/support/request-support/checkout-confirmation.ts::createSubmittedOffer", "attemptId"],
  [
    "bounded-contexts/checkout/features/sell-list/api/marketplace-handoff.ts::acceptOfferMatch",
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
  [
    "bounded-contexts/marketplace/support/runtime-support/seed.ts::commandHandler",
    "deterministic exemption: reserved Offer stream; complete owner-history reconciliation before authoring",
  ],
  ["contracts/catalog-seed/representative-commerce-state.ts::submitOffer", "attemptId"],
  ["contracts/catalog-seed/representative-commerce-state.ts::acceptOffer", "sourceActionKey"],
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

// Every tracked Listing command producer is assigned once; stream exemptions keep C2's complete-history proof.
export const marketplaceListingCallerPartition = new Map([
  ["bounded-contexts/inventory/features/inventory-items/ui/list-from-inventory-drawer.tsx", "form-attempt"],
  ["bounded-contexts/marketplace/features/listings/ui/listing-create-page.tsx", "form-attempt"],
  ["bounded-contexts/marketplace/features/listings/ui/listing-detail-page.tsx", "form-attempt"],
  ["bounded-contexts/marketplace/features/listings/ui/listing-list-page.tsx", "form-attempt"],
  ["bounded-contexts/marketplace/features/listings/ui/time-away-capacity-card.tsx", "form-attempt"],
  ["bounded-contexts/marketplace/features/listings/api/listing-caller-client.test.ts", "typed-owner-fixture"],
  ["deployables/platform-api/__tests__/listing-channel-activation-composition.db.test.ts", "typed-owner-fixture"],
  ["deployables/platform-api/__tests__/owner-predicate-enrollment.db.test.ts", "typed-owner-fixture"],
  [
    "bounded-contexts/channels/features/outbound-sync/api/runtime.ts",
    "Channels publication port, not Marketplace Listing commands",
  ],
  [
    "bounded-contexts/channels/features/publication-port/api/registry.ts",
    "Channels publication port, not Marketplace Listing commands",
  ],
  [
    "bounded-contexts/channels/features/publication-port/tests/channel-provider-registry-defaults.test.ts",
    "Channels publication port, not Marketplace Listing commands",
  ],
  [
    "bounded-contexts/channels/features/publication-port/tests/channel-publication-invocation-boundary.test.ts",
    "Channels publication port, not Marketplace Listing commands",
  ],
  ["bounded-contexts/checkout/features/sell-list/api/marketplace-handoff.ts", "caller-identity"],
  ["bounded-contexts/marketplace/features/channel-inbound-clamp/api/runtime.ts", "authoritative-stream"],
  [
    "bounded-contexts/marketplace/features/channel-inbound-clamp/tests/channel-inbound-clamp.db.test.ts",
    "typed-owner-fixture",
  ],
  ["bounded-contexts/marketplace/features/listings/api/mcp.ts", "mcp-attempt-boundary"],
  ["bounded-contexts/marketplace/features/listings/api/pricing-worker-audit.test.ts", "typed-owner-fixture"],
  ["bounded-contexts/marketplace/features/listings/api/route.ts", "http-attempt-boundary"],
  ["bounded-contexts/marketplace/features/listings/api/runtime.test.ts", "typed-owner-fixture"],
  ["bounded-contexts/marketplace/features/listings/api/runtime.ts", "owner-batch-and-import"],
  [
    "bounded-contexts/marketplace/features/listings/integrations/settlement/negative-balance-projection.ts",
    "caller-identity",
  ],
  [
    "bounded-contexts/marketplace/features/listings/tests/inventory-capacity-recovery.db.test.ts",
    "typed-owner-fixture",
  ],
  [
    "bounded-contexts/marketplace/features/listings/tests/inventory-snapshot-compatibility.db.test.ts",
    "typed-owner-fixture",
  ],
  ["bounded-contexts/marketplace/features/listings/tests/listing-attempt.db.test.ts", "typed-owner-fixture"],
  [
    "bounded-contexts/marketplace/features/listings/tests/listing-moderation-reaction.db.test.ts",
    "Pure domain command constructor, not a service caller",
  ],
  [
    "bounded-contexts/marketplace/features/listings/tests/seller-availability-restore-sweep-sql.db.test.ts",
    "typed-owner-fixture",
  ],
  [
    "bounded-contexts/marketplace/features/listings/tests/seller-away-window-sweep-sql.db.test.ts",
    "typed-owner-fixture",
  ],
  ["bounded-contexts/marketplace/support/runtime-support/seed.ts", "authoritative-stream"],
  ["bounded-contexts/marketplace/tests/safe-listing-feedback.test.ts", "typed-owner-fixture"],
  ["bounded-contexts/pricing/features/bulk-reprice-ingestion/api/runtime.ts", "caller-identity"],
  ["bounded-contexts/pricing/features/bulk-reprice-ingestion/api/wave-outcomes.ts", "caller-identity"],
  ["bounded-contexts/pricing/features/recommendations/api/runtime.ts", "caller-identity"],
  ["bounded-contexts/pricing/features/repricing-engine/api/runtime.ts", "caller-identity"],
  ["bounded-contexts/pricing/support/request-support/marketplace-listings.ts", "imported-client-forwarder"],
  ["bounded-contexts/pricing/support/runtime-support/worker-jobs.ts", "imported-service-forwarder"],
  ["contracts/catalog-seed/representative-commerce-state.ts", "authoritative-stream"],
  ["deployables/marketplace-seed-testing/tests/representative-commerce-state.test.ts", "typed-owner-fixture"],
  ["deployables/marketplace-seed-testing/tests/marketplace-seed.test.ts", "typed-owner-fixture"],
  ["infrastructure/platform-runtime/mcp.test.ts", "mcp-transport-fixture"],
]);

export function unpartitionedListingAttemptCallers(callers) {
  return callers.filter((caller) => {
    const proof = marketplaceListingCallerPartition.get(caller.path);
    const evidence = caller.identityEvidence ?? caller.call;
    if (!proof) return true;
    if (caller.method === "listing-command-form")
      return !/name=["']idempotencyKey["']|\/listing-command-form/.test(evidence);
    if (
      proof === "Channels publication port, not Marketplace Listing commands" ||
      proof === "Pure domain command constructor, not a service caller"
    )
      return false;
    if (proof === "mcp-transport-fixture")
      return !/idempotencyKey\s*:/.test(caller.call) || !/requestHash\s*:/.test(caller.call);
    if (proof === "typed-owner-fixture")
      return !/listingTestCommand|listingBulkTestCommand|idempotencyKey|batchId|key\(|as never|\b(?:body|params|keyed|base|owned|request|args|form)\b/.test(
        evidence,
      );
    if (proof === "transport-fixture") return !/listingTestCommand\(/.test(caller.call);
    if (proof === "mcp-attempt-boundary") return !/readListingAttempt\(args\)/.test(caller.call);
    if (proof === "http-attempt-boundary")
      return !/listingAttemptInput\(|\.\.\.attempt|batchId|parseListingLifecycleBatch/.test(evidence);
    if (proof === "imported-client-forwarder") return !/\(body, options\)/.test(caller.call);
    if (proof === "imported-service-forwarder") return !/\.\.\.body|idempotencyKey/.test(caller.call);
    if (
      caller.path === "bounded-contexts/pricing/features/repricing-engine/api/runtime.ts" &&
      caller.method === "applyBulkListingPriceUpdates"
    )
      return !/\(\{ updates \}\)/.test(caller.call);
    // The gateway batch is typed by the Marketplace client, which requires and parses batchId; the
    // unknown-target re-drive replays that same batch identity with the unchanged row requests.
    if (
      caller.path === "bounded-contexts/pricing/features/bulk-reprice-ingestion/api/wave-outcomes.ts" &&
      caller.method === "applyBulkListingPriceUpdates"
    )
      return !/\((?:batch|\{ \.\.\.batch, updates: unknownUpdates \})\)/.test(caller.call);
    return !/listingFormAttempt\(|idempotencyKey|batchId|\.\.\.keyed|\bkeyed\b/.test(evidence);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = readTrackedMarketplaceCallerSources(root);
  const listing = enumerateListingAttemptCallers(sources);
  const offer = enumerateMarketplaceAttemptCallers(sources);
  const violations = [...unpartitionedListingAttemptCallers(listing), ...unpartitionedMarketplaceOfferCallers(offer)];
  for (const caller of violations) console.error(`${caller.path}:${caller.line}: unpartitioned ${caller.method}`);
  if (violations.length) process.exitCode = 1;
  else
    console.log(
      `Marketplace attempt caller partition: ${listing.length} Listing and ${offer.length} Offer callers checked.`,
    );
}
