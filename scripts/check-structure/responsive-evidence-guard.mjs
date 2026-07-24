import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";

const manifestPath = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const productionRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const canonicalModule = "@chase-sets/playwright-evidence";

export async function validateResponsiveEvidenceGuard({ repoRoot }) {
  const violations = [];
  const manifest = await readManifest(repoRoot, violations);
  if (!manifest) {
    return { violations, hits: [], discovery: { claims: 0, files: [] } };
  }

  const claimIds = new Set();
  const artifactNames = new Set();
  const associationKeys = new Set();
  const e2eFiles = await discoverE2eSpecFiles(repoRoot);
  const files = e2eFiles.map((file) => normalize(path.relative(repoRoot, file))).sort();
  const parsedFiles = new Map();
  const hits = [];

  for (const claim of manifest.claims) {
    validateClaimShape(claim, claimIds, artifactNames, associationKeys, violations);
  }

  for (const absoluteFile of e2eFiles) {
    const relativeFile = normalize(path.relative(repoRoot, absoluteFile));
    try {
      const source = await readFile(absoluteFile, "utf8");
      parsedFiles.set(relativeFile, {
        source,
        sourceFile: ts.createSourceFile(
          relativeFile,
          source,
          ts.ScriptTarget.Latest,
          true,
          relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      });
    } catch (error) {
      violations.push(
        `responsive evidence manifest file '${relativeFile}' cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const discoveredCalls = [];
  for (const [relativeFile, parsed] of parsedFiles) {
    discoveredCalls.push(...discoverContractCalls(relativeFile, parsed.sourceFile, violations));
  }

  for (const call of discoveredCalls) {
    if (!call.claimId) {
      violations.push(
        `${call.file}:${call.line}: responsive evidence capture must use one literal nonempty claimId so the claim inventory cannot be optional.`,
      );
      continue;
    }
    const matchingClaims = manifest.claims.filter((claim) => claim.id === call.claimId);
    if (matchingClaims.length !== 1) {
      violations.push(
        `${call.file}:${call.line}: captureResponsiveEvidence claim '${call.claimId}' must have exactly one source-manifest claim (found ${matchingClaims.length}).`,
      );
    }
  }

  for (const claim of manifest.claims) {
    const relativeFile = normalize(claim.file);
    const parsed = parsedFiles.get(relativeFile);
    if (!parsed) {
      violations.push(
        `${manifestPath}: responsive evidence claim '${claim.id}' names undiscovered E2E spec '${relativeFile}'.`,
      );
      continue;
    }
    const sourceFile = parsed.sourceFile;
    const tests = findTests(sourceFile).filter((candidate) => candidate.title === claim.testTitle);
    if (tests.length !== 1) {
      violations.push(
        `${relativeFile}: responsive evidence claim '${claim.id}' must resolve exactly one test titled '${claim.testTitle}' (found ${tests.length}).`,
      );
      continue;
    }

    const testCase = tests[0];
    if (testCase.modifier !== null) {
      violations.push(
        `${relativeFile}:${line(sourceFile, testCase.node)}: responsive evidence claim '${claim.id}' must use an active test(...) registration, not test.${testCase.modifier}(...).`,
      );
    }
    const matchingContractCalls = discoveredCalls.filter(
      (call) => call.file === relativeFile && call.testNode === testCase.node && call.claimId === claim.id,
    );
    if (matchingContractCalls.length !== 1) {
      violations.push(
        `${relativeFile}:${line(sourceFile, testCase.node)}: responsive evidence claim '${claim.id}' must call captureResponsiveEvidence exactly once with its literal claimId (found ${matchingContractCalls.length}).`,
      );
    }

    const screenshots = findMethodCalls(testCase.callback, "screenshot");
    if (screenshots.length > 0) {
      violations.push(
        `${relativeFile}:${line(sourceFile, screenshots[0])}: designated responsive evidence claim '${claim.id}' may not call screenshot directly; capture through the shared fail-closed contract.`,
      );
    }

    for (const gate of optionalEvidenceGates(testCase.callback)) {
      violations.push(
        `${relativeFile}:${line(sourceFile, gate)}: designated responsive evidence claim '${claim.id}' may not condition capture on locator count/visibility; absent or hidden targets must fail closed.`,
      );
    }

    for (const replacement of catchAndLogReplacements(testCase.callback)) {
      violations.push(
        `${relativeFile}:${line(sourceFile, replacement)}: designated responsive evidence claim '${claim.id}' may not catch-and-log a target assertion or capture; evidence failures must escape.`,
      );
    }

    hits.push({
      id: claim.id,
      kind: claim.kind,
      file: relativeFile,
      testTitle: claim.testTitle,
      contractCalls: matchingContractCalls.length,
    });
  }

  violations.push(...(await validateInfrastructureOnlyBoundary({ repoRoot })));

  return {
    violations,
    hits,
    discovery: { claims: manifest.claims.length, files },
  };
}

async function readManifest(repoRoot, violations) {
  try {
    const parsed = JSON.parse(await readFile(path.join(repoRoot, manifestPath), "utf8"));
    const schemaViolations = validateResponsiveEvidenceSourceManifest(parsed);
    if (schemaViolations.length > 0) {
      violations.push(...schemaViolations.map((violation) => `${manifestPath}: ${violation}`));
      return null;
    }
    return parsed;
  } catch (error) {
    violations.push(
      `${manifestPath}: cannot read responsive evidence manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export function validateResponsiveEvidenceSourceManifest(parsed) {
  const violations = [];
  if (!isClosedObject(parsed, ["contract", "schemaVersion", "claims"])) {
    violations.push("source manifest must be a closed object with only contract, schemaVersion, and claims.");
    return violations;
  }
  if (
    parsed.contract !== "fail-closed-responsive-evidence" ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.claims) ||
    parsed.claims.length === 0
  ) {
    violations.push("expected the fail-closed schemaVersion 1 contract with at least one claim.");
    return violations;
  }
  const claimIds = new Set();
  const artifactNames = new Set();
  const associationKeys = new Set();
  for (const claim of parsed.claims) {
    validateClaimShape(claim, claimIds, artifactNames, associationKeys, violations);
  }
  return violations;
}

function validateClaimShape(claim, claimIds, artifactNames, associationKeys, violations) {
  const label = typeof claim?.id === "string" && claim.id ? claim.id : "<missing-id>";
  if (
    !isClosedObject(claim, [
      "kind",
      "id",
      "file",
      "testTitle",
      "route",
      "fixture",
      "viewport",
      "target",
      "measurements",
      "artifact",
    ]) ||
    !isClosedObject(claim?.route, ["name", "path"]) ||
    !isClosedObject(claim?.fixture, ["identity"]) ||
    !isClosedObject(claim?.viewport, ["width", "height"]) ||
    !isClosedObject(claim?.target, ["identity", "selector", "populatedSelector"])
  ) {
    violations.push(`responsive evidence claim '${label}' and every nested object must use the closed schema.`);
  }
  const requiredText = [
    ["id", claim?.id],
    ["file", claim?.file],
    ["testTitle", claim?.testTitle],
    ["route.name", claim?.route?.name],
    ["route.path", claim?.route?.path],
    ["fixture.identity", claim?.fixture?.identity],
    ["target.identity", claim?.target?.identity],
    ["target.selector", claim?.target?.selector],
    ["target.populatedSelector", claim?.target?.populatedSelector],
    ["artifact", claim?.artifact],
  ];
  for (const [field, value] of requiredText) {
    if (typeof value !== "string" || !value.trim()) {
      violations.push(`${manifestPath}: responsive evidence claim '${label}' requires nonempty ${field}.`);
    }
  }
  if (!["claim", "negative-control"].includes(claim?.kind)) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${label}' has unsupported kind '${String(claim?.kind)}'.`,
    );
  }
  if (typeof claim?.route?.path !== "string" || !claim.route.path.startsWith("/")) {
    violations.push(`${manifestPath}: responsive evidence claim '${label}' route.path must be root-relative.`);
  }
  if (
    !Number.isInteger(claim?.viewport?.width) ||
    claim.viewport.width <= 0 ||
    !Number.isInteger(claim?.viewport?.height) ||
    claim.viewport.height <= 0
  ) {
    violations.push(`${manifestPath}: responsive evidence claim '${label}' requires a positive integer viewport.`);
  }
  if (!Array.isArray(claim?.measurements) || claim.measurements.length === 0) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${label}' requires explicit layout/size measurements.`,
    );
  } else {
    const measurementIds = new Set();
    for (const measurement of claim.measurements) {
      validateMeasurementShape(label, measurement, measurementIds, violations);
    }
  }
  const normalizedFile = normalize(String(claim?.file ?? ""));
  if (
    !/^deployables\/(?:admin-web|marketplace)\/e2e\/.+\.spec\.ts$/.test(normalizedFile) ||
    normalizedFile.includes("../")
  ) {
    violations.push(`${manifestPath}: responsive evidence claim '${label}' must designate a deployable E2E spec.`);
  }
  if (claimIds.has(claim?.id)) {
    violations.push(`${manifestPath}: responsive evidence claim id '${label}' is duplicated.`);
  }
  claimIds.add(claim?.id);
  if (artifactNames.has(claim?.artifact)) {
    violations.push(`${manifestPath}: responsive evidence artifact '${String(claim?.artifact)}' is duplicated.`);
  }
  artifactNames.add(claim?.artifact);
  const associationKey = JSON.stringify([
    claim?.route?.path,
    claim?.fixture?.identity,
    claim?.viewport?.width,
    claim?.viewport?.height,
    claim?.target?.identity,
    claim?.artifact,
  ]);
  const identityKey = JSON.stringify([
    claim?.route?.path,
    claim?.fixture?.identity,
    claim?.viewport?.width,
    claim?.viewport?.height,
    claim?.target?.identity,
  ]);
  if (associationKeys.has(identityKey)) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${label}' duplicates route+fixture+viewport+target identity.`,
    );
  }
  associationKeys.add(identityKey);
  if (!claim?.artifact || associationKey.includes("null")) {
    return;
  }
}

