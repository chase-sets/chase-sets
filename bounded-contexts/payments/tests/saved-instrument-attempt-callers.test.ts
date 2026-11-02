import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "@chase-sets/typescript-compiler-api";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Saved-instrument setup, default and remove methods of `PaymentServices` and `client.ts`. */
const ATTEMPT_PRODUCING_METHODS = new Set([
  "createSavedCheckoutSetupSession",
  "setSavedCheckoutInstrumentDefault",
  "removeSavedCheckoutInstrument",
  "createSavedPaymentSetupSession",
  "setDefaultPaymentMethod",
  "removePaymentMethod",
]);

/**
 * Named read-only exemptions: they read provider or local state and never start an attempt. UCP
 * handoff has no tracked caller at this head; one added later must be classified here or fail.
 */
const READ_ONLY_EXEMPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  "setup reconcile": new Set(["reconcileSavedCheckoutSetupSession", "reconcileSavedPaymentSetupSession"]),
  "instrument reconcile": new Set(["reconcileSavedCheckoutInstruments", "reconcilePaymentMethods"]),
  "UCP handoff": new Set(),
};

/**
 * The closed partition: every production call site, as `path#method`. Gateway-direct detaches
 * (`processorGateway.detachSavedPaymentMethod`) and webhook persistence are not these methods and
 * fall outside; test files are fixtures, not callers.
 */
const EXPECTED_PARTITION: Readonly<Record<string, string>> = {
  "bounded-contexts/payments/features/payments/api/mcp.ts#createSavedCheckoutSetupSession": "attempt-producing",
  "bounded-contexts/payments/features/payments/api/mcp.ts#reconcileSavedCheckoutSetupSession": "setup reconcile",
  "bounded-contexts/payments/features/payments/api/route.ts#createSavedCheckoutSetupSession": "attempt-producing",
  "bounded-contexts/payments/features/payments/api/route.ts#reconcileSavedCheckoutInstruments": "instrument reconcile",
  "bounded-contexts/payments/features/payments/api/route.ts#reconcileSavedCheckoutSetupSession": "setup reconcile",
  "bounded-contexts/payments/features/payments/api/route.ts#removeSavedCheckoutInstrument": "attempt-producing",
  "bounded-contexts/payments/features/payments/api/route.ts#setSavedCheckoutInstrumentDefault": "attempt-producing",
  "bounded-contexts/payments/features/payments/ui/account-payment/stripe-setup-card.tsx#reconcileSavedPaymentSetupSession":
    "setup reconcile",
  "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx#createSavedPaymentSetupSession":
    "attempt-producing",
  "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx#reconcilePaymentMethods":
    "instrument reconcile",
  "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx#reconcileSavedPaymentSetupSession":
    "setup reconcile",
  "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx#removePaymentMethod": "attempt-producing",
  "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx#setDefaultPaymentMethod":
    "attempt-producing",
};

const trackedMethods = new Set([
  ...ATTEMPT_PRODUCING_METHODS,
  ...Object.values(READ_ONLY_EXEMPTIONS).flatMap((set) => [...set]),
]);

type SourceFile = Readonly<{ path: string; source: string }>;

/** Tracked (`git ls-files`) production sources that mention any tracked method name. */
function trackedProductionSources(): SourceFile[] {
  return execFileSync(
    "git",
    ["grep", "-l", "-E", [...trackedMethods].join("|"), "--", "*.ts", "*.tsx", "*.mts", "*.mjs"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\n")
    .filter((path) => path && !/\.(test|spec)\.[cm]?tsx?$|\/test-support\/|\/e2e\//.test(path))
    .map((path) => ({ path, source: readFileSync(`${repoRoot}${path}`, "utf8") }));
}

/** Classifies each `<receiver>.<method>(...)` call; an attempt-producing call must pass an attempt. */
function partitionSavedInstrumentCallers(files: readonly SourceFile[]) {
  const sites = new Map<string, string>();
  const violations: string[] = [];
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        trackedMethods.has(node.expression.name.text)
      ) {
        const method = node.expression.name.text;
        const site = `${file.path}#${method}`;
        const exemption = Object.entries(READ_ONLY_EXEMPTIONS).find(([, methods]) => methods.has(method))?.[0];
        const passesAttempt = node.arguments.some((argument) => /\battempt(Id)?\b/.test(argument.getText(sourceFile)));
        const kind = exemption ?? (passesAttempt ? "attempt-producing" : "attempt-missing");
        if (kind === "attempt-missing") violations.push(`${site} does not pass a Saved Checkout Instrument Attempt`);
        sites.set(site, sites.get(site) === "attempt-missing" ? "attempt-missing" : kind);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const actual = Object.fromEntries([...sites.entries()].sort(([left], [right]) => left.localeCompare(right)));
  for (const site of Object.keys(actual)) {
    if (!(site in EXPECTED_PARTITION)) violations.push(`${site} is an unclassified caller`);
  }
  for (const site of Object.keys(EXPECTED_PARTITION)) {
    if (!(site in actual)) violations.push(`${site} is a stale partition entry`);
  }
  return { actual, violations };
}

describe("saved instrument attempt callers", () => {
  it("issue-7170-s1-caller-partition", () => {
    const files = trackedProductionSources();
    const { actual, violations } = partitionSavedInstrumentCallers(files);
    expect(violations).toEqual([]);
    expect(actual).toEqual(EXPECTED_PARTITION);

    // Planted caller: a new production file that calls remove without an attempt is refused.
    const planted = partitionSavedInstrumentCallers([
      ...files,
      {
        path: "bounded-contexts/ordering/planted-caller.ts",
        source:
          "export const plant = (services: any) => services.removeSavedCheckoutInstrument({ instrumentId: 'x' }, ctx);",
      },
    ]);
    expect(planted.violations).toEqual([
      "bounded-contexts/ordering/planted-caller.ts#removeSavedCheckoutInstrument does not pass a Saved Checkout Instrument Attempt",
      "bounded-contexts/ordering/planted-caller.ts#removeSavedCheckoutInstrument is an unclassified caller",
    ]);

    // Working-tree mutant: the shipped route stops forwarding the form's attempt id.
    const mutated = partitionSavedInstrumentCallers(
      files.map((file) =>
        file.path.endsWith("features/payments/api/route.ts")
          ? { ...file, source: file.source.replaceAll("attemptId: command.attemptId,", "") }
          : file,
      ),
    );
    expect(mutated.violations).toEqual(
      ["createSavedCheckoutSetupSession", "setSavedCheckoutInstrumentDefault", "removeSavedCheckoutInstrument"].map(
        (method) =>
          `bounded-contexts/payments/features/payments/api/route.ts#${method} does not pass a Saved Checkout Instrument Attempt`,
      ),
    );
  });
});
