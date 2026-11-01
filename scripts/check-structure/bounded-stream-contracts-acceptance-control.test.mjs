import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const trackedTypeScriptFiles = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: GIT_LISTING_MAX_BUFFER,
})
  .split("\0")
  .filter(Boolean);
const trackedFiles = new Set(
  execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(Boolean),
);

const boundedSites = [
  {
    id: "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts#readStream#1",
    pointer:
      "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.test.ts",
    consumption: "presence",
  },
  {
    id: "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts#readStream#2",
    pointer:
      "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.test.ts",
    consumption: "presence",
  },
  {
    id: "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#1",
    pointer: "bounded-contexts/channels/features/manual-sync/api/seed.db.test.ts",
    consumption: "presence",
  },
  {
    id: "bounded-contexts/channels/features/manual-sync/api/seed.ts#readStream#2",
    pointer: "bounded-contexts/channels/features/manual-sync/api/seed.db.test.ts",
    consumption: "presence",
  },
  {
    id: "bounded-contexts/identity/api.ts#readStream#1",
    pointer: "bounded-contexts/identity/tests/registration-operation-recovery.db.test.ts",
    consumption: "presence",
  },
];

const expectedInventory = [
  ...boundedSites.map(({ id }) => [id, "1"]),
  // The authority-tracking decorator forwards the caller's complete read request.
  [
    "bounded-contexts/catalog/features/source-observations/api/promotion/promotion-material-guards.ts#readStream#1",
    null,
  ],
  // Fenced enrollment reads the creation event; its decorator still forwards complete caller requests.
  ["bounded-contexts/identity/features/account-management/api/fences.ts#readStream#1", "1"],
  ["bounded-contexts/identity/features/account-management/api/fences.ts#readStream#2", null],
  // Evidence Access Attempt audit pages are explicit cursor pages that report nextCursor.
  ["bounded-contexts/platform-operations/features/support-requests/api/evidence-access-audit.ts#readStream#1", "51"],
  [
    "bounded-contexts/platform-operations/features/support-requests/api/participant-store-matrix.test-data.ts#readStream#1",
    null,
  ],
  [
    "bounded-contexts/platform-operations/features/support-requests/api/participant-store-matrix.test-data.ts#readStream#2",
    null,
  ],
  ["contracts/event-core/complete-stream.ts#readStream#1", "EVENT_STORE_READ_PAGE_SIZE_MAX"],
  // The owner-transaction adapter forwards the complete request unchanged.
  ["bounded-contexts/inventory/support/runtime-support/mutation-attempt.ts#readStream#1", null],
  // The owner-checking lookup reader forwards the complete history request unchanged.
  ["bounded-contexts/marketplace/features/mutation-recovery/api/lookup.ts#readStream#1", null],
  // Listing-attempt owner lookup forwards the complete history request unchanged.
  ["bounded-contexts/marketplace/features/listings/api/listing-attempt.ts#readStream#1", null],
  // Synthetic policy discovery rejects streams that reach this bounded lifecycle cap.
  ["bounded-contexts/pricing/support/runtime-support/pricing-health-browser-seed.ts#readStream#1", "10"],
  // The existing corpus includes slice-local .test-support.ts history assertions.
  [
    "bounded-contexts/identity/features/account-capabilities/api/assignment-contract.test-support.ts#readStream#1",
    null,
  ],
  [
    "bounded-contexts/identity/features/account-capabilities/api/assignment-contract.test-support.ts#readStream#2",
    null,
  ],
  ["infrastructure/bounded-context-runtime/subscriptions.ts#readStream#1", "pageLimit"],
  ["infrastructure/bounded-context-runtime/subscriptions.ts#readStream#2", "batchSize"],
].sort(([left], [right]) => left.localeCompare(right));

const program = ts.createProgram({
  rootNames: trackedTypeScriptFiles.map((file) => path.join(repoRoot, file)),
  options: {
    allowJs: false,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  },
});
const candidateInventory = deriveProgramInventory(program);