function validateMeasurementShape(claimId, measurement, measurementIds, violations) {
  const identity = typeof measurement?.identity === "string" ? measurement.identity.trim() : "";
  const assertion = measurement?.assertion;
  if (
    !isClosedObject(measurement, ["identity", "scope", "selector", "property", "assertion"]) ||
    !isClosedObject(assertion, ["equals", "minimum", "maximum", "tolerance"])
  ) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${claimId}' measurement '${identity}' must use the closed nested schema.`,
    );
  }
  if (!identity) {
    violations.push(`${manifestPath}: responsive evidence claim '${claimId}' has a measurement without identity.`);
  } else if (measurementIds.has(identity)) {
    violations.push(`${manifestPath}: responsive evidence claim '${claimId}' duplicates measurement '${identity}'.`);
  }
  measurementIds.add(identity);
  if (!["target", "page", "document"].includes(measurement?.scope)) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${claimId}' measurement '${identity}' has unsupported scope.`,
    );
  }
  if (!["width", "height", "display", "visible", "horizontal-overflow"].includes(measurement?.property)) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${claimId}' measurement '${identity}' has unsupported property.`,
    );
  }
  if (
    (measurement?.scope === "document" && measurement?.selector !== undefined) ||
    (measurement?.scope !== "document" && (typeof measurement?.selector !== "string" || !measurement.selector.trim()))
  ) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${claimId}' measurement '${identity}' has an invalid selector.`,
    );
  }
  if (
    !assertion ||
    typeof assertion !== "object" ||
    !("equals" in assertion || "minimum" in assertion || "maximum" in assertion)
  ) {
    violations.push(
      `${manifestPath}: responsive evidence claim '${claimId}' measurement '${identity}' requires an equality or bound assertion.`,
    );
  }
  if (measurement?.property === "height") {
    const guaranteedMinimum =
      typeof assertion?.equals === "number"
        ? assertion.equals - (typeof assertion.tolerance === "number" ? assertion.tolerance : 0)
        : assertion?.minimum;
    if (typeof guaranteedMinimum !== "number" || guaranteedMinimum < 43.5) {
      violations.push(
        `${manifestPath}: responsive evidence claim '${claimId}' height measurement '${identity}' must independently guarantee the 44px minimum.`,
      );
    }
  }
}

