import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { expect, test } from "vitest";
import {
  collectLeafDiffPaths,
  collectLeafPaths,
  collectUnclassifiedFields,
  compareTypeScriptOwnerContexts,
  deriveTypeScriptOwnerContexts,
  evaluateTypeScriptOwnerContexts,
  formatTypeScriptOwnerContextDiagnostics,
  semanticViolationCode,
  valueAtPath,
} from "./typescript-owner-context-derivation.mjs";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

const COMMITTED_ARTIFACT = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/check-structure/typescript-owner-contexts.json"), "utf8"),
);
const COMMITTED_PARTITION = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/check-structure/typescript-owner-context-partition.json"), "utf8"),
);
const COMMITTED_SCHEMA = JSON.parse(
  readFileSync(path.join(repoRoot, "scripts/check-structure/typescript-owner-contexts-v1.schema.json"), "utf8"),
);

const TEST_FILE = fileURLToPath(import.meta.url);
const FIXTURE_ROOT = path.join(repoRoot, "scripts/check-structure/fixtures/typescript-owner-context-derivation");
const EXPLICIT_INPUTS = Object.freeze({
  resolutionRoot: repoRoot,
  lockfilePath: path.join(repoRoot, "pnpm-lock.yaml"),
});
const CRITERION_SIX_TEST_NAME = "keeps an unchanged authority green across a lockfile change";
const DERIVATION_MODULE_SUFFIX = "./typescript-owner-context-derivation.mjs";
const COMMITTED_IDENTIFIERS = new Set(["COMMITTED_ARTIFACT", "COMMITTED_PARTITION", "COMMITTED_SCHEMA"]);
const TERMINAL_PIN_KEYS = new Set([
  "resolution.aliasName",
  "resolution.aliasVersion",
  "resolution.aliasEntryPath",
  "resolution.implementationPath",
  "workspace.packagePath",
  "workspace.wrapperPath",
]);

function clone(value) {
  return structuredClone(value);
}

function requireControl(condition, message) {
  if (!condition) throw new Error(message);
}

function replaceAtPath(value, dottedPath, replacement) {
  const copy = clone(value);
  const segments = dottedPath.split(".");
  const leaf = segments.pop();
  const parent = segments.reduce((current, segment) => current[segment], copy);
  parent[leaf] = replacement;
  return copy;
}

function validMutantValue(key, current) {
  if (Array.isArray(current)) {
    const value = clone(current);
    if (key === "resolution.lockfileKeys") value[0].occurrences += 1;
    else if (key === "dispositions") value[0].qualifier += " (mutant)";
    else value[0].kind += 1000;
    return value;
  }
  if (typeof current === "string" && /^[a-f0-9]{64}$/.test(current)) {
    return `${current[0] === "a" ? "b" : "a"}${current.slice(1)}`;
  }
  if (typeof current === "string") return `${current}-mutant`;
  if (typeof current === "number") return current + 1;
  throw new Error(`no valid mutant value for ${key}`);
}

function mutateOneLeaf(artifact, key) {
  return replaceAtPath(artifact, key, validMutantValue(key, valueAtPath(artifact, key)));
}

function evaluateDerivedArtifact(
  derivedArtifact,
  {
    committedArtifact = COMMITTED_ARTIFACT,
    comparedKeys = COMMITTED_PARTITION.semantic,
    partition = COMMITTED_PARTITION,
    schema = COMMITTED_SCHEMA,
  } = {},
) {
  return evaluateTypeScriptOwnerContexts({
    ...EXPLICIT_INPUTS,
    committedArtifact,
    comparedKeys,
    partition,
    schema,
    deriveArtifact: (inputs) => {
      requireControl(inputs.resolutionRoot === EXPLICIT_INPUTS.resolutionRoot, "resolutionRoot was not explicit");
      requireControl(inputs.lockfilePath === EXPLICIT_INPUTS.lockfilePath, "lockfilePath was not explicit");
      return clone(derivedArtifact);
    },
  });
}

function fixtureSource(name) {
  return readFileSync(path.join(FIXTURE_ROOT, name), "utf8");
}