describe("bounded-stream-contracts-acceptance-control", () => {
  it("derives the exact nineteen-call corpus and five production pointer/test bindings from one TypeScript Program", () => {
    expect(acceptanceErrors(candidateInventory)).toEqual([]);
    expect(candidateInventory.map((site) => [site.id, site.limit])).toEqual(expectedInventory);
  });

  it("keeps the Marketplace lookup reader's complete history request unchanged", () => {
    const site = candidateInventory.find((candidate) =>
      candidate.id.endsWith("mutation-recovery/api/lookup.ts#readStream#1"),
    );
    expect(site).toBeDefined();
    expect(site.call.arguments.map((argument) => argument.getText(site.source))).toEqual(["request"]);
    expect(site.limit).toBeNull();
    const file = site.file;
    expect(
      errorCodes(
        mutatedInventory(
          file,
          readSource(file).replace("eventStore.readStream(request)", "eventStore.readStream({ ...request, limit: 1 })"),
        ),
      ),
    ).toContain("inventory-mismatch");
  });

  it("retains the synthetic Pricing Health lifecycle cap and truncation refusal", () => {
    const file = "bounded-contexts/pricing/support/runtime-support/pricing-health-browser-seed.ts";
    const site = candidateInventory.find((candidate) => candidate.file === file);
    expect(site.limit).toBe("10");
    expect(readSource(file)).toContain("events.length >= 10");
    expect(errorCodes(mutatedInventory(file, readSource(file).replace("limit: 10", "limit: 11")))).toContain(
      "inventory-mismatch",
    );
  });

  it("keeps the Identity eligibility adapter's complete read request unchanged", () => {
    const site = candidateInventory.find((candidate) =>
      candidate.id.endsWith("account-management/api/fences.ts#readStream#2"),
    );
    expect(site).toBeDefined();
    expect(site.call.arguments[0].getText(site.source)).toBe("input");
    expect(site.limit).toBeNull();
  });

  it("limits the Identity enrollment read to exactly the creation event", () => {
    const site = candidateInventory.find((candidate) =>
      candidate.id.endsWith("account-management/api/fences.ts#readStream#1"),
    );
    expect(site).toBeDefined();
    expect(site.call.arguments.map((argument) => argument.getText(site.source))).toEqual([
      "{ streamId: input.streamId, fromVersion: 1, limit: 1 }",
    ]);
    expect(site.limit).toBe("1");
    const file = site.file;
    const source = readSource(file);
    expect(
      errorCodes(mutatedInventory(file, source.replace("fromVersion: 1, limit: 1", "fromVersion: 1, limit: 2"))),
    ).toContain("inventory-mismatch");
    expect(
      errorCodes(
        mutatedInventory(
          file,
          source.replace(
            "readStream: (input) => store.readStream(input)",
            "readStream: (input) => store.readStream({ ...input, limit: 1 })",
          ),
        ),
      ),
    ).toContain("inventory-mismatch");
  });

  it("keeps the promotion authority decorator's page request unchanged", () => {
    const site = candidateInventory.find((candidate) =>
      candidate.id.endsWith("promotion-material-guards.ts#readStream#1"),
    );
    expect(site).toBeDefined();
    expect(site.call.arguments.map((argument) => argument.getText(site.source))).toEqual(["request"]);
  });

  it("keeps the Inventory owner-transaction adapter's complete read request unchanged", () => {
    const site = candidateInventory.find((candidate) => candidate.id.endsWith("mutation-attempt.ts#readStream#1"));
    expect(site).toBeDefined();
    expect(site.call.arguments.map((argument) => argument.getText(site.source))).toEqual(["input"]);
  });

  it("keeps test support free of a ninth direct readStream call", () => {
    expect(candidateInventory.filter((site) => site.file === "contracts/event-core/test-support.ts")).toEqual([]);
  });

  it("rejects missing, duplicate, nonexistent, cross-workspace, and scripts-only pointers", () => {
    const identityFile = "bounded-contexts/identity/api.ts";
    const identitySite = boundedSites.find((site) => site.id === "bounded-contexts/identity/api.ts#readStream#1");
    const identityPointer = identitySite.pointer;
    const source = readSource(identityFile);

    expect(
      errorCodes(
        mutatedInventory(
          identityFile,
          source.replace(`// @stream-read-contract ${identityPointer}`, "// pointer intentionally removed"),
        ),
      ),
    ).toContain("pointer-missing");
    expect(
      errorCodes(
        mutatedInventory(
          identityFile,
          source.replace(
            `// @stream-read-contract ${identityPointer}`,
            `// @stream-read-contract ${identityPointer}\n      // @stream-read-contract ${identityPointer}`,
          ),
        ),
      ),
    ).toContain("pointer-duplicate");
    expect(
      errorCodes(
        mutatedInventory(
          identityFile,
          source.replace(identityPointer, "bounded-contexts/identity/support/request-support/not-a-test.test.ts"),
        ),
      ),
    ).toContain("pointer-nonexistent");
    expect(
      errorCodes(
        mutatedInventory(
          identityFile,
          source.replace(identityPointer, "bounded-contexts/auth/support/api-support/password-routes.test.ts"),
        ),
      ),
    ).toContain("pointer-cross-workspace");
    expect(
      errorCodes(
        mutatedInventory(identityFile, source.replace(identityPointer, "scripts/check-structure/example.test.ts")),
      ),
    ).toContain("pointer-scripts-only");
  });

  it("rejects a pointed owning test that omits its literal derived site ID", () => {
    const site = boundedSites.find((candidate) => candidate.id === "bounded-contexts/identity/api.ts#readStream#1");
    const target = readSource(site.pointer).replace(site.id, `${site.id}-missing`);
    expect(errorCodes(candidateInventory, new Map([[site.pointer, target]]))).toContain("pointer-site-id-missing");
  });

  it("rejects bound, result-binding, later-event, and whole-page consumption mutants", () => {
    const identityFile = "bounded-contexts/identity/api.ts";
    const identitySource = readSource(identityFile);
    expect(errorCodes(mutatedInventory(identityFile, identitySource.replace("limit: 1,", "")))).toContain(
      "bounded-limit-not-one",
    );

    const catalogFile =
      "bounded-contexts/catalog/features/source-observations/api/source-observation-merge-candidate-runtime.ts";
    const catalogSource = readSource(catalogFile);
    expect(
      errorCodes(
        mutatedInventory(
          catalogFile,
          catalogSource.replace("existingEvents.length > 0", "existingEvents.some(Boolean)"),
        ),
      ),
    ).toContain("presence-consumption-changed");
  });
});

