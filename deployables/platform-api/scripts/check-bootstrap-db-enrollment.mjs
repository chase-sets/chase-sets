import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "@chase-sets/typescript-compiler-api";

export const bootstrapDbEnrollmentManifest = Object.freeze({
  "bootstrap-scenario.db.test.ts": Object.freeze({
    databaseSuffix: "platform_api_bootstrap_scenario",
    cases: Object.freeze([
      "boots with context-owned pools and replays cross-context projections",
      "revokes agent-owned saved instruments through the composed OAuth route with a valid audit context",
      "records context schema migrations once during concurrent bootstrap",
    ]),
  }),
  "bootstrap-production-reconciliation.db.test.ts": Object.freeze({
    databaseSuffix: "platform_api_bootstrap_production_reconciliation",
    cases: Object.freeze([
      "bootstraps and reconciles every whitelisted public policy value in the production landing profile",
      "reconciles a queued active public bootstrap after its predecessor fails with partial Commercial Terms history",
      "serializes two concurrent full production-like API host bootstraps with a database advisory lock",
      "limits and reconciles every production-like seed context against current-code state",
      "upgrades legacy published Display Templates through the not-empty Catalog reconciliation path",
      "proves the reviewed projection guard fails at User, then resumes a full retained Identity seed",
      "keeps every representative Identity creation event count stable on an ordinary day-after bootstrap",
      "rejects a conflicting retained representative Account profile with actionable detail",
      "rejects a conflicting retained representative User profile with actionable detail",
      "rejects a conflicting retained representative Shipping Address profile with actionable detail",
      "resumes the real representative commerce command after offer acceptance without duplicate creation events",
    ]),
  }),
  "bootstrap-lock-contention.db.test.ts": Object.freeze({
    databaseSuffix: "platform_api_bootstrap_lock_contention",
    cases: Object.freeze([
      "recovers when bootstrap-touched table locks release within the retry budget",
      "fails closed when bootstrap-touched table locks exhaust the retry budget",
      "isolates partition databases and bootstrap advisory locks",
    ]),
  }),
  "authoritative-seed-resume.db.test.ts": Object.freeze({
    databaseSuffix: "platform_api_authoritative_seed_resume",
    cases: Object.freeze([
      "enumerates stream-sourced seed-state coverage from the runtime mount list",
      "resumes every converted context after its UNLOGGED guard projections are truncated",
      "recreates only a missing review-eligible payment after a sibling payment has completed",
    ]),
  }),
  "inventory-seed-resume.db.test.ts": Object.freeze({
    databaseSuffix: "platform_api_inventory_seed_resume",
    cases: Object.freeze([
      "reseeds inventory after its truncated UNLOGGED projections without duplicate creation",
      "appends events only on the first of three same-boot inventory and checkout seed invocations",
      "resumes inventory from a committed-but-incomplete storage location",
      "resumes an archived storage location committed before its archive step",
      "resumes a checkout cart holding only one of its two seeded lines",
      "fails closed on conflicting retained inventory identity metadata",
      "fails closed on a terminal retained inventory aggregate",
      "keeps ordinary duplicate-create rejection unchanged for non-seed commands",
    ]),
  }),
  "catalog-seed-aggregate-state.db.test.ts": Object.freeze({
    databaseSuffix: "platform_api_catalog_seed_aggregate_state",
    cases: Object.freeze([
      "reconciles all required aggregates for a clean scenario-seed-only module seed",
      "NC-1 resumes an undrained Dimension seed without duplicate creation",
      "NC-2 resumes a Component committed at created version one across two ordinary boots",
      "NC-3 restores lagging projections without re-authoring active aggregates",
      "rebuilds lost Catalog Item projections from retained streams without appending item events",
      "NC-4 ignores populated containers when required aggregates have zero events",
      "NC-5a repairs a draft partial aggregate rather than skipping it",
      "NC-5b rejects conflicting retained identity metadata on both boots",
      "NC-5c rejects a terminal retained aggregate on both boots",
      "resumes after Dimensions under scenario-seed and production-like profiles",
      "resumes after Fields under scenario-seed and production-like profiles",
      "resumes after Reference Data under scenario-seed and production-like profiles",
      "resumes after Components under scenario-seed and production-like profiles",
      "resumes after Blueprints under scenario-seed and production-like profiles",
      "resumes after the final Category under scenario-seed and production-like profiles",
      "resumes mid catalog.component.created under scenario-seed and production-like profiles",
      "keeps the required aggregate set equal to the base aggregate streams authored by the seed",
      "preserves duplicate CreateDimension rejection through the non-seed command handler",
    ]),
  }),
});