function bindingNames(name, target = []) {
  if (ts.isIdentifier(name)) {
    target.push(name.text);
    return target;
  }
  for (const element of name.elements ?? []) {
    if (ts.isBindingElement(element)) bindingNames(element.name, target);
  }
  return target;
}

function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function leftmostIdentifier(node) {
  let current = node;
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isBinaryExpression(current)) {
      current = current.left;
      continue;
    }
    return null;
  }
  return null;
}

function isLiteralExpression(node) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(isLiteralExpression);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) => ts.isPropertyAssignment(property) && isLiteralExpression(property.initializer),
    );
  }
  return false;
}

function matcherRootedAtExpect(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "expect";
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return `${calleeName(expression.expression)}.${expression.name.text}`;
  }
  if (ts.isCallExpression(expression)) return `${calleeName(expression.expression)}()`;
  return "<unknown>";
}

function analyzeExpectedArguments(source, fileName = "fixture.mjs") {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const derivationImports = new Set();
  const assertImports = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (specifier.endsWith(DERIVATION_MODULE_SUFFIX)) {
      if (clause?.name) derivationImports.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) derivationImports.add(element.name.text);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        derivationImports.add(clause.namedBindings.name.text);
      }
    }
    if (specifier === "node:assert") {
      if (clause?.name) assertImports.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) assertImports.add(element.name.text);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        assertImports.add(clause.namedBindings.name.text);
      }
    }
  }

  const derivedBindings = new Set();
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    let containsDerivationCall = false;
    walk(node.initializer, (candidate) => {
      if (!ts.isCallExpression(candidate)) return;
      const root = leftmostIdentifier(candidate.expression);
      if (root && derivationImports.has(root)) containsDerivationCall = true;
    });
    if (containsDerivationCall) {
      for (const name of bindingNames(node.name)) derivedBindings.add(name);
    }
  });

  let criterionSpan = null;
  walk(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      !["test", "it"].includes(node.expression.text) ||
      !ts.isStringLiteral(node.arguments[0]) ||
      node.arguments[0].text !== CRITERION_SIX_TEST_NAME
    ) {
      return;
    }
    const body = node.arguments[1];
    if (body) criterionSpan = { start: body.getStart(sourceFile), end: body.end };
  });

  const argumentsTable = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const matcher = matcherRootedAtExpect(node.expression);
    const root = leftmostIdentifier(node.expression);
    const assertion = root && assertImports.has(root);
    if (!matcher && !assertion) return;
    for (const argument of node.arguments) {
      const leftmost = leftmostIdentifier(argument);
      const inCriterionSixSpan =
        criterionSpan !== null &&
        argument.getStart(sourceFile) >= criterionSpan.start &&
        argument.end <= criterionSpan.end;
      const rootedAtDerived = leftmost !== null && derivedBindings.has(leftmost);
      const allowed =
        inCriterionSixSpan ||
        isLiteralExpression(argument) ||
        (leftmost !== null && COMMITTED_IDENTIFIERS.has(leftmost) && !rootedAtDerived);
      argumentsTable.push({
        callee: calleeName(node.expression),
        text: argument.getText(sourceFile),
        leftmostIdentifier: leftmost,
        inCriterionSixSpan,
        rootedAtDerived,
        verdict: allowed ? "allowed" : "candidate-derived-expected-argument",
      });
    }
  });

  return {
    code: criterionSpan ? null : "criterion-six-span-missing",
    criterionSpan,
    derivedBindings: [...derivedBindings].sort(),
    arguments: argumentsTable,
    violations: argumentsTable.filter(({ verdict }) => verdict !== "allowed"),
  };
}

