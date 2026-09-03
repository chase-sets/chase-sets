import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const expectedInventory = [
  ["bounded-contexts/settlement/features/payouts/api/runtime.ts", "getCommittedPayoutLedgerEntry"],
  ["bounded-contexts/checkout/features/sessions/api/runtime.ts", "cleanupCommitMetadata"],
  ["bounded-contexts/checkout/features/sessions/api/runtime.ts", "existingStartedSession"],
  [
    "bounded-contexts/inventory/support/runtime-support/inventory-adjustment-idempotency.ts",
    "recoverInventoryAdjustmentIdempotency",
  ],
  ["bounded-contexts/catalog/features/product-measures/api/runtime.ts", "resolveCatalogItemMeasures"],
  ["bounded-contexts/catalog/features/product-contents/api/runtime.ts", "replaceProductContents"],
  ["bounded-contexts/marketplace/features/listings/api/runtime.ts", "findReplayedListingMutation"],
  ["bounded-contexts/marketplace/features/listings/api/runtime.ts", "listSellerListingFeeHistory"],
  ["bounded-contexts/customer-feedback/features/csat/api/runtime.ts", "loadCooldownClaim"],
  [
    "bounded-contexts/identity/support/runtime-support/registration-operation.ts",
    "readCompleteRegistrationStreamHistory",
  ],
  ["infrastructure/platform-policy/consent-activation-authority.ts", "readAuthorityEvents"],
];

function trackedTypeScriptFilesContaining(token) {
  return execFileSync("git", ["grep", "-l", "-z", "-F", token, "--", "*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  })
    .split("\0")
    .filter(Boolean);
}

function sourceFile(relativeFile) {
  return ts.createSourceFile(
    relativeFile,
    readFileSync(path.join(repoRoot, relativeFile), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function callName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isPropertyAssignment(parent) && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))) {
      return parent.name.text;
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
  }
  return null;
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    const name = functionName(current);
    if (name) return { name, node: current };
  }
  return null;
}

function callsInFile(relativeFile, targetName) {
  const file = sourceFile(relativeFile);
  const calls = [];
  function visit(node) {
    if (callName(node) === targetName) {
      const owner = enclosingFunction(node);
      calls.push({ owner: owner?.name ?? null, ownerNode: owner?.node ?? null });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

function callsInside(node, targetName) {
  const calls = [];
  function visit(current) {
    if (current !== node && functionName(current)) return;
    if (callName(current) === targetName) calls.push(current);
    ts.forEachChild(current, visit);
  }
  visit(node);
  return calls;
}

describe("issue-6299-acceptance-control", () => {
  it("derives the exact tracked nine-file, eleven-symbol complete-reader inventory from syntax", () => {
    const actual = [];
    for (const relativeFile of [...new Set(expectedInventory.map(([file]) => file))]) {
      for (const call of callsInFile(relativeFile, "readCompleteStream")) {
        actual.push([relativeFile, call.owner]);
        expect(
          call.ownerNode,
          `${relativeFile}:${call.owner ?? "unknown"} must have an enclosing function`,
        ).not.toBeNull();
        expect(
          callsInside(call.ownerNode, "readStream"),
          `${relativeFile}:${call.owner} must not retain direct or bespoke page reads`,
        ).toEqual([]);
      }
    }

    expect(actual).toEqual(expectedInventory);
  });

  it("derives the complete registration-history caller inventory from tracked production sources", () => {
    const callers = trackedTypeScriptFilesContaining("readCompleteRegistrationStreamHistory")
      .filter((relativeFile) => !relativeFile.endsWith(".test.ts") && !relativeFile.includes("/tests/"))
      .flatMap((relativeFile) =>
        callsInFile(relativeFile, "readCompleteRegistrationStreamHistory")
          .filter((call) => call.owner !== "readCompleteRegistrationStreamHistory")
          .map((call) => [relativeFile, call.owner]),
      );

    expect(callers).toEqual([
      ["bounded-contexts/identity/api.ts", "readRegistrationParticipant"],
      ["bounded-contexts/identity/support/runtime-support/registration-operation.ts", "readRegistrationOperationClaim"],
    ]);
  });

  it("rejects count-derived expected-version and authority-boundary bypasses", () => {
    for (const relativeFile of [
      "bounded-contexts/catalog/features/product-measures/api/runtime.ts",
      "bounded-contexts/catalog/features/product-contents/api/runtime.ts",
    ]) {
      const source = readFileSync(path.join(repoRoot, relativeFile), "utf8");
      expect(source).toContain("existingEvents.at(-1)?.streamVersion ?? 0");
      expect(source).not.toMatch(/currentVersion\s*=\s*existingEvents\.length/);
    }

    const authoritySource = readFileSync(
      path.join(repoRoot, "infrastructure/platform-policy/consent-activation-authority.ts"),
      "utf8",
    );
    expect(authoritySource).toContain("maxEvents: MAX_AUTHORITY_HISTORY_EVENTS - 1");
    expect(authoritySource).toContain("error instanceof EventStreamTooLongError");
    expect(authoritySource).toContain("storedEvents.at(-1)?.streamVersion ?? 0");
    expect(authoritySource).not.toMatch(/authorityVersion\s*=\s*storedEvents\.length/);
  });
});