function deriveProgramInventory(compilerProgram) {
  return compilerProgram
    .getSourceFiles()
    .flatMap((sourceFile) => {
      const relativeFile = normalizePath(path.relative(repoRoot, sourceFile.fileName));
      if (!trackedFiles.has(relativeFile) || !isProductionFile(relativeFile)) return [];
      const parsedSource = ts.createSourceFile(
        relativeFile,
        sourceFile.text,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(relativeFile),
      );
      return deriveFileCalls(relativeFile, parsedSource);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function deriveFileCalls(relativeFile, source) {
  const calls = [];
  visit(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "readStream"
    ) {
      calls.push(node);
    }
  });

  return calls.map((call, index) => {
    const statement = enclosingStatement(call);
    const limit = readLimit(call, source);
    return {
      id: `${relativeFile}#readStream#${index + 1}`,
      file: relativeFile,
      limit,
      call,
      source,
      statement,
      pointers: statement ? structuredPointers(statement, source) : [],
    };
  });
}

function mutatedInventory(relativeFile, sourceText) {
  const source = ts.createSourceFile(relativeFile, sourceText, ts.ScriptTarget.Latest, true, scriptKind(relativeFile));
  return [
    ...candidateInventory.filter((site) => site.file !== relativeFile),
    ...deriveFileCalls(relativeFile, source),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

function acceptanceErrors(inventory, targetOverrides = new Map()) {
  const errors = [];
  const actualInventory = inventory.map((site) => [site.id, site.limit]);
  if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
    errors.push({ code: "inventory-mismatch" });
  }

  for (const expected of boundedSites) {
    const site = inventory.find((candidate) => candidate.id === expected.id);
    if (!site) {
      errors.push({ code: "bounded-site-missing", siteId: expected.id });
      continue;
    }
    if (site.limit !== "1") errors.push({ code: "bounded-limit-not-one", siteId: expected.id });
    validateConsumption(site, expected.consumption, errors);
    validatePointer(site, targetOverrides, errors);
  }
  return errors;
}

function validateConsumption(site, expectedConsumption, errors) {
  const declaration = enclosingVariableDeclaration(site.call);
  const variableName = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
  const scope = site.statement?.parent;
  if (!variableName || !scope) {
    errors.push({ code: "read-result-not-bound", siteId: site.id });
    return;
  }

  const indices = [];
  const lengthComparisons = [];
  visit(scope, (node) => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === variableName
    ) {
      indices.push(node.argumentExpression?.getText(site.source) ?? "");
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === variableName &&
      node.name.text === "length"
    ) {
      const parent = node.parent;
      lengthComparisons.push(
        ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
          parent.right.getText(site.source) === "0",
      );
    }
  });

  if (
    expectedConsumption === "presence" &&
    (indices.length !== 0 || lengthComparisons.length !== 1 || !lengthComparisons[0])
  ) {
    errors.push({ code: "presence-consumption-changed", siteId: site.id });
  }
}