test("derives the owner context surface from the installed compiler source", () => {
  const derived = deriveTypeScriptOwnerContexts(EXPLICIT_INPUTS);
  expect(derived).toEqual(COMMITTED_ARTIFACT);
  expect(derived.resolution.implementationVersion).toBe(COMMITTED_ARTIFACT.resolution.implementationVersion);
  expect(derived.resolution.implementationSourceSha256).toBe(COMMITTED_ARTIFACT.resolution.implementationSourceSha256);
  console.log(
    "COMPILER AUTHORITY RE-CAPTURE",
    JSON.stringify({
      implementationVersion: derived.resolution.implementationVersion,
      implementationSourceSha256: derived.resolution.implementationSourceSha256,
      aliasVersion: derived.resolution.aliasVersion,
      lockfileSha256: derived.resolution.lockfileSha256,
      runtimeKinds: derived.runtimeKinds.length,
      namedEvaluationContexts: derived.namedEvaluationContexts.length,
      assignmentOperators: derived.assignmentOperators.length,
    }),
  );
});

test("compares exactly the eighteen semantic compiler identity keys", () => {
  const result = evaluateDerivedArtifact(COMMITTED_ARTIFACT);
  expect(result.ok).toBe(true);
  expect(result.comparedKeys).toEqual(COMMITTED_PARTITION.semantic);
  expect(result.evaluatedKeys).toEqual(COMMITTED_PARTITION.semantic);
  expect(result.comparedKeys).toHaveLength(18);
  console.log("COMPARED SEMANTIC KEYS", JSON.stringify(result.comparedKeys));
});

test("records all thirteen provenance keys without comparing any of them", () => {
  const semanticControlSet = new Set(COMMITTED_PARTITION.semantic);
  const receipts = COMMITTED_PARTITION.provenance.map((key) => {
    const mutant = mutateOneLeaf(COMMITTED_ARTIFACT, key);
    const leafDiffSet = collectLeafDiffPaths(COMMITTED_ARTIFACT, mutant);
    const candidate = evaluateDerivedArtifact(mutant);
    const widened = evaluateDerivedArtifact(mutant, {
      comparedKeys: [...COMMITTED_PARTITION.semantic, key],
    });
    const widenedCode = semanticViolationCode(key);
    const diagnostic = formatTypeScriptOwnerContextDiagnostics(candidate);
    const recordedArtifact = JSON.parse(diagnostic).artifact;
    const preservedVariables = [
      "runtimeKinds",
      "runtimeSetHash",
      "namedEvaluationContexts",
      "namedEvaluationSetHash",
      "assignmentOperators",
      "assignmentOperatorSetHash",
      "dispositions",
      "dispositionSetHash",
    ];

    requireControl(JSON.stringify(mutant) !== JSON.stringify(COMMITTED_ARTIFACT), `${key}: mutant did not land`);
    requireControl(leafDiffSet.length === 1 && leafDiffSet[0] === key, `${key}: leaf mutation spilled`);
    requireControl(candidate.ok, `${key}: shipped semantic comparator went red`);
    requireControl(candidate.violations.length === 0, `${key}: shipped comparator reported a violation`);
    requireControl(!widened.ok, `${key}: widened bypass comparator stayed green`);
    requireControl(
      widened.violations.length === 1 && widened.violations[0].code === widenedCode,
      `${key}: widened bypass comparator reached the wrong clause`,
    );
    requireControl(
      JSON.stringify(valueAtPath(recordedArtifact, key)) === JSON.stringify(valueAtPath(mutant, key)),
      `${key}: mutated provenance was not recorded in diagnostics`,
    );
    for (const preserved of preservedVariables) {
      requireControl(
        JSON.stringify(valueAtPath(mutant, preserved)) === JSON.stringify(valueAtPath(COMMITTED_ARTIFACT, preserved)),
        `${key}: changed preserved ${preserved}`,
      );
    }
    const terminalPin = TERMINAL_PIN_KEYS.has(key)
      ? {
          justification: "resolution route is provenance; the installed compiler terminus is pinned",
          pins: [
            "resolution.implementationPackageName",
            "resolution.implementationVersion",
            "resolution.implementationSourceSha256",
          ],
        }
      : null;
    if (terminalPin) {
      requireControl(
        terminalPin.pins.every((pin) => semanticControlSet.has(pin)),
        `${key}: terminal pin missing`,
      );
    }
    return {
      governingVariable: key,
      preservedVariables,
      inputs: candidate.inputs,
      recordedValue: valueAtPath(candidate.artifact, key),
      candidateResult: "green",
      landingArm: { leafDiffSet, cardinality: leafDiffSet.length },
      bypassMutant: {
        comparator: "committed semantic 18 plus exactly the governing provenance key",
        result: "red",
        code: widenedCode,
      },
      terminalPin,
    };
  });

  expect(receipts).toHaveLength(13);
  expect(receipts.map(({ governingVariable }) => governingVariable)).toEqual(COMMITTED_PARTITION.provenance);
  console.log("PROVENANCE RECEIPTS", JSON.stringify(receipts));
  console.log("SEVEN CANDIDATE-GREEN/NAMED-BYPASS-RED RECEIPTS", JSON.stringify(receipts.slice(0, 7)));
});