function findTests(sourceFile) {
  const tests = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const modifier = testModifier(node.expression);
    if (modifier === undefined) return;
    const title = stringLiteral(node.arguments[0]);
    const callback = [...node.arguments]
      .reverse()
      .find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (title !== null && callback) tests.push({ node, title, callback, modifier });
  });
  return tests;
}

function testModifier(expression) {
  if (ts.isIdentifier(expression) && expression.text === "test") return null;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "test" &&
    ["only", "skip", "fixme", "fail"].includes(expression.name.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function optionalEvidenceGates(callback) {
  const gates = [];
  visit(callback.body, (node) => {
    if (
      (ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        (ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(node.operatorToken.kind))) &&
      containsEvidenceOperation(node)
    ) {
      gates.push(node);
    }
  });
  return gates;
}

function catchAndLogReplacements(callback) {
  const replacements = [];
  const testContainsEvidence = containsEvidenceOperation(callback.body);
  if (!testContainsEvidence) return replacements;
  visit(callback.body, (node) => {
    if (ts.isTryStatement(node) && node.catchClause) {
      const tryContainsTargetProof =
        findCalls(node.tryBlock, "expect").length > 0 || containsEvidenceOperation(node.tryBlock);
      const catchRethrows = findNodes(node.catchClause.block, ts.isThrowStatement).length > 0;
      if (tryContainsTargetProof && !catchRethrows) replacements.push(node);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const receiver = node.expression.expression;
      const receiverContainsTargetProof =
        findCalls(receiver, "expect").length > 0 ||
        findCalls(receiver, "captureResponsiveEvidence").length > 0 ||
        findMethodCalls(receiver, "isVisible").length > 0 ||
        findMethodCalls(receiver, "count").length > 0;
      const handler = node.arguments[0];
      const handlerRethrows = handler ? findNodes(handler, ts.isThrowStatement).length > 0 : false;
      if (receiverContainsTargetProof && !handlerRethrows) replacements.push(node);
    }
  });
  return replacements;
}

function containsEvidenceOperation(node) {
  return findCalls(node, "captureResponsiveEvidence").length > 0 || findMethodCalls(node, "screenshot").length > 0;
}

function findCalls(node, functionName) {
  return findNodes(
    node,
    (candidate) =>
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === functionName,
  );
}

function findMethodCalls(node, methodName) {
  return findNodes(
    node,
    (candidate) =>
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === methodName,
  );
}

function findNodes(node, predicate) {
  const matches = [];
  visit(node, (candidate) => {
    if (predicate(candidate)) matches.push(candidate);
  });
  return matches;
}

function objectStringProperty(node, propertyName) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : null;
    if (name === propertyName) return stringLiteral(property.initializer);
  }
  return null;
}

