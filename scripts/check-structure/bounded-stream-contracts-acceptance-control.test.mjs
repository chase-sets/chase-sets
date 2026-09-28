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
  ...[1, 2].map((ordinal) => ({
    id: `bounded-contexts/marketplace/features/listings/api/listing-request.ts#readStream#${ordinal}`,
    pointer: "bounded-contexts/marketplace/features/listings/api/listing-request.test.ts",
    consumption: "singleton",
    limit: "2",
  })),
  {
    id: "bounded-contexts/marketplace/features/listings/api/runtime.ts#readStream#1",
    pointer: "bounded-contexts/marketplace/features/listings/api/channel-only-create.test.ts",
    consumption: "creation",
  },
  ...[1, 2].map((ordinal) => ({
    id: `infrastructure/platform-runtime/listing-authority-conformance.ts#readStream#${ordinal}`,
    pointer: "infrastructure/platform-runtime/listing-authority-session.test.ts",
    consumption: `synthetic-count-${ordinal - 1}`,
    limit: null,
  })),
  {
    id: "infrastructure/platform-runtime/listing-authority-history-conformance.ts#readStream#1",
    pointer: "infrastructure/platform-runtime/listing-authority-history.test.ts",
    consumption: "synthetic-count-0",
    limit: null,
  },
  {
    id: "infrastructure/platform-runtime/listing-authority-history-test-support.ts#readStream#1",
    pointer: "infrastructure/platform-runtime/listing-authority-history.test.ts",
    consumption: "synthetic-baseline",
    limit: null,
  },
  {
    id: "infrastructure/platform-runtime/listing-authority-writer.ts#readStream#1",
    pointer: "infrastructure/platform-runtime/listing-authority-writer.test.ts",
    consumption: "forward-input",
    limit: null,
  },
];

