import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "@chase-sets/typescript-compiler-api";

/**
 * The single authority for which case runs in which file, which file runs in
 * which execution unit, what each case costs on the hosted DB Profile Tests
 * job, and what each case asserts.
 *
 * `referenceDurationMs` values are the per-case durations reported by the
 * hosted `DB Profile Tests` job named in `bootstrapDbScheduleModel`. They are
 * the only timing authority this guard accepts; no lane-host measurement can
 * confirm or refute them.
 *
 * `identity` is a digest of the case's own parsed arguments after its name —
 * its callback and its per-case timeout, if any. It therefore covers every
 * assertion the case makes and every data-profile shape it selects, and it is
 * invariant under pure relocation of the case to another file or execution
 * unit, because nothing about the file, the path, the unit, or the case name
 * feeds the digest.
 */
export const bootstrapDbEnrollmentManifest = Object.freeze({
  "bootstrap-scenario.db.test.ts": Object.freeze({
    executionUnit: "test:db:2",
    databaseSuffix: "platform_api_bootstrap_scenario",
    bootBearingCases: "all",
    cases: Object.freeze([
      Object.freeze({
        name: "boots with context-owned pools and replays cross-context projections",
        referenceDurationMs: 90877,
        identity: "ea12b6d3f3a538ba",
      }),
      Object.freeze({
        name: "revokes agent-owned saved instruments through the composed OAuth route with a valid audit context",
        referenceDurationMs: 1202,
        identity: "fa0e6fbbe051d0fe",
      }),
      Object.freeze({
        name: "records context schema migrations once during concurrent bootstrap",
        referenceDurationMs: 1716,
        identity: "5765a6ba4a890be6",
      }),
    ]),
  }),
  "bootstrap-production-reconciliation.db.test.ts": Object.freeze({
    executionUnit: "test:db:2",
    databaseSuffix: "platform_api_bootstrap_production_reconciliation",
    bootBearingCases: "all",
    cases: Object.freeze([
      Object.freeze({
        name: "bootstraps and reconciles every whitelisted public policy value in the production landing profile",
        referenceDurationMs: 8250,
        identity: "37b0e09726e4529e",
      }),
      Object.freeze({
        name: "reconciles a queued active public bootstrap after its predecessor fails with partial Commercial Terms history",
        referenceDurationMs: 16350,
        identity: "05afe53d6dbc6aff",
      }),
      Object.freeze({
        name: "serializes two concurrent full production-like API host bootstraps with a database advisory lock",
        referenceDurationMs: 17258,
        identity: "c9351aa5fd10ecb6",
      }),
      Object.freeze({
        name: "limits and reconciles every production-like seed context against current-code state",
        referenceDurationMs: 20217,
        identity: "6b7c87db7e1a0d46",
      }),
      Object.freeze({
        name: "upgrades legacy published Display Templates through the not-empty Catalog reconciliation path",
        referenceDurationMs: 20576,
        identity: "170dd2ca3aa2dca2",
      }),
      Object.freeze({
        name: "proves the reviewed projection guard fails at User, then resumes a full retained Identity seed",
        referenceDurationMs: 1084,
        identity: "ab68f4b84303d9ef",
      }),
      Object.freeze({
        name: "keeps every representative Identity creation event count stable on an ordinary day-after bootstrap",
        referenceDurationMs: 636,
        identity: "ec6d52932ca711b2",
      }),
      Object.freeze({
        name: "rejects a conflicting retained representative Account profile with actionable detail",
        referenceDurationMs: 320,
        identity: "22153693f009807d",
      }),
      Object.freeze({
        name: "rejects a conflicting retained representative User profile with actionable detail",
        referenceDurationMs: 473,
        identity: "d76b1ce3679034a0",
      }),
      Object.freeze({
        name: "rejects a conflicting retained representative Shipping Address profile with actionable detail",
        referenceDurationMs: 483,
        identity: "de799f65824dcee1",
      }),
      Object.freeze({
        name: "resumes the real representative commerce command after offer acceptance without duplicate creation events",
        referenceDurationMs: 61339,
        identity: "4994a619e1d95849",
      }),
    ]),
  }),
  "bootstrap-lock-contention.db.test.ts": Object.freeze({
    executionUnit: "test:db:2",
    databaseSuffix: "platform_api_bootstrap_lock_contention",
    bootBearingCases: "all",
    cases: Object.freeze([
      Object.freeze({
        name: "recovers when bootstrap-touched table locks release within the retry budget",
        referenceDurationMs: 1109,
        identity: "bf6e839e420caad8",
      }),
      Object.freeze({
        name: "fails closed when bootstrap-touched table locks exhaust the retry budget",
        referenceDurationMs: 1120,
        identity: "d18b9e8333f5c0e7",
      }),
      Object.freeze({
        name: "isolates partition databases and bootstrap advisory locks",
        referenceDurationMs: 2535,
        identity: "c31f3a59baae1188",
      }),
    ]),
  }),
  "authoritative-seed-resume-core.db.test.ts": Object.freeze({
    executionUnit: "test:db:1",
    databaseSuffix: "platform_api_authoritative_seed_resume_core",
    bootBearingCases: Object.freeze([
      "retained-state phase one: completes the first scenario-seed boot and proves all three same-boot repeats append nothing",
      "retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database",
      "does not re-author Settlement while its payout projection lags the stream",
    ]),
    cases: Object.freeze([
      Object.freeze({
        name: "derives the exact active and source-only seed universe for every host profile",
        referenceDurationMs: 348,
        identity: "12b7b08e0c1a6bb1",
      }),
      Object.freeze({
        name: "retained-state phase one: completes the first scenario-seed boot and proves all three same-boot repeats append nothing",
        referenceDurationMs: 75314,
        identity: "73747f1fd18ddbef",
      }),
      Object.freeze({
        name: "retained-state phase two: proves ordinary boot two appends nothing on the retained phase-one database",
        referenceDurationMs: 28241,
        identity: "681978291efa8647",
      }),
      Object.freeze({
        name: "does not re-author Settlement while its payout projection lags the stream",
        referenceDurationMs: 77914,
        identity: "4b8f47463aabf78e",
      }),
    ]),
  }),
  "authoritative-seed-resume-reconciliation.db.test.ts": Object.freeze({
    executionUnit: "test:db:1",
    databaseSuffix: "platform_api_authoritative_seed_resume_reconciliation",
    bootBearingCases: Object.freeze([
      "reconciles every inspecting scenario-seed context to its frozen identity corpus and active state",
      "resumes every converted context after its UNLOGGED guard projections are truncated",
      "accepts a seeded resolution after the real deadline sweep advances it to closed",
    ]),
    cases: Object.freeze([
      Object.freeze({
        name: "reconciles every inspecting scenario-seed context to its frozen identity corpus and active state",
        referenceDurationMs: 73270,
        identity: "87bc68f86fe6b7ca",
      }),
      Object.freeze({
        name: "enumerates stream-sourced seed-state coverage from the runtime mount list",
        referenceDurationMs: 608,
        identity: "944a32d056bf4f61",
      }),
      Object.freeze({
        name: "resumes every converted context after its UNLOGGED guard projections are truncated",
        referenceDurationMs: 71709,
        identity: "97c0a8c137819d55",
      }),
      Object.freeze({
        name: "accepts a seeded resolution after the real deadline sweep advances it to closed",
        referenceDurationMs: 59351,
        identity: "0efa7d5e61dc8603",
      }),
    ]),
  }),
  "authoritative-seed-resume-recovery.db.test.ts": Object.freeze({
    executionUnit: "test:db:2",
    databaseSuffix: "platform_api_authoritative_seed_resume_recovery",
    bootBearingCases: "all",
    cases: Object.freeze([
      Object.freeze({
        name: "keeps a cancelled resolution-bearing seed request incomplete and does not silently repair it",
        referenceDurationMs: 57961,
        identity: "3bd5ce2166de99ce",
      }),
      Object.freeze({
        name: "recreates only a missing review-eligible payment after a sibling payment has completed",
        referenceDurationMs: 58195,
        identity: "68188141fd171819",
      }),
    ]),
  }),
  "inventory-seed-resume.db.test.ts": Object.freeze({
    executionUnit: "test:db:2",
    databaseSuffix: "platform_api_inventory_seed_resume",
    bootBearingCases: "all",
    cases: Object.freeze([
      Object.freeze({
        name: "reseeds inventory after its truncated UNLOGGED projections without duplicate creation",
        referenceDurationMs: 24711,
        identity: "0b053db039f00b7d",
      }),
      Object.freeze({
        name: "appends events only on the first of three same-boot inventory and checkout seed invocations",
        referenceDurationMs: 21675,
        identity: "9f9a50a07958feca",
      }),
      Object.freeze({
        name: "resumes inventory from a committed-but-incomplete storage location",
        referenceDurationMs: 28234,
        identity: "c93a07182fe7d5ff",
      }),
      Object.freeze({
        name: "resumes an archived storage location committed before its archive step",
        referenceDurationMs: 28971,
        identity: "8c5dc773de3c8363",
      }),
      Object.freeze({
        name: "resumes a checkout cart holding only one of its two seeded lines",
        referenceDurationMs: 24479,
        identity: "6dd2f79404be0d62",
      }),
      Object.freeze({
        name: "fails closed on conflicting retained inventory identity metadata",
        referenceDurationMs: 20292,
        identity: "c54552620ac0570c",
      }),
      Object.freeze({
        name: "fails closed on a terminal retained inventory aggregate",
        referenceDurationMs: 16012,
        identity: "5883b8dd80d4e395",
      }),
      Object.freeze({
        name: "keeps ordinary duplicate-create rejection unchanged for non-seed commands",
        referenceDurationMs: 12671,
        identity: "35debe29ef133878",
      }),
    ]),
  }),
  "catalog-seed-aggregate-state.db.test.ts": Object.freeze({
    executionUnit: "test:db:1",
    databaseSuffix: "platform_api_catalog_seed_aggregate_state",
    bootBearingCases: "all",
    cases: Object.freeze([
      Object.freeze({
        name: "reconciles all required aggregates for a clean scenario-seed-only module seed",
        referenceDurationMs: 11470,
        identity: "f78d626bdd98a1c4",
      }),
      Object.freeze({
        name: "does not re-author unchanged Product Measures facts on scenario-seed repeat",
        referenceDurationMs: 19248,
        identity: "a0661cfb08a350b5",
      }),
      Object.freeze({
        name: "NC-1 resumes an undrained Dimension seed without duplicate creation",
        referenceDurationMs: 13264,
        identity: "ddeee7bac7384389",
      }),
      Object.freeze({
        name: "NC-2 resumes a Component committed at created version one across two ordinary boots",
        referenceDurationMs: 16156,
        identity: "d6b487fe4780b81f",
      }),
      Object.freeze({
        name: "NC-3 restores lagging projections without re-authoring active aggregates",
        referenceDurationMs: 6218,
        identity: "5370dfdb151548b6",
      }),
      Object.freeze({
        name: "rebuilds lost Catalog Item projections from retained streams without appending item events",
        referenceDurationMs: 23434,
        identity: "f7c024ac13659525",
      }),
      Object.freeze({
        name: "NC-4 ignores populated containers when required aggregates have zero events",
        referenceDurationMs: 25049,
        identity: "31ea7ebe99c1ec04",
      }),
      Object.freeze({
        name: "NC-5a repairs a draft partial aggregate rather than skipping it",
        referenceDurationMs: 16069,
        identity: "da4c8d1fc71a5c6b",
      }),
      Object.freeze({
        name: "NC-5b rejects conflicting retained identity metadata on both boots",
        referenceDurationMs: 3223,
        identity: "220cd5f763d298b2",
      }),
      Object.freeze({
        name: "NC-5c rejects a terminal retained aggregate on both boots",
        referenceDurationMs: 14123,
        identity: "547ba56539985bfc",
      }),
      Object.freeze({
        name: "resumes after Dimensions under scenario-seed and production-like profiles",
        referenceDurationMs: 20952,
        identity: "b006b495c2b4a662",
      }),
      Object.freeze({
        name: "resumes after Fields under scenario-seed and production-like profiles",
        referenceDurationMs: 20631,
        identity: "13b82872bb3ba0b8",
      }),
      Object.freeze({
        name: "resumes after Reference Data under scenario-seed and production-like profiles",
        referenceDurationMs: 20554,
        identity: "3cfe7d19f03127f2",
      }),
      Object.freeze({
        name: "resumes after Components under scenario-seed and production-like profiles",
        referenceDurationMs: 20933,
        identity: "7ef841ec166b46d3",
      }),
      Object.freeze({
        name: "resumes after Blueprints under scenario-seed and production-like profiles",
        referenceDurationMs: 22067,
        identity: "9a1c524b0483b012",
      }),
      Object.freeze({
        name: "resumes after the final Category under scenario-seed and production-like profiles",
        referenceDurationMs: 20945,
        identity: "cb5ecec3a418a82a",
      }),
      Object.freeze({
        name: "resumes mid catalog.component.created under scenario-seed and production-like profiles",
        referenceDurationMs: 20553,
        identity: "ea939096e104ab7e",
      }),
      Object.freeze({
        name: "keeps the required aggregate set equal to the base aggregate streams authored by the seed",
        referenceDurationMs: 13278,
        identity: "2be8f4782fdbd9eb",
      }),
      Object.freeze({
        name: "preserves duplicate CreateDimension rejection through the non-seed command handler",
        referenceDurationMs: 13522,
        identity: "b21990765232df57",
      }),
    ]),
  }),
});