function stringLiteral(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

async function discoverE2eSpecFiles(repoRoot) {
  const files = [];
  for (const deployable of ["admin-web", "marketplace"]) {
    files.push(
      ...(await collectFiles(path.join(repoRoot, "deployables", deployable, "e2e"), {
        extensions: new Set([".ts", ".tsx"]),
        skippedDirectories: defaultSkippedDirectories,
      })),
    );
  }
  return files.filter((file) => /\.spec\.tsx?$/.test(file)).sort();
}

function discoverContractCalls(relativeFile, sourceFile, violations) {
  const canonicalBindings = new Set();
  visit(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node) || stringLiteral(node.moduleSpecifier) !== canonicalModule) return;
    for (const element of node.importClause?.namedBindings?.elements ?? []) {
      if ((element.propertyName?.text ?? element.name.text) === "captureResponsiveEvidence") {
        canonicalBindings.add(element.name.text);
      }
    }
  });

  const candidateNames = new Set(["captureResponsiveEvidence", ...canonicalBindings]);
  const shadowedNames = new Set();
  visit(sourceFile, (node) => {
    if (ts.isImportSpecifier(node)) return;
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      candidateNames.has(node.name.text)
    ) {
      shadowedNames.add(node.name.text);
    }
  });

  const tests = findTests(sourceFile);
  const calls = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !candidateNames.has(node.expression.text)) {
      return;
    }
    const binding = node.expression.text;
    const testCase = tests.find(
      (candidate) => node.pos >= candidate.callback.pos && node.end <= candidate.callback.end,
    );
    if (!canonicalBindings.has(binding)) {
      violations.push(
        `${relativeFile}:${line(sourceFile, node)}: responsive evidence capture must call the canonical '${canonicalModule}' helper binding.`,
      );
    }
    if (shadowedNames.has(binding)) {
      violations.push(
        `${relativeFile}:${line(sourceFile, node)}: responsive evidence helper binding '${binding}' is locally shadowed or substituted.`,
      );
    }
    if (!testCase) {
      violations.push(
        `${relativeFile}:${line(sourceFile, node)}: responsive evidence capture must be owned by one active Playwright test registration.`,
      );
    }
    calls.push({
      file: relativeFile,
      line: line(sourceFile, node),
      claimId: objectStringProperty(node.arguments[0], "claimId"),
      testNode: testCase?.node ?? null,
    });
  });
  return calls;
}