const expectedInventory = [
  ...boundedSites.map((site) => [site.id, expectedLimit(site)]),
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
  it("derives the exact registered census and owning test bindings from one TypeScript Program", () => {
    expect(acceptanceErrors(candidateInventory)).toEqual([]);
    expect(candidateInventory.map((site) => [site.id, site.limit])).toEqual(expectedInventory);
  });

  it.each(boundedSites.slice(8))("enforces $id and its owning consumption contract", (expected) => {
    const site = candidateInventory.find((candidate) => candidate.id === expected.id);
    expect(site).toBeDefined();
    expect(site.limit).toBe(expectedLimit(expected));
    const errors = [];
    validateConsumption(site, expected.consumption, errors);
    validatePointer(site, new Map(), errors);
    expect(errors).toEqual([]);
  });

  it("rejects singleton overflow, later-event and bound mutations independently at both request sites", () => {
    const file = "bounded-contexts/marketplace/features/listings/api/listing-request.ts";
    const source = readSource(file);
    for (const mutated of [
      source.replaceAll("events.length !== 1", "events.length > 2"),
      source.replaceAll("events[0]", "events[1]"),
    ]) {
      const errors = acceptanceErrors(mutatedInventory(file, mutated));
      for (const ordinal of [1, 2])
        expect(errors).toContainEqual({
          code: "singleton-consumption-changed",
          siteId: `${file}#readStream#${ordinal}`,
        });
    }
    expect(errorCodes(mutatedInventory(file, source.replaceAll("limit: 2", "limit: 1")))).toContain(
      "bounded-limit-changed",
    );
  });

  it("rejects creation tail selection and synthetic count/baseline and forwarding mutations", () => {
    const mutants = [
      [
        "bounded-contexts/marketplace/features/listings/api/runtime.ts",
        "const [created]",
        "const [, created]",
        "creation-consumption-changed",
      ],
      [
        "infrastructure/platform-runtime/listing-authority-conformance.ts",
        ")).length, 0",
        ")).length, 1",
        "synthetic-consumption-changed",
      ],
      [
        "infrastructure/platform-runtime/listing-authority-conformance.ts",
        ")).length, 1",
        ")).length, 0",
        "synthetic-consumption-changed",
      ],
      [
        "infrastructure/platform-runtime/listing-authority-history-conformance.ts",
        ")).length, 0",
        ")).length, 1",
        "synthetic-consumption-changed",
      ],
      [
        "infrastructure/platform-runtime/listing-authority-history-test-support.ts",
        ")).length > baseline",
        ")).length >= baseline",
        "synthetic-consumption-changed",
      ],
      [
        "infrastructure/platform-runtime/listing-authority-writer.ts",
        "raw.readStream(input)",
        "raw.readStream({ streamId: input.streamId })",
        "forward-input-changed",
      ],
    ];
    for (const [file, before, after, code] of mutants) {
      const source = readSource(file);
      expect(source).toContain(before);
      expect(errorCodes(mutatedInventory(file, source.replace(before, after)))).toContain(code);
    }
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
    if (site.limit !== expectedLimit(expected))
      errors.push({
        code: expectedLimit(expected) === "1" ? "bounded-limit-not-one" : "bounded-limit-changed",
        siteId: expected.id,
      });
    validateConsumption(site, expected.consumption, errors);
    validatePointer(site, targetOverrides, errors);
  }
  return errors;
}

function validateConsumption(site, expectedConsumption, errors) {
  const reject = (code) => errors.push({ code, siteId: site.id });
  if (expectedConsumption === "forward-input") {
    const arrow = site.call.parent;
    if (
      !ts.isArrowFunction(arrow) ||
      arrow.body !== site.call ||
      arrow.parameters.length !== 1 ||
      site.call.arguments.length !== 1 ||
      !ts.isIdentifier(site.call.arguments[0]) ||
      site.call.arguments[0].text !== arrow.parameters[0].name.getText(site.source)
    )
      reject("forward-input-changed");
    return;
  }
  if (expectedConsumption.startsWith("synthetic-")) {
    let node = site.call.parent;
    while (node && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))) node = node.parent;
    if (!node || !ts.isPropertyAccessExpression(node) || node.name.text !== "length") {
      reject("synthetic-consumption-changed");
      return;
    }
    const parent = node.parent;
    const valid =
      expectedConsumption === "synthetic-baseline"
        ? ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
          parent.right.getText(site.source) === "baseline"
        : ts.isCallExpression(parent) &&
          parent.expression.getText(site.source) === "assert.equal" &&
          parent.arguments[0] === node &&
          parent.arguments[1]?.getText(site.source) === expectedConsumption.at(-1);
    if (!valid) reject("synthetic-consumption-changed");
    return;
  }
  const declaration = enclosingVariableDeclaration(site.call);
  if (expectedConsumption === "creation") {
    if (
      !declaration ||
      !ts.isArrayBindingPattern(declaration.name) ||
      declaration.name.elements.length !== 1 ||
      !ts.isBindingElement(declaration.name.elements[0]) ||
      declaration.name.elements[0].dotDotDotToken ||
      declaration.name.elements[0].name.getText(site.source) !== "created"
    )
      reject("creation-consumption-changed");
    return;
  }
  const variableName = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
  const scope = site.statement?.parent;
  if (!variableName || !scope) {
    errors.push({ code: "read-result-not-bound", siteId: site.id });
    return;
  }

  const indices = [];
  const lengthComparisons = [];
  let singletonGuard = false;
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
      if (
        ts.isBinaryExpression(parent) &&
        parent.left === node &&
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        parent.right.getText(site.source) === "1"
      )
        singletonGuard = true;
      lengthComparisons.push(
        ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.GreaterThanToken &&
          parent.right.getText(site.source) === "0",
      );
    }
  });

  if (expectedConsumption === "singleton" && (!singletonGuard || indices.length !== 1 || indices[0] !== "0")) {
    reject("singleton-consumption-changed");
  }

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
  const owningWorkspace = /^(bounded-contexts|infrastructure)\/([^/]+)\//.exec(site.file)?.[0];
  const pointedWorkspace = /^(bounded-contexts|infrastructure)\/([^/]+)\//.exec(pointer)?.[0];
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

function expectedLimit(site) {
  return Object.hasOwn(site, "limit") ? site.limit : "1";
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