test("fails on every one of the eighteen semantic keys through its own clause", () => {
  const receipts = COMMITTED_PARTITION.semantic.map((key) => {
    const mutant = mutateOneLeaf(COMMITTED_ARTIFACT, key);
    const leafDiffSet = collectLeafDiffPaths(COMMITTED_ARTIFACT, mutant);
    const result = evaluateDerivedArtifact(mutant);
    const expectedCode = semanticViolationCode(key);
    requireControl(leafDiffSet.length === 1 && leafDiffSet[0] === key, `${key}: semantic mutant spilled`);
    requireControl(!result.ok, `${key}: semantic mutant stayed green`);
    requireControl(result.violations.length === 1, `${key}: more than one clause fired`);
    requireControl(result.violations[0].code === expectedCode, `${key}: wrong clause fired`);
    requireControl(result.evaluatedKeys.at(-1) === key, `${key}: named clause was not reached`);
    requireControl(
      result.evaluatedKeys.slice(0, -1).every((earlier) => earlier !== key),
      `${key}: an earlier clause produced the same terminal result`,
    );
    return {
      governingVariable: key,
      preservedVariables: COMMITTED_PARTITION.inventory.filter((candidate) => candidate !== key),
      inputs: result.inputs,
      candidateResult: "red",
      bypassMutantResult: "named clause reached",
      code: expectedCode,
      noEarlierClause: true,
    };
  });

  expect(receipts).toHaveLength(18);
  expect(receipts.map(({ governingVariable }) => governingVariable)).toEqual(COMMITTED_PARTITION.semantic);
  console.log("SEMANTIC RECEIPTS", JSON.stringify(receipts));
});

test("fails closed on an unclassified key from either side", () => {
  const committedTop = { ...clone(COMMITTED_ARTIFACT), surprise: true };
  const committedNested = clone(COMMITTED_ARTIFACT);
  committedNested.resolution.surprise = true;
  const derivedTop = { ...clone(COMMITTED_ARTIFACT), surprise: true };
  const derivedNested = clone(COMMITTED_ARTIFACT);
  derivedNested.resolution.surprise = true;
  const arrayElement = clone(COMMITTED_ARTIFACT);
  arrayElement.resolution.lockfileKeys[0].surprise = true;

  const controls = [
    {
      site: "committed.<top>.surprise",
      side: "committed",
      result: evaluateDerivedArtifact(COMMITTED_ARTIFACT, { committedArtifact: committedTop }),
      mechanism: "plain-object union",
      code: "derivation-artifact-field-unclassified",
    },
    {
      site: "committed.resolution.surprise",
      side: "committed",
      result: evaluateDerivedArtifact(COMMITTED_ARTIFACT, { committedArtifact: committedNested }),
      mechanism: "plain-object union",
      code: "derivation-artifact-field-unclassified",
    },
    {
      site: "derived.<top>.surprise",
      side: "derived",
      result: evaluateDerivedArtifact(derivedTop),
      mechanism: "plain-object union",
      code: "derivation-artifact-field-unclassified",
    },
    {
      site: "derived.resolution.surprise",
      side: "derived",
      result: evaluateDerivedArtifact(derivedNested),
      mechanism: "plain-object union",
      code: "derivation-artifact-field-unclassified",
    },
    {
      site: "derived.resolution.lockfileKeys[0].surprise",
      side: "derived-array-element",
      result: evaluateDerivedArtifact(arrayElement),
      mechanism: "recursive schema",
      code: "derivation-artifact-schema-invalid",
    },
  ];

  for (const control of controls) {
    requireControl(!control.result.ok, `${control.site}: unknown key stayed green`);
    requireControl(
      control.result.violations.some(({ code }) => code === control.code),
      `${control.site}: wrong mechanism fired`,
    );
  }
  expect(controls).toHaveLength(5);
  console.log(
    "UNCLASSIFIED INJECTION RECEIPTS",
    JSON.stringify(
      controls.map(({ site, side, mechanism, code, result }) => ({
        site,
        side,
        mechanism,
        code,
        inputs: result.inputs,
      })),
    ),
  );
});