/**
 * The per-unit ceiling on boot-bearing cases. A boot-bearing case stands up at
 * least one fresh multi-context seed boot, which is the dominant cost and the
 * dominant concurrent-schema-churn pressure on the single PostgreSQL service.
 * Each ceiling equals the shipped count for that unit, so any case moved into a
 * unit — or newly classified as boot-bearing — fails closed and forces the
 * schedule model to be re-derived rather than silently absorbing the load.
 */
export const bootstrapDbExecutionUnitBootBearingCaseCeilings = Object.freeze({
  "test:db:1": 25,
  "test:db:2": 27,
});

/**
 * The deterministic, host-independent execution-unit schedule model.
 *
 * Every constant below is derived from one hosted `DB Profile Tests` job — the
 * only timing authority for this partition — and the model reproduces that
 * job's own numbers before it is used to project anything. Against the
 * reference job the model returns 514210ms for its first unit against an
 * observed 514210ms, and 194356ms for its second against an observed 186210ms,
 * so it never under-states the measured cost.
 *
 * `testFileFixedCostMs` and `executionUnitFixedCostMs` are the largest
 * per-file and per-unit residuals observed in that job (file duration minus the
 * sum of its cases; unit duration minus its longest worker chain), taken at the
 * maximum rather than the mean so the projection stays conservative.
 *
 * A unit's makespan is the worst list-schedule of its files across
 * `maxWorkersPerExecutionUnit` workers over every possible file ordering, so
 * the projection holds whatever order the runner happens to start files in.
 */
