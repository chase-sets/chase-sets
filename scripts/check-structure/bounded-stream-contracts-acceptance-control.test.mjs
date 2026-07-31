import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const trackedTypeScriptFiles = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], {
  cwd: repoRoot,
  encoding: "utf8",
  windowsHide: true,
})
  .split("\0")
  .filter(Boolean);
const trackedFiles = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", windowsHide: true })
    .split("\0")
    .filter(Boolean),
);

const boundedSites = [
  {
    id: "bounded-contexts/auth/support/request-support/csat-outcome-facts.ts#readStream#1",
    pointer: "bounded-contexts/auth/support/request-support/csat-outcome-facts.test.ts",
    consumption: "first-event",
  },
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
    id: "bounded-contexts/discovery/support/request-support/csat-outcome-facts.ts#readStream#1",
    pointer: "bounded-contexts/discovery/support/request-support/csat-outcome-facts.test.ts",
    consumption: "first-event",
  },
  {
    id: "bounded-contexts/identity/api.ts#readStream#1",
    pointer: "bounded-contexts/identity/tests/registration-operation-recovery.db.test.ts",
    consumption: "presence",
  },
  {
    id: "bounded-contexts/identity/support/request-support/csat-outcome-facts.ts#readStream#1",
    pointer: "bounded-contexts/identity/support/request-support/csat-outcome-facts.test.ts",
    consumption: "first-event",
  },
];

const expectedInventory = [
  ...boundedSites.map(({ id }) => [id, "1"]),
  ["contracts/event-core/complete-stream.ts#readStream#1", "EVENT_STORE_READ_PAGE_SIZE_MAX"],
  ["infrastructure/bounded-context-runtime/subscriptions.ts#readStream#1", "batchSize"],
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
  it("derives the exact eight-call production census and six pointer/test bindings from one TypeScript Program", () => {
    expect(acceptanceErrors(candidateInventory)).toEqual([]);
    expect(candidateInventory.map((site) => [site.id, site.limit])).toEqual(expectedInventory);
  });

  it("keeps test support free of a ninth direct readStream call", () => {
    expect(candidateInventory.filter((site) => site.file === "contracts/event-core/test-support.ts")).toEqual([]);
  });

  it("rejects missing, duplicate, nonexistent, cross-workspace, and scripts-only pointers", () => {
    const authFile = "bounded-contexts/auth/support/request-support/csat-outcome-facts.ts";
    const authPointer = boundedSites[0].pointer;
    const source = readSource(authFile);

    expect(
      errorCodes(
        mutatedInventory(
          authFile,
          source.replace(`// @stream-read-contract ${authPointer}`, "// pointer intentionally removed"),
        ),
      ),
    ).toContain("pointer-missing");
    expect(
      errorCodes(
        mutatedInventory(
          authFile,
          source.replace(
            `// @stream-read-contract ${authPointer}`,
            `// @stream-read-contract ${authPointer}\n      // @stream-read-contract ${authPointer}`,
          ),
        ),
      ),
    ).toContain("pointer-duplicate");
    expect(
      errorCodes(
        mutatedInventory(
          authFile,
          source.replace(authPointer, "bounded-contexts/auth/support/request-support/not-a-test.test.ts"),
        ),
      ),
    ).toContain("pointer-nonexistent");
    expect(
      errorCodes(
        mutatedInventory(
          authFile,
          source.replace(authPointer, "bounded-contexts/discovery/support/request-support/csat-outcome-facts.test.ts"),
        ),
      ),
    ).toContain("pointer-cross-workspace");
    expect(
      errorCodes(mutatedInventory(authFile, source.replace(authPointer, "scripts/check-structure/example.test.ts"))),
    ).toContain("pointer-scripts-only");
  });

  it("rejects a pointed owning test that omits its literal derived site ID", () => {
    const site = boundedSites[0];
    const target = readSource(site.pointer).replace(site.id, `${site.id}-missing`);
    expect(errorCodes(candidateInventory, new Map([[site.pointer, target]]))).toContain("pointer-site-id-missing");
  });

  it("rejects bound, result-binding, later-event, and whole-page consumption mutants", () => {
    const authFile = "bounded-contexts/auth/support/request-support/csat-outcome-facts.ts";
    const authSource = readSource(authFile);
    expect(errorCodes(mutatedInventory(authFile, authSource.replace(", limit: 1", "")))).toContain(
      "bounded-limit-not-one",
    );
    expect(
      errorCodes(mutatedInventory(authFile, authSource.replace("existing[0]?.payload", "existing.at(0)?.payload"))),
    ).toContain("first-event-consumption-changed");
    expect(errorCodes(mutatedInventory(authFile, authSource.replaceAll("existing[0]", "existing[1]")))).toContain(
      "first-event-consumption-changed",
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

  if (expectedConsumption === "first-event" && (indices.length !== 2 || indices.some((index) => index !== "0"))) {
    errors.push({ code: "first-event-consumption-changed", siteId: site.id });
  }
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