test("keeps an unchanged authority green across a lockfile change", () => {
  const firstInputs = {
    resolutionRoot: repoRoot,
    lockfilePath: path.join(FIXTURE_ROOT, "lockfile-a.yaml"),
  };
  const secondInputs = {
    resolutionRoot: repoRoot,
    lockfilePath: path.join(FIXTURE_ROOT, "lockfile-b.yaml"),
  };
  const first = deriveTypeScriptOwnerContexts(firstInputs);
  const second = deriveTypeScriptOwnerContexts(secondInputs);
  const firstResult = compareTypeScriptOwnerContexts(COMMITTED_ARTIFACT, first, {
    partition: COMMITTED_PARTITION,
    schema: COMMITTED_SCHEMA,
    inputs: firstInputs,
  });
  const secondResult = compareTypeScriptOwnerContexts(COMMITTED_ARTIFACT, second, {
    partition: COMMITTED_PARTITION,
    schema: COMMITTED_SCHEMA,
    inputs: secondInputs,
  });

  expect(firstInputs.lockfilePath).not.toBe(secondInputs.lockfilePath);
  expect(first.resolution.lockfileSha256).not.toBe(second.resolution.lockfileSha256);
  expect(first.runtimeKinds).toEqual(second.runtimeKinds);
  expect(first.runtimeSetHash).toBe(second.runtimeSetHash);
  expect(first.namedEvaluationContexts).toEqual(second.namedEvaluationContexts);
  expect(first.namedEvaluationSetHash).toBe(second.namedEvaluationSetHash);
  expect(first.assignmentOperators).toEqual(second.assignmentOperators);
  expect(first.assignmentOperatorSetHash).toBe(second.assignmentOperatorSetHash);
  expect(first.dispositions).toEqual(second.dispositions);
  expect(first.dispositionSetHash).toBe(second.dispositionSetHash);
  expect(firstResult.ok).toBe(true);
  expect(secondResult.ok).toBe(true);
  console.log(
    "LOCKFILE INDEPENDENCE RECEIPT",
    JSON.stringify({
      resolutionRoots: [firstInputs.resolutionRoot, secondInputs.resolutionRoot],
      lockfilePaths: [firstInputs.lockfilePath, secondInputs.lockfilePath],
      lockfileSha256: [first.resolution.lockfileSha256, second.resolution.lockfileSha256],
      setHashQuadruples: [
        [first.runtimeSetHash, first.namedEvaluationSetHash, first.assignmentOperatorSetHash, first.dispositionSetHash],
        [
          second.runtimeSetHash,
          second.namedEvaluationSetHash,
          second.assignmentOperatorSetHash,
          second.dispositionSetHash,
        ],
      ],
      comparisonResults: [firstResult.ok, secondResult.ok],
    }),
  );
});