const partitionFileNames = Object.freeze(Object.keys(bootstrapDbEnrollmentManifest));
const listenerMethodNames = new Set(["listen", "serve"]);
const scriptKinds = new Map([
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".mts", ts.ScriptKind.TS],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
]);

function sourceFileFor(filePath, source) {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKinds.get(extname(filePath)) ?? ts.ScriptKind.TS,
  );
}

function lineAndColumn(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${start.line + 1}:${start.character + 1}`;
}

function callRootIdentifier(expression) {
  let current = expression;
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isCallExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function calledMethodName(expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const argument = expression.argumentExpression;
    return ts.isStringLiteralLike(argument) ? argument.text : null;
  }
  return ts.isIdentifier(expression) ? expression.text : null;
}

function collectListenerAliases(sourceFile) {
  const aliases = new Set(listenerMethodNames);

  function visit(node) {
    if (ts.isImportSpecifier(node)) {
      const importedName = node.propertyName?.text ?? node.name.text;
      if (listenerMethodNames.has(importedName)) {
        aliases.add(node.name.text);
      }
    }

    if (ts.isBindingElement(node)) {
      const propertyName =
        node.propertyName && (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName))
          ? node.propertyName.text
          : null;
      if (propertyName && listenerMethodNames.has(propertyName) && ts.isIdentifier(node.name)) {
        aliases.add(node.name.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return aliases;
}

function inspectSource(filePath, source, expectedPartition) {
  const sourceFile = sourceFileFor(filePath, source);
  const listenerAliases = collectListenerAliases(sourceFile);
  const cases = [];
  const suffixes = [];
  const localImports = [];
  const violations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text.startsWith(".")) {
        localImports.push(node.moduleSpecifier.text);
      }
    }

    if (ts.isCallExpression(node)) {
      const rootIdentifier = callRootIdentifier(node.expression);
      if (rootIdentifier === "it") {
        const nameNode = node.arguments[0];
        if (!nameNode || !ts.isStringLiteralLike(nameNode)) {
          violations.push(`${lineAndColumn(sourceFile, node)} bootstrap case name must be a string literal`);
        } else {
          cases.push({ name: nameNode.text, location: lineAndColumn(sourceFile, node) });
        }

        if (!ts.isIdentifier(node.expression)) {
          violations.push(`${lineAndColumn(sourceFile, node)} bootstrap cases cannot use it modifiers`);
        }
      }

      if (rootIdentifier === "createPlatformApiBootstrapTestHarness") {
        const suffixNode = node.arguments[0];
        if (!suffixNode || !ts.isStringLiteralLike(suffixNode)) {
          violations.push(`${lineAndColumn(sourceFile, node)} database suffix must be a string literal`);
        } else {
          suffixes.push({ suffix: suffixNode.text, location: lineAndColumn(sourceFile, node) });
        }
      }

      const methodName = calledMethodName(node.expression);
      if ((methodName && listenerMethodNames.has(methodName)) || (methodName && listenerAliases.has(methodName))) {
        violations.push(`${lineAndColumn(sourceFile, node)} listener start '${methodName}(...)' is forbidden`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (expectedPartition) {
    if (suffixes.length !== 1) {
      violations.push(`${filePath} must declare exactly one bootstrap database suffix; found ${suffixes.length}`);
    } else if (suffixes[0].suffix !== expectedPartition.databaseSuffix) {
      violations.push(
        `${suffixes[0].location} database suffix '${suffixes[0].suffix}' must be '${expectedPartition.databaseSuffix}'`,
      );
    }
  }

  return { cases, localImports, violations };
}

function resolveLocalTestImport(importerPath, specifier, testDirectory) {
  const unresolved = resolve(dirname(importerPath), specifier);
  const candidates = extname(unresolved)
    ? [unresolved]
    : [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        `${unresolved}.mts`,
        `${unresolved}.mjs`,
        `${unresolved}.js`,
        resolve(unresolved, "index.ts"),
        resolve(unresolved, "index.mjs"),
      ];
  const testRelative = (candidate) => relative(testDirectory, candidate);
  return candidates.find(
    (candidate) =>
      existsSync(candidate) && !testRelative(candidate).startsWith("..") && !isAbsolute(testRelative(candidate)),
  );
}

export function checkBootstrapDbEnrollment({ platformApiRoot } = {}) {
  const root = platformApiRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const testDirectory = resolve(root, "__tests__");
  const violations = [];
  const discoveredCases = new Map();
  const filesToInspect = [];

  const legacyPath = resolve(testDirectory, "bootstrap-integration.test.ts");
  if (existsSync(legacyPath)) {
    violations.push(`${legacyPath} legacy monolithic bootstrap DB file must be removed`);
  }

  for (const fileName of partitionFileNames) {
    const filePath = resolve(testDirectory, fileName);
    if (!existsSync(filePath)) {
      violations.push(`${filePath} required bootstrap DB partition is missing`);
      continue;
    }
    filesToInspect.push({ filePath, expectedPartition: bootstrapDbEnrollmentManifest[fileName] });
  }

  const inspectedFiles = new Set();
  while (filesToInspect.length > 0) {
    const next = filesToInspect.shift();
    if (!next || inspectedFiles.has(next.filePath)) {
      continue;
    }
    inspectedFiles.add(next.filePath);

    const inspection = inspectSource(next.filePath, readFileSync(next.filePath, "utf8"), next.expectedPartition);
    violations.push(...inspection.violations);

    if (next.expectedPartition) {
      const expectedFileName = next.filePath.split(/[\\/]/).at(-1);
      for (const testCase of inspection.cases) {
        const existing = discoveredCases.get(testCase.name) ?? [];
        existing.push({ fileName: expectedFileName, location: testCase.location });
        discoveredCases.set(testCase.name, existing);
      }
    }

    for (const specifier of inspection.localImports) {
      const importedPath = resolveLocalTestImport(next.filePath, specifier, testDirectory);
      if (importedPath && !inspectedFiles.has(importedPath)) {
        filesToInspect.push({ filePath: importedPath, expectedPartition: null });
      }
    }
  }

  const expectedCases = new Map();
  for (const [fileName, partition] of Object.entries(bootstrapDbEnrollmentManifest)) {
    for (const caseName of partition.cases) {
      expectedCases.set(caseName, fileName);
    }
  }

  for (const [caseName, expectedFileName] of expectedCases) {
    const enrollments = discoveredCases.get(caseName) ?? [];
    if (enrollments.length === 0) {
      violations.push(`missing bootstrap DB case '${caseName}' from ${expectedFileName}`);
      continue;
    }
    if (enrollments.length > 1) {
      violations.push(
        `bootstrap DB case '${caseName}' is enrolled ${enrollments.length} times: ${enrollments
          .map(({ location }) => location)
          .join(", ")}`,
      );
    }
    for (const enrollment of enrollments) {
      if (enrollment.fileName !== expectedFileName) {
        violations.push(
          `${enrollment.location} bootstrap DB case '${caseName}' belongs in ${expectedFileName}, not ${enrollment.fileName}`,
        );
      }
    }
  }

  for (const [caseName, enrollments] of discoveredCases) {
    if (!expectedCases.has(caseName)) {
      for (const enrollment of enrollments) {
        violations.push(`${enrollment.location} unexpected bootstrap DB case '${caseName}'`);
      }
    }
  }

  return {
    caseCount: [...discoveredCases.values()].reduce((total, enrollments) => total + enrollments.length, 0),
    expectedCaseCount: expectedCases.size,
    inspectedFiles: [...inspectedFiles].sort(),
    violations,
  };
}

export function formatBootstrapDbEnrollmentResult(result) {
  if (result.violations.length > 0) {
    return [
      `Platform API bootstrap DB enrollment failed with ${result.violations.length} violation(s):`,
      ...result.violations.map((violation) => `- ${violation}`),
    ].join("\n");
  }

  return `Platform API bootstrap DB enrollment passed: ${result.caseCount}/${result.expectedCaseCount} cases across ${partitionFileNames.length} partitions; ${result.inspectedFiles.length} source files inspected.`;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = checkBootstrapDbEnrollment();
  console.log(formatBootstrapDbEnrollmentResult(result));
  if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}