export const bootstrapDbScheduleModel = Object.freeze({
  referenceRunId: 30843957451,
  referenceJobId: 91787818558,
  referenceJobName: "DB Profile Tests",
  referenceHeadSha: "f78143573af96c636d97696b987a82990df23904",
  referenceEvent: "merge_group",
  maxWorkersPerExecutionUnit: 3,
  testFileFixedCostMs: 1248,
  executionUnitFixedCostMs: 10051,
  jobOverheadMs: 48_000,
  executionUnitCeilingMs: 420_000,
  aggregateCeilingMs: 1_080_000,
  maximumCaseReferenceDurationMs: 600_000,
  maximumScheduledFileCount: 10,
  maximumEnumeratedUnitCount: 4,
});

const dbPartitionScriptNamePattern = /^test:db:\d+$/;
const listenerMethodNames = new Set(["listen", "serve"]);
const bootstrapHarnessModuleBaseName = "bootstrap-db-test-support";
const bootstrapHarnessFactoryName = "createPlatformApiBootstrapTestHarness";
const caseIdentityDigestLength = 16;
const caseIdentityPattern = /^[0-9a-f]{16}$/;
const scriptKinds = new Map([
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".mjs", ts.ScriptKind.JS],
  [".mts", ts.ScriptKind.TS],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
]);

const textBearingSyntaxKinds = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.JsxText,
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

/**
 * The per-case semantic identity.
 *
 * The input is selected by parsed code shape: everything the case declaration
 * passes after its name — its callback and, when present, its per-case timeout.
 * The case name itself is deliberately excluded, so the digest cannot degrade
 * into a hash of the name, the file, or the execution unit; two byte-identical
 * bodies under different names produce the same value, and a case moved between
 * files produces an unchanged one.
 *
 * The serialization walks the syntax tree and emits each node's syntax-kind
 * name plus, for the nodes that carry one, its literal or identifier text. No
 * position, trivia, comment, file name, or source offset takes part, so the
 * value survives reindentation but not a changed assertion, a changed matcher,
 * a changed profile selection, or a changed timeout.
 */
function deriveBootstrapDbCaseIdentity(caseCallNode) {
  const tokens = [];

  function walk(node) {
    tokens.push(ts.SyntaxKind[node.kind] ?? String(node.kind));
    if (textBearingSyntaxKinds.has(node.kind) && typeof node.text === "string") {
      tokens.push(`=${node.text}`);
    }
    tokens.push("(");
    ts.forEachChild(node, walk);
    tokens.push(")");
  }

  for (const argument of caseCallNode.arguments.slice(1)) {
    walk(argument);
  }

  return createHash("sha256").update(tokens.join(" "), "utf8").digest("hex").slice(0, caseIdentityDigestLength);
}

