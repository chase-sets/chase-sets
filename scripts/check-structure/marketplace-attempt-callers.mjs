import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
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
      "submitOffer|updateOfferPrice|acceptOffer|declineOfferMatch|createSubmittedOffer|updateSubmittedOfferPrice|acceptOfferMatch|commandBuyerOfferPolicy|BuyerOfferPolicyServices|createBuyerOfferPolicyRuntime|SubmitOffer|AcceptOffer|DeclineOfferMatch|marketplace\\.(submit-offer|counter-offer|update-offer-price|accept-offer|decline-offer)|decline-offer|offers/submitted|offers/matches/|offer-policies/",
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