test("rejects nested unknown keys, missing keys, and malformed members", () => {
  const unknownResolution = clone(COMMITTED_ARTIFACT);
  unknownResolution.resolution.surprise = true;
  const unknownWorkspace = clone(COMMITTED_ARTIFACT);
  unknownWorkspace.workspace.surprise = true;
  const unknownArrayElement = clone(COMMITTED_ARTIFACT);
  unknownArrayElement.runtimeKinds[0].surprise = true;
  const missingDerivedKey = clone(COMMITTED_ARTIFACT);
  delete missingDerivedKey.workspace.packageName;
  const malformedHash = clone(COMMITTED_ARTIFACT);
  malformedHash.workspace.packageSha256 = "not-a-hash";
  const emptyMemberSet = clone(COMMITTED_ARTIFACT);
  emptyMemberSet.runtimeKinds = [];

  expect(collectOpenSchemaObjectPaths(COMMITTED_SCHEMA)).toEqual([]);
  expect(validateAgainstSchema(COMMITTED_ARTIFACT, COMMITTED_SCHEMA)).toEqual([]);
  expect(validateAgainstSchema(unknownResolution, COMMITTED_SCHEMA)).toContain(
    '<root>/resolution: unknown member "surprise"',
  );
  expect(validateAgainstSchema(unknownWorkspace, COMMITTED_SCHEMA)).toContain(
    '<root>/workspace: unknown member "surprise"',
  );
  expect(validateAgainstSchema(unknownArrayElement, COMMITTED_SCHEMA)).toContain(
    '<root>/runtimeKinds[0]: unknown member "surprise"',
  );
  expect(validateAgainstSchema(missingDerivedKey, COMMITTED_SCHEMA)).toContain(
    '<root>/workspace: missing required member "packageName"',
  );
  expect(validateAgainstSchema(malformedHash, COMMITTED_SCHEMA)).toContain(
    "<root>/workspace/packageSha256: does not match ^[a-f0-9]{64}$",
  );
  expect(validateAgainstSchema(emptyMemberSet, COMMITTED_SCHEMA)).toContain(
    "<root>/runtimeKinds: expected at least 1 item(s)",
  );

  const derivedSchemaResult = evaluateDerivedArtifact(missingDerivedKey);
  const committedSchemaResult = evaluateDerivedArtifact(COMMITTED_ARTIFACT, {
    committedArtifact: malformedHash,
  });
  expect(derivedSchemaResult.ok).toBe(false);
  expect(derivedSchemaResult.violations[0].code).toBe("derivation-artifact-schema-invalid");
  expect(derivedSchemaResult.violations[0].side).toBe("derived");
  expect(committedSchemaResult.ok).toBe(false);
  expect(committedSchemaResult.violations[0].code).toBe("derivation-artifact-schema-invalid");
  expect(committedSchemaResult.violations[0].side).toBe("committed");
  console.log(
    "SCHEMA POINTER RECEIPTS",
    JSON.stringify([...committedSchemaResult.violations, ...derivedSchemaResult.violations]),
  );
});

test("reads every expectation from committed data", () => {
  const source = readFileSync(TEST_FILE, "utf8");
  const report = analyzeExpectedArguments(source, TEST_FILE);
  const directSelfComparison = analyzeExpectedArguments(
    `${source}\n${fixtureSource("expected-from-derived-to-equal.mjs")}`,
    "expected-from-derived-to-equal.mjs",
  );
  const matcherVocabulary = analyzeExpectedArguments(
    `${source}\n${fixtureSource("matcher-vocabulary-bypass.mjs")}`,
    "matcher-vocabulary-bypass.mjs",
  );
  const missingSpan = analyzeExpectedArguments(
    fixtureSource("missing-criterion-six-span.mjs"),
    "missing-criterion-six-span.mjs",
  );

  expect(report.code).toBe(null);
  expect(report.violations).toEqual([]);
  expect(directSelfComparison.violations.length > 0).toBe(true);
  expect(matcherVocabulary.violations.some(({ callee }) => callee.includes("toContain"))).toBe(true);
  expect(matcherVocabulary.violations.some(({ callee }) => callee.includes("deepStrictEqual"))).toBe(true);
  expect(missingSpan.code).toBe("criterion-six-span-missing");
  console.log("EXPECTED ARGUMENT TABLE", JSON.stringify(report));
  console.log(
    "EXPECTED ARGUMENT MUTANT RECEIPTS",
    JSON.stringify({
      directSelfComparison: directSelfComparison.violations,
      matcherVocabulary: matcherVocabulary.violations,
      missingSpan: missingSpan.code,
    }),
  );
});