function validatePointer(site, targetOverrides, errors) {
  if (site.pointers.length === 0) {
    errors.push({ code: "pointer-missing", siteId: site.id });
    return;
  }
  if (site.pointers.length !== 1) {
    errors.push({ code: "pointer-duplicate", siteId: site.id });
    return;
  }

  const pointer = normalizePath(site.pointers[0]);
  if (pointer.startsWith("scripts/")) {
    errors.push({ code: "pointer-scripts-only", siteId: site.id });
    return;
  }
  const owningWorkspace = /^bounded-contexts\/([^/]+)\//.exec(site.file)?.[1];
  const pointedWorkspace = /^bounded-contexts\/([^/]+)\//.exec(pointer)?.[1];
  if (!owningWorkspace || pointedWorkspace !== owningWorkspace) {
    errors.push({ code: "pointer-cross-workspace", siteId: site.id });
    return;
  }
  if (!pointer.endsWith(".test.ts") || !existsSync(path.join(repoRoot, pointer))) {
    errors.push({ code: "pointer-nonexistent", siteId: site.id });
    return;
  }

  const targetSource = targetOverrides.get(pointer) ?? readSource(pointer);
  const target = ts.createSourceFile(pointer, targetSource, ts.ScriptTarget.Latest, true, scriptKind(pointer));
  let carriesSiteId = false;
  visit(target, (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === site.id) {
      carriesSiteId = true;
    }
  });
  if (!carriesSiteId) errors.push({ code: "pointer-site-id-missing", siteId: site.id });
}

function readLimit(call, source) {
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        property.name &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "limit"
      ) {
        return property.initializer.getText(source);
      }
    }
  }
  return null;
}

function structuredPointers(statement, source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard);
  scanner.setText(statement.getFullText(source));
  const pointers = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const match = /@stream-read-contract\s+(\S+)/.exec(scanner.getTokenText());
    if (match) pointers.push(match[1]);
  }
  return pointers;
}

function enclosingStatement(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return null;
}

function enclosingVariableDeclaration(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isVariableDeclaration(current)) return current;
    if (ts.isStatement(current)) return null;
  }
  return null;
}

function visit(root, callback) {
  const walk = (node) => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

function isProductionFile(relativeFile) {
  return (
    !relativeFile.startsWith("scripts/") &&
    !relativeFile.includes("/tests/") &&
    !relativeFile.includes("/__tests__/") &&
    !/\.(test|spec)\.[cm]?tsx?$/.test(relativeFile)
  );
}

function scriptKind(relativeFile) {
  return relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function readSource(relativeFile) {
  return readFileSync(path.join(repoRoot, relativeFile), "utf8");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function errorCodes(inventory, targetOverrides) {
  return acceptanceErrors(inventory, targetOverrides).map((error) => error.code);
}