async function validateInfrastructureOnlyBoundary({ repoRoot }) {
  const violations = [];
  for (const root of productionRoots) {
    const absoluteRoot = path.join(repoRoot, root);
    for (const absoluteFile of await collectFiles(absoluteRoot, {
      extensions: sourceExtensions,
      skippedDirectories: defaultSkippedDirectories,
    })) {
      const relativeFile = normalize(path.relative(repoRoot, absoluteFile));
      if (
        relativeFile.startsWith("infrastructure/playwright-evidence/") ||
        /(?:^|\/)(?:e2e|__tests__|test-support)(?:\/|$)/.test(relativeFile) ||
        /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(relativeFile)
      ) {
        continue;
      }
      const source = await readFile(absoluteFile, "utf8");
      if (!source.includes("playwright-evidence")) continue;
      const sourceFile = ts.createSourceFile(
        relativeFile,
        source,
        ts.ScriptTarget.Latest,
        true,
        relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      visit(sourceFile, (node) => {
        let moduleText = null;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          moduleText = stringLiteral(node.moduleSpecifier);
        } else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
          moduleText = stringLiteral(node.arguments[0]);
        }
        if (
          moduleText === canonicalModule ||
          (typeof moduleText === "string" && normalize(moduleText).includes("infrastructure/playwright-evidence"))
        ) {
          violations.push(
            `${relativeFile}:${line(sourceFile, node)}: runtime source may not import the infrastructure-only Playwright evidence package '${moduleText}'.`,
          );
        }
      });
    }
  }
  return violations;
}

function isClosedObject(value, allowedKeys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function line(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function visit(node, callback) {
  const walk = (candidate) => {
    callback(candidate);
    candidate.forEachChild(walk);
  };
  walk(node);
}

function normalize(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

if (process.argv[1]?.endsWith("responsive-evidence-guard.mjs")) {
  const result = await validateResponsiveEvidenceGuard({ repoRoot: process.cwd() });
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `responsive evidence guard: ${result.discovery.claims} claims across ${result.discovery.files.length} specs use the shared fail-closed contract.`,
    );
  }
}