test("covers every artifact key with an uncovered count of zero", () => {
  const semantic = new Set(COMMITTED_PARTITION.semantic);
  const provenance = new Set(COMMITTED_PARTITION.provenance);
  const inventory = new Set(COMMITTED_PARTITION.inventory);
  const union = new Set([...semantic, ...provenance]);
  const derived = deriveTypeScriptOwnerContexts(EXPLICIT_INPUTS);
  const walkedUnion = new Set([...collectLeafPaths(COMMITTED_ARTIFACT), ...collectLeafPaths(derived)]);
  const overlap = [...semantic].filter((key) => provenance.has(key));
  const uncovered = [...inventory].filter((key) => !union.has(key));
  const outsideInventory = [...walkedUnion].filter((key) => !inventory.has(key));

  expect(COMMITTED_PARTITION.inventory).toHaveLength(31);
  expect(COMMITTED_PARTITION.semantic).toHaveLength(18);
  expect(COMMITTED_PARTITION.provenance).toHaveLength(13);
  expect(overlap).toEqual([]);
  expect(uncovered).toEqual([]);
  expect(outsideInventory).toEqual([]);
  expect(collectUnclassifiedFields(COMMITTED_ARTIFACT, derived, COMMITTED_PARTITION)).toEqual([]);
  expect(COMMITTED_PARTITION.arrayElementPaths).toHaveLength(12);
  for (const arrayElementPath of COMMITTED_PARTITION.arrayElementPaths) {
    requireControl(!inventory.has(arrayElementPath), `${arrayElementPath}: array element entered inventory`);
    requireControl(!semantic.has(arrayElementPath), `${arrayElementPath}: array element entered semantic keys`);
    requireControl(!provenance.has(arrayElementPath), `${arrayElementPath}: array element entered provenance keys`);
  }
  console.log(
    "KEY PARTITION",
    JSON.stringify({
      semantic: COMMITTED_PARTITION.semantic,
      provenance: COMMITTED_PARTITION.provenance,
      inventory: COMMITTED_PARTITION.inventory,
      arrayElementPaths: COMMITTED_PARTITION.arrayElementPaths,
    }),
  );
  console.log("UNCLASSIFIED COUNT: 0");
});

test("reaches every named failure through explicit inputs", () => {
  const semanticMutant = mutateOneLeaf(COMMITTED_ARTIFACT, "runtimeSetHash");
  const unclassifiedMutant = { ...clone(COMMITTED_ARTIFACT), surprise: true };
  const schemaMutant = clone(COMMITTED_ARTIFACT);
  delete schemaMutant.workspace.packageName;
  const controls = [
    evaluateDerivedArtifact(semanticMutant),
    evaluateDerivedArtifact(unclassifiedMutant),
    evaluateDerivedArtifact(schemaMutant),
  ];
  const expectedCodes = [
    "derivation-artifact-runtimeSetHash-mismatch",
    "derivation-artifact-field-unclassified",
    "derivation-artifact-schema-invalid",
  ];
  controls.forEach((result, index) => {
    requireControl(result.inputs.resolutionRoot === EXPLICIT_INPUTS.resolutionRoot, "implicit resolutionRoot");
    requireControl(result.inputs.lockfilePath === EXPLICIT_INPUTS.lockfilePath, "implicit lockfilePath");
    requireControl(result.violations[0].code === expectedCodes[index], "negative control reached wrong code");
  });
  expect(controls).toHaveLength(3);
  console.log(
    "EXPLICIT INPUT NEGATIVE CONTROL TABLE",
    JSON.stringify(
      controls.map((result) => ({
        inputs: result.inputs,
        code: result.violations[0].code,
      })),
    ),
  );
});

test("joins only the Vitest scripts battery and adds no structure registry consumer", () => {
  const config = readFileSync(path.join(repoRoot, "vitest.scripts.config.mjs"), "utf8");
  const structureRegistry = readFileSync(path.join(repoRoot, "scripts/check-structure/run.mjs"), "utf8");
  expect(config).toContain('include: ["scripts/**/*.test.mjs"]');
  expect(structureRegistry.includes("typescript-owner-context")).toBe(false);
  expect(structureRegistry.includes("test.mjs")).toBe(false);
});
