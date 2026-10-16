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
      "submitOffer|updateOfferPrice|acceptOffer|declineOfferMatch|createSubmittedOffer|updateSubmittedOfferPrice|acceptOfferMatch|commandBuyerOfferPolicy|BuyerOfferPolicyServices|createBuyerOfferPolicyRuntime|SubmitOffer|AcceptOffer|DeclineOfferMatch",
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

export function enumerateMarketplaceAttemptCallers(sources) {
  const callers = [];
  for (const file of sources) {
    const ast = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
    const isTest = imports.some((name) => /^(vitest|node:test|@playwright\/test)$/.test(name));
    if (isTest) continue;
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
    function visit(node) {
      if (ts.isCallExpression(node)) {
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
        if (methods.has(name) || offerCommand || policyCommand) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          callers.push({ path: file.path, method: name, line, call: node.getText(ast) });
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
]);

export function unpartitionedMarketplaceOfferCallers(callers) {
  return callers.filter((caller) => {
    const proof = marketplaceOfferCallerPartition.get(`${caller.path}::${caller.method}`);
    return (
      !proof || (["attemptId", "sourceActionKey"].includes(proof) && !new RegExp(`\\b${proof}\\s*:`).test(caller.call))
    );
  });
}