function collectCaseDeclarations(sourceFile) {
  const cases = [];
  const violations = [];

  function visit(node) {
    if (ts.isCallExpression(node) && callRootIdentifier(node.expression) === "it") {
      const nameNode = node.arguments[0];
      if (!nameNode || !ts.isStringLiteralLike(nameNode)) {
        violations.push(`${lineAndColumn(sourceFile, node)} bootstrap case name must be a string literal`);
      } else {
        cases.push({
          name: nameNode.text,
          identity: deriveBootstrapDbCaseIdentity(node),
          location: lineAndColumn(sourceFile, node),
        });
      }

      if (!ts.isIdentifier(node.expression)) {
        violations.push(`${lineAndColumn(sourceFile, node)} bootstrap cases cannot use it modifiers`);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { cases, violations };
}

/**
 * The public form of the per-case identity derivation: every case a source
 * declares, with the value the manifest must freeze for it. Callers pass source
 * text rather than a syntax node so the digest has exactly one definition and
 * no consumer can drift its own copy.
 */
export function deriveBootstrapDbCaseIdentities(fileName, source) {
  return collectCaseDeclarations(sourceFileFor(fileName, source)).cases.map(({ name, identity }) => ({
    name,
    identity,
  }));
}

function inspectSource(filePath, source, expectedPartition) {
  const sourceFile = sourceFileFor(filePath, source);
  const listenerAliases = collectListenerAliases(sourceFile);
  const { cases, violations: caseViolations } = collectCaseDeclarations(sourceFile);
  const suffixes = [];
  const localImports = [];
  const violations = [...caseViolations];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text.startsWith(".")) {
        localImports.push(node.moduleSpecifier.text);
      }
    }

    if (ts.isCallExpression(node)) {
      const rootIdentifier = callRootIdentifier(node.expression);
      if (rootIdentifier === bootstrapHarnessFactoryName) {
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

function referencedDbTestFileNames(command) {
  return [...command.matchAll(/__tests__[\\/]+([a-z0-9-]+\.db\.test\.ts)/gi)].map((match) => match[1]);
}

function referencedDbTestFileOrder(command) {
  return referencedDbTestFileNames(command);
}

// ---------------------------------------------------------------------------
// Executable discovery: which files the workspace's own vitest configuration
// treats as test entries, and which of those stand up a bootstrap database.
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        const skipsSeparator = glob[index + 2] === "/";
        pattern += skipsSeparator ? "(?:.*/)?" : ".*";
        index += skipsSeparator ? 2 : 1;
        continue;
      }
      pattern += "[^/]*";
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Reads the workspace's vitest `include` globs out of its own configuration so
 * the guard's notion of "a file the runner will execute" is the runner's, not a
 * filename convention restated here. A missing or unreadable `include` is a
 * fail-closed condition rather than a fallback to a hard-coded pattern.
 */
function readVitestIncludeGlobs(root) {
  const configPath = resolve(root, "vitest.config.ts");
  if (!existsSync(configPath)) {
    return { globs: [], violation: `${configPath} is required to derive the executable test-entry set` };
  }

  const sourceFile = sourceFileFor(configPath, readFileSync(configPath, "utf8"));
  const globs = [];
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      node.name.text === "include" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (ts.isStringLiteralLike(element)) globs.push(element.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (globs.length === 0) {
    return { globs: [], violation: `${configPath} declares no vitest include globs to derive test entries from` };
  }
  return { globs, violation: null };
}

function collectSourceFilesUnder(directory) {
  const found = [];
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    const entryPath = resolve(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      found.push(...collectSourceFilesUnder(entryPath));
      continue;
    }
    if (scriptKinds.has(extname(entryPath))) found.push(entryPath);
  }
  return found;
}

function importsBootstrapHarness(filePath, source, testDirectory, cache) {
  if (cache.has(filePath)) return cache.get(filePath);
  cache.set(filePath, false);

  const sourceFile = sourceFileFor(filePath, source);
  const specifiers = [];
  let declaresFactory = false;
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === bootstrapHarnessFactoryName) {
      declaresFactory = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  let result = false;
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const resolved = resolveLocalTestImport(filePath, specifier, testDirectory);
    if (!resolved) continue;
    if (resolved.split(/[\\/]/).at(-1)?.startsWith(bootstrapHarnessModuleBaseName)) {
      result = true;
      break;
    }
    if (importsBootstrapHarness(resolved, readFileSync(resolved, "utf8"), testDirectory, cache)) {
      result = true;
      break;
    }
  }

  cache.set(filePath, result && !declaresFactory);
  return cache.get(filePath);
}

// ---------------------------------------------------------------------------
// The schedule model.
// ---------------------------------------------------------------------------

/**
 * The worst makespan any list schedule of `durationsMs` can produce on
 * `workerCount` workers: each file in turn goes to the least-loaded worker, and
 * the model takes the maximum over every possible file order. Memoized on the
 * placed set plus the sorted worker loads, which collapses the orderings that
 * reach the same state.
 */
function worstCaseListScheduleMs(durationsMs, workerCount) {
  if (durationsMs.length === 0) return 0;
  if (durationsMs.length <= workerCount) return Math.max(...durationsMs);

  const complete = (1 << durationsMs.length) - 1;
  const memo = new Map();

  function walk(placedMask, loads) {
    if (placedMask === complete) return Math.max(...loads);
    const key = `${placedMask}|${loads.join(",")}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let leastLoadedIndex = 0;
    for (let index = 1; index < loads.length; index += 1) {
      if (loads[index] < loads[leastLoadedIndex]) leastLoadedIndex = index;
    }

    let worst = 0;
    const consideredDurations = new Set();
    for (let index = 0; index < durationsMs.length; index += 1) {
      if (placedMask & (1 << index)) continue;
      if (consideredDurations.has(durationsMs[index])) continue;
      consideredDurations.add(durationsMs[index]);
      const next = [...loads];
      next[leastLoadedIndex] = loads[leastLoadedIndex] + durationsMs[index];
      next.sort((left, right) => left - right);
      const candidate = walk(placedMask | (1 << index), next);
      if (candidate > worst) worst = candidate;
    }

    memo.set(key, worst);
    return worst;
  }

  return walk(0, new Array(workerCount).fill(0));
}

function executionUnitMakespanMs(fileDurationsMs, model) {
  if (fileDurationsMs.length === 0) return 0;
  return worstCaseListScheduleMs(fileDurationsMs, model.maxWorkersPerExecutionUnit) + model.executionUnitFixedCostMs;
}

/**
 * Every canonical partition of `length` items into exactly `blockCount`
 * non-empty blocks, as restricted-growth strings. Canonical form fixes the
 * enumeration order and removes unit-label permutations, so the first feasible
 * assignment found is a declared, reproducible tie-break rather than an
 * arbitrary one: the lexicographically smallest restricted-growth string over
 * the files taken in manifest declaration order.
 */
function* canonicalAssignments(length, blockCount) {
  const assignment = new Array(length).fill(0);

  function* place(index, usedBlocks) {
    if (length - index < blockCount - usedBlocks) return;
    if (index === length) {
      if (usedBlocks === blockCount) yield [...assignment];
      return;
    }
    const limit = Math.min(usedBlocks, blockCount - 1);
    for (let block = 0; block <= limit; block += 1) {
      assignment[index] = block;
      yield* place(index + 1, Math.max(usedBlocks, block + 1));
    }
  }

  yield* place(0, 0);
}

function scheduleUnits(files, assignment, unitCount, model) {
  const grouped = Array.from({ length: unitCount }, () => []);
  assignment.forEach((unitIndex, fileIndex) => grouped[unitIndex].push(files[fileIndex]));
  return grouped.map((unitFiles) => ({
    files: unitFiles,
    makespanMs: executionUnitMakespanMs(
      unitFiles.map((file) => file.durationMs),
      model,
    ),
  }));
}

function assignmentIsFeasible(units, model) {
  if (units.some((unit) => unit.makespanMs > model.executionUnitCeilingMs)) return false;
  const aggregate = units.reduce((total, unit) => total + unit.makespanMs, 0) + model.jobOverheadMs;
  return aggregate <= model.aggregateCeilingMs;
}

/**
 * The smallest unit count the shipped file set can be scheduled at. Two lower
 * bounds are checked first because they hold at every unit count: a file that
 * cannot fit a unit on its own can never fit one, and the aggregate can never
 * drop below the total work spread across the workers of a single unit. Only
 * then does the model enumerate assignments, and it refuses rather than samples
 * when the file count or the unit count leaves its declared bounds.
 */
function computeMinimumUnitCount(files, model) {
  if (files.length === 0) {
    return { minimumUnitCount: null, refusal: "the schedule model has no manifested files to schedule" };
  }
  if (files.length > model.maximumScheduledFileCount) {
    return {
      minimumUnitCount: null,
      refusal:
        `the schedule model refuses to enumerate ${files.length} files, above its declared bound of ` +
        `${model.maximumScheduledFileCount}; re-derive the bound deliberately rather than sampling assignments`,
    };
  }

  const overCeiling = files.filter(
    (file) => file.durationMs + model.executionUnitFixedCostMs > model.executionUnitCeilingMs,
  );
  if (overCeiling.length > 0) {
    return {
      minimumUnitCount: null,
      refusal:
        `no execution-unit count satisfies the model; binding constraint is the ${model.executionUnitCeilingMs}ms ` +
        `per-unit ceiling, which ${overCeiling
          .map((file) => `${file.fileName} (${file.durationMs + model.executionUnitFixedCostMs}ms alone)`)
          .join(", ")} exceeds on its own`,
    };
  }

  const totalWorkMs = files.reduce((total, file) => total + file.durationMs, 0);
  const aggregateLowerBoundMs =
    Math.ceil(totalWorkMs / model.maxWorkersPerExecutionUnit) + model.executionUnitFixedCostMs + model.jobOverheadMs;
  if (aggregateLowerBoundMs > model.aggregateCeilingMs) {
    return {
      minimumUnitCount: null,
      refusal:
        `no execution-unit count satisfies the model; binding constraint is the ${model.aggregateCeilingMs}ms ` +
        `aggregate, whose lower bound for this file set is already ${aggregateLowerBoundMs}ms`,
    };
  }

  const maximumUnitCount = Math.min(files.length, model.maximumEnumeratedUnitCount);
  for (let unitCount = 1; unitCount <= maximumUnitCount; unitCount += 1) {
    for (const assignment of canonicalAssignments(files.length, unitCount)) {
      const units = scheduleUnits(files, assignment, unitCount, model);
      if (assignmentIsFeasible(units, model)) {
        return { minimumUnitCount: unitCount, witness: units, refusal: null };
      }
    }
  }

  return {
    minimumUnitCount: null,
    refusal:
      `no execution-unit count up to the model's declared bound of ${model.maximumEnumeratedUnitCount} units ` +
      `satisfies both the ${model.executionUnitCeilingMs}ms per-unit ceiling and the ` +
      `${model.aggregateCeilingMs}ms aggregate`,
  };
}

function bestAssignmentAt(files, unitCount, model) {
  if (unitCount < 1 || unitCount > files.length) return null;
  let best = null;
  for (const assignment of canonicalAssignments(files.length, unitCount)) {
    const units = scheduleUnits(files, assignment, unitCount, model);
    const worst = Math.max(...units.map((unit) => unit.makespanMs));
    if (!best || worst < best.worstMakespanMs) best = { units, worstMakespanMs: worst };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Manifest shape validation. The manifest, the ceilings, and the model are all
// machine-readable contracts, so every field is closed and bounded here rather
// than trusted at the point of use.
// ---------------------------------------------------------------------------

function validateManifestShape(manifest, ceilings, model) {
  const violations = [];
  const allowedPartitionKeys = new Set(["executionUnit", "databaseSuffix", "bootBearingCases", "cases"]);
  const allowedCaseKeys = new Set(["name", "referenceDurationMs", "identity"]);

  for (const [fileName, partition] of Object.entries(manifest)) {
    if (typeof partition !== "object" || partition === null) {
      violations.push(`${fileName} manifest entry must be an object`);
      continue;
    }
    for (const key of Object.keys(partition)) {
      if (!allowedPartitionKeys.has(key)) violations.push(`${fileName} manifest entry declares unknown field '${key}'`);
    }
    if (typeof partition.executionUnit !== "string" || !dbPartitionScriptNamePattern.test(partition.executionUnit)) {
      violations.push(`${fileName} must declare an executionUnit matching test:db:<number>`);
    } else if (!(partition.executionUnit in ceilings)) {
      violations.push(`${partition.executionUnit} must declare a boot-bearing case ceiling`);
    }
    if (typeof partition.databaseSuffix !== "string" || partition.databaseSuffix.length === 0) {
      violations.push(`${fileName} must declare a non-empty databaseSuffix`);
    }
    if (!Array.isArray(partition.cases) || partition.cases.length === 0) {
      violations.push(`${fileName} must declare at least one case`);
      continue;
    }

    const caseNames = new Set();
    for (const [index, testCase] of partition.cases.entries()) {
      const label = `${fileName} case ${index}`;
      if (typeof testCase !== "object" || testCase === null) {
        violations.push(`${label} must be an object`);
        continue;
      }
      for (const key of Object.keys(testCase)) {
        if (!allowedCaseKeys.has(key)) violations.push(`${label} declares unknown field '${key}'`);
      }
      if (typeof testCase.name !== "string" || testCase.name.length === 0) {
        violations.push(`${label} must declare a non-empty name`);
      } else if (caseNames.has(testCase.name)) {
        violations.push(`${fileName} declares case '${testCase.name}' more than once`);
      } else {
        caseNames.add(testCase.name);
      }
      const caseLabel = typeof testCase.name === "string" ? `'${testCase.name}'` : label;
      if (
        typeof testCase.referenceDurationMs !== "number" ||
        !Number.isInteger(testCase.referenceDurationMs) ||
        testCase.referenceDurationMs < 0 ||
        testCase.referenceDurationMs > model.maximumCaseReferenceDurationMs
      ) {
        violations.push(
          `${fileName} case ${caseLabel} must declare an integer referenceDurationMs between 0 and ` +
            `${model.maximumCaseReferenceDurationMs}; a case with no reference duration is never scheduled as zero`,
        );
      }
      if (typeof testCase.identity !== "string" || !caseIdentityPattern.test(testCase.identity)) {
        violations.push(
          `${fileName} case ${caseLabel} must declare a frozen ${caseIdentityDigestLength}-character identity value`,
        );
      }
    }

    if (partition.bootBearingCases !== "all") {
      if (!Array.isArray(partition.bootBearingCases)) {
        violations.push(`${fileName} bootBearingCases must be "all" or a list of case names`);
      } else {
        const declared = new Set();
        for (const caseName of partition.bootBearingCases) {
          if (typeof caseName !== "string") {
            violations.push(`${fileName} bootBearingCases entries must be case-name strings`);
            continue;
          }
          if (declared.has(caseName)) {
            violations.push(`${fileName} boot-bearing case classification contains duplicates`);
            continue;
          }
          declared.add(caseName);
          if (!caseNames.has(caseName)) {
            violations.push(`${fileName} classifies unknown boot-bearing case '${caseName}'`);
          }
        }
      }
    }
  }

  for (const [scriptName, ceiling] of Object.entries(ceilings)) {
    if (!dbPartitionScriptNamePattern.test(scriptName)) {
      violations.push(`boot-bearing case ceiling '${scriptName}' must name a test:db:<number> execution unit`);
    }
    if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < 0) {
      violations.push(`${scriptName} boot-bearing case ceiling must be a non-negative integer`);
    }
  }

  return violations;
}

function bootBearingCaseCount(partition) {
  return partition.bootBearingCases === "all" ? partition.cases.length : partition.bootBearingCases.length;
}

// ---------------------------------------------------------------------------

export function checkBootstrapDbEnrollment({
  platformApiRoot,
  manifest = bootstrapDbEnrollmentManifest,
  executionUnitBootBearingCaseCeilings = bootstrapDbExecutionUnitBootBearingCaseCeilings,
  scheduleModel = bootstrapDbScheduleModel,
} = {}) {
  const root = platformApiRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const testDirectory = resolve(root, "__tests__");
  const violations = [];
  const discoveredCases = new Map();
  const filesToInspect = [];
  let packageScripts = {};

  violations.push(...validateManifestShape(manifest, executionUnitBootBearingCaseCeilings, scheduleModel));

  try {
    packageScripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts ?? {};
  } catch (error) {
    violations.push(`${resolve(root, "package.json")} could not be read: ${error.message}`);
  }

  const partitionFileNames = Object.keys(manifest);
  const partitionMemberships = new Map(partitionFileNames.map((fileName) => [fileName, []]));
  const partitionScripts = Object.entries(packageScripts).filter(
    ([name, command]) => dbPartitionScriptNamePattern.test(name) && typeof command === "string",
  );
  if (partitionScripts.length === 0) {
    violations.push("package.json must publish at least one numbered test:db:* partition script");
  }
  for (const [scriptName, command] of partitionScripts) {
    for (const fileName of referencedDbTestFileOrder(command)) {
      const memberships = partitionMemberships.get(fileName);
      if (!memberships) {
        violations.push(`${scriptName} references unmanifested bootstrap DB file '${fileName}'`);
        continue;
      }
      memberships.push(scriptName);
    }
  }
  for (const [fileName, memberships] of partitionMemberships) {
    if (memberships.length !== 1) {
      violations.push(
        `${fileName} must appear in exactly one numbered test:db:* partition script; found ${memberships.length}${
          memberships.length > 0 ? ` (${memberships.join(", ")})` : ""
        }`,
      );
    } else if (memberships[0] !== manifest[fileName].executionUnit) {
      violations.push(`${fileName} belongs in ${manifest[fileName].executionUnit}, not ${memberships[0]}`);
    }
  }

  const partitionScriptNames = new Set(partitionScripts.map(([scriptName]) => scriptName));
  for (const scriptName of Object.keys(executionUnitBootBearingCaseCeilings)) {
    if (!partitionScriptNames.has(scriptName)) {
      violations.push(`boot-bearing case ceiling references missing execution unit ${scriptName}`);
    }
  }
  for (const scriptName of partitionScriptNames) {
    if (!(scriptName in executionUnitBootBearingCaseCeilings)) {
      violations.push(`${scriptName} must declare a boot-bearing case ceiling`);
      continue;
    }
    const ceiling = executionUnitBootBearingCaseCeilings[scriptName];
    const observed = partitionFileNames
      .filter((fileName) => manifest[fileName].executionUnit === scriptName)
      .reduce((count, fileName) => count + bootBearingCaseCount(manifest[fileName]), 0);
    if (observed > ceiling) {
      violations.push(`${scriptName} has ${observed} boot-bearing cases, exceeding its declared ceiling of ${ceiling}`);
    }
  }

  for (const scriptName of ["test:unit", "test:fast"]) {
    const command = packageScripts[scriptName];
    if (typeof command !== "string") {
      violations.push(`package.json must publish ${scriptName}`);
      continue;
    }
    const excludedFiles = new Set(
      [...command.matchAll(/--exclude(?:=|\s+)__tests__[\\/]+([a-z0-9-]+\.db\.test\.ts)/gi)].map((match) => match[1]),
    );
    for (const fileName of partitionFileNames) {
      if (!excludedFiles.has(fileName)) {
        violations.push(`${scriptName} must exclude __tests__/${fileName}`);
      }
    }
  }

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
    filesToInspect.push({ filePath, expectedPartition: manifest[fileName] });
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

    const inspectedFileName = next.filePath.split(/[\\/]/).at(-1);
    for (const testCase of inspection.cases) {
      const existing = discoveredCases.get(testCase.name) ?? [];
      existing.push({ fileName: inspectedFileName, identity: testCase.identity, location: testCase.location });
      discoveredCases.set(testCase.name, existing);
    }

    for (const specifier of inspection.localImports) {
      const importedPath = resolveLocalTestImport(next.filePath, specifier, testDirectory);
      if (importedPath && !inspectedFiles.has(importedPath)) {
        filesToInspect.push({ filePath: importedPath, expectedPartition: null });
      }
    }
  }

  // Executable entry-set derivation: any file the workspace's own vitest
  // configuration would execute, and which reaches the bootstrap harness
  // through its import graph, has to be manifested and scheduled. A new DB test
  // that merely imports the harness is therefore undiscovered until it is
  // actually enrolled, rather than silently running outside every unit.
  const { globs: includeGlobs, violation: includeViolation } = readVitestIncludeGlobs(root);
  if (includeViolation) {
    violations.push(includeViolation);
  } else {
    const includePatterns = includeGlobs.map((glob) => globToRegExp(glob));
    const harnessImportCache = new Map();
    for (const filePath of collectSourceFilesUnder(testDirectory)) {
      const relativePath = relative(root, filePath).replaceAll("\\", "/");
      if (!includePatterns.some((pattern) => pattern.test(relativePath))) continue;
      if (!importsBootstrapHarness(filePath, readFileSync(filePath, "utf8"), testDirectory, harnessImportCache)) {
        continue;
      }
      const fileName = filePath.split(/[\\/]/).at(-1);
      if (!partitionMemberships.has(fileName)) {
        violations.push(
          `${relativePath} is an executable test entry that stands up a bootstrap database but is not manifested ` +
            "in any numbered test:db:* execution unit",
        );
      }
    }
  }

  const expectedCases = new Map();
  for (const [fileName, partition] of Object.entries(manifest)) {
    for (const testCase of partition.cases) {
      if (typeof testCase?.name === "string") expectedCases.set(testCase.name, { fileName, testCase });
    }
  }

  for (const [caseName, { fileName: expectedFileName, testCase }] of expectedCases) {
    const enrollments = discoveredCases.get(caseName) ?? [];
    if (enrollments.length === 0) {
      violations.push(
        `missing bootstrap DB case '${caseName}' from ${expectedFileName} in ${manifest[expectedFileName].executionUnit}`,
      );
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
      if (typeof testCase.identity === "string" && enrollment.identity !== testCase.identity) {
        violations.push(
          `${enrollment.location} bootstrap DB case '${caseName}' has semantic identity ` +
            `'${enrollment.identity}' but the manifest freezes '${testCase.identity}'; its assertions or the ` +
            "data-profile shapes it runs under changed",
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

  // ---- schedule model ----
  const scheduledFiles = partitionFileNames.map((fileName) => {
    const partition = manifest[fileName];
    const caseDurationMs = partition.cases.reduce(
      (total, testCase) => total + (Number.isInteger(testCase?.referenceDurationMs) ? testCase.referenceDurationMs : 0),
      0,
    );
    return {
      fileName,
      executionUnit: partition.executionUnit,
      caseCount: partition.cases.length,
      caseDurationMs,
      durationMs: caseDurationMs + scheduleModel.testFileFixedCostMs,
    };
  });

  const observedUnitNames = [...new Set(partitionFileNames.map((fileName) => manifest[fileName].executionUnit))].sort(
    (left, right) => left.localeCompare(right, "en", { numeric: true }),
  );
  const shippedUnits = observedUnitNames.map((scriptName) => {
    const unitFiles = scheduledFiles.filter((file) => file.executionUnit === scriptName);
    return {
      scriptName,
      files: unitFiles,
      makespanMs: executionUnitMakespanMs(
        unitFiles.map((file) => file.durationMs),
        scheduleModel,
      ),
      bootBearingCaseCount: partitionFileNames
        .filter((fileName) => manifest[fileName].executionUnit === scriptName)
        .reduce((count, fileName) => count + bootBearingCaseCount(manifest[fileName]), 0),
      bootBearingCeiling: executionUnitBootBearingCaseCeilings[scriptName] ?? null,
    };
  });

  for (const unit of shippedUnits) {
    if (unit.files.length > scheduleModel.maximumScheduledFileCount) {
      violations.push(
        `${unit.scriptName} schedules ${unit.files.length} files, above the model's declared bound of ` +
          `${scheduleModel.maximumScheduledFileCount}`,
      );
      continue;
    }
    if (unit.makespanMs > scheduleModel.executionUnitCeilingMs) {
      violations.push(
        `${unit.scriptName} has a projected makespan of ${unit.makespanMs}ms, exceeding the ` +
          `${scheduleModel.executionUnitCeilingMs}ms per-unit ceiling`,
      );
    }
  }

  const aggregateMs = shippedUnits.reduce((total, unit) => total + unit.makespanMs, 0);
  const aggregateWithOverheadMs = aggregateMs + scheduleModel.jobOverheadMs;
  if (aggregateWithOverheadMs > scheduleModel.aggregateCeilingMs) {
    violations.push(
      `the projected aggregate of ${aggregateMs}ms across ${shippedUnits.length} execution units plus the ` +
        `${scheduleModel.jobOverheadMs}ms job overhead is ${aggregateWithOverheadMs}ms, exceeding the ` +
        `${scheduleModel.aggregateCeilingMs}ms aggregate ceiling`,
    );
  }

  const { minimumUnitCount, refusal } = computeMinimumUnitCount(scheduledFiles, scheduleModel);
  if (refusal) {
    violations.push(refusal);
  } else if (shippedUnits.length > minimumUnitCount) {
    violations.push(
      `the shipped topology spends ${shippedUnits.length} execution units where the schedule model's ` +
        `minimumUnitCount for the same file set is ${minimumUnitCount}; execution units of one workspace run ` +
        "serially, so an unnecessary unit is spent aggregate budget",
    );
  } else if (shippedUnits.length < minimumUnitCount) {
    violations.push(
      `the shipped topology spends ${shippedUnits.length} execution units below the schedule model's ` +
        `minimumUnitCount of ${minimumUnitCount}`,
    );
  }

  const oneFewerUnit =
    minimumUnitCount && minimumUnitCount > 1
      ? bestAssignmentAt(scheduledFiles, minimumUnitCount - 1, scheduleModel)
      : null;

  return {
    caseCount: [...discoveredCases.values()].reduce((total, enrollments) => total + enrollments.length, 0),
    expectedCaseCount: expectedCases.size,
    fileCount: partitionFileNames.length,
    inspectedFiles: [...inspectedFiles].sort(),
    partitionUnitCount: partitionScripts.length,
    caseIdentities: Object.fromEntries(
      [...discoveredCases].map(([caseName, enrollments]) => [caseName, enrollments[0]?.identity ?? null]),
    ),
    schedule: {
      units: shippedUnits.map((unit) => ({
        scriptName: unit.scriptName,
        fileNames: unit.files.map((file) => file.fileName),
        makespanMs: unit.makespanMs,
        bootBearingCaseCount: unit.bootBearingCaseCount,
        bootBearingCeiling: unit.bootBearingCeiling,
      })),
      files: scheduledFiles,
      observedUnitCount: shippedUnits.length,
      minimumUnitCount: minimumUnitCount ?? null,
      aggregateMs,
      aggregateWithOverheadMs,
      oneFewerUnit: oneFewerUnit
        ? {
            unitCount: minimumUnitCount - 1,
            units: oneFewerUnit.units.map((unit) => ({
              fileNames: unit.files.map((file) => file.fileName),
              makespanMs: unit.makespanMs,
            })),
          }
        : null,
    },
    violations,
  };
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(3)}s`;
}

export function formatBootstrapDbEnrollmentResult(result) {
  if (result.violations.length > 0) {
    return [
      `Platform API bootstrap DB enrollment failed with ${result.violations.length} violation(s):`,
      ...result.violations.map((violation) => `- ${violation}`),
    ].join("\n");
  }

  const { schedule } = result;
  const lines = [
    `Platform API bootstrap DB enrollment passed: ${result.caseCount}/${result.expectedCaseCount} cases across ` +
      `${result.fileCount} files and ${result.partitionUnitCount} execution units; ` +
      `${result.inspectedFiles.length} source files inspected.`,
    `Execution-unit schedule model (reference run ${bootstrapDbScheduleModel.referenceRunId} / ` +
      `${bootstrapDbScheduleModel.referenceJobName} job ${bootstrapDbScheduleModel.referenceJobId}, ` +
      `--maxWorkers=${bootstrapDbScheduleModel.maxWorkersPerExecutionUnit}):`,
  ];

  for (const unit of schedule.units) {
    lines.push(
      `  ${unit.scriptName} makespan ${formatSeconds(unit.makespanMs)} ` +
        `(ceiling ${formatSeconds(bootstrapDbScheduleModel.executionUnitCeilingMs)}) ` +
        `boot-bearing ${unit.bootBearingCaseCount}/${unit.bootBearingCeiling}`,
    );
    for (const fileName of unit.fileNames) {
      const file = schedule.files.find((entry) => entry.fileName === fileName);
      lines.push(`      ${fileName} ${formatSeconds(file.durationMs)} (${file.caseCount} cases)`);
    }
  }

  lines.push(
    `  aggregate sum(unit makespans) ${formatSeconds(schedule.aggregateMs)} + ` +
      `${bootstrapDbScheduleModel.jobOverheadMs / 1000}s job overhead = ` +
      `${formatSeconds(schedule.aggregateWithOverheadMs)} <= ` +
      `${formatSeconds(bootstrapDbScheduleModel.aggregateCeilingMs)}`,
    `  minimumUnitCount ${schedule.minimumUnitCount} observedUnitCount ${schedule.observedUnitCount}`,
  );

  if (schedule.oneFewerUnit) {
    lines.push(`  one-fewer-unit alternative (${schedule.oneFewerUnit.unitCount} unit(s)), best available assignment:`);
    for (const [index, unit] of schedule.oneFewerUnit.units.entries()) {
      const overCeiling = unit.makespanMs > bootstrapDbScheduleModel.executionUnitCeilingMs;
      lines.push(
        `      unit ${index + 1} makespan ${formatSeconds(unit.makespanMs)}` +
          `${overCeiling ? ` ABOVE the ${formatSeconds(bootstrapDbScheduleModel.executionUnitCeilingMs)} ceiling` : ""}` +
          ` files=[${unit.fileNames.join(", ")}]`,
      );
    }
  }

  return lines.join("\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = checkBootstrapDbEnrollment();
  console.log(formatBootstrapDbEnrollmentResult(result));
  if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}
