import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const manifestPath = "infrastructure/playwright-evidence/responsive-evidence-manifest.json";

export async function validateResponsiveEvidenceGuard({ repoRoot }) {
  const violations = [];
  const manifest = await readManifest(repoRoot, violations);
  if (!manifest) {
    return { violations, hits: [], discovery: { claims: 0, files: [] } };
  }

  const claimIds = new Set();
  const artifactNames = new Set();
  const files = [...new Set(manifest.claims.map((claim) => normalize(claim.file)))].sort();
  const parsedFiles = new Map();
  const hits = [];

  for (const claim of manifest.claims) {
    validateClaimShape(claim, claimIds, artifactNames, violations);
  }

  for (const relativeFile of files) {
    try {
      const source = await readFile(path.join(repoRoot, relativeFile), "utf8");
      parsedFiles.set(
        relativeFile,
        ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
      );
    } catch (error) {
      violations.push(
        `responsive evidence manifest file '${relativeFile}' cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const claim of manifest.claims) {
    const relativeFile = normalize(claim.file);
    const sourceFile = parsedFiles.get(relativeFile);
    if (!sourceFile) continue;
    const tests = findTests(sourceFile).filter((candidate) => candidate.title === claim.testTitle);
    if (tests.length !== 1) {
      violations.push(
        `${relativeFile}: responsive evidence claim '${claim.id}' must resolve exactly one test titled '${claim.testTitle}' (found ${tests.length}).`,
      );
      continue;
    }

    const testCase = tests[0];
    const contractCalls = findCalls(testCase.callback, "captureResponsiveEvidence");
    const matchingContractCalls = contractCalls.filter(
      (call) => objectStringProperty(call.arguments[0], "claimId") === claim.id,
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

  return {
    violations,
    hits,
    discovery: { claims: manifest.claims.length, files },
  };
}

async function readManifest(repoRoot, violations) {
  try {
    const parsed = JSON.parse(await readFile(path.join(repoRoot, manifestPath), "utf8"));
    if (
      !parsed ||
      parsed.contract !== "fail-closed-responsive-evidence" ||
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.claims) ||
      parsed.claims.length === 0
    ) {
      violations.push(`${manifestPath}: expected the fail-closed schemaVersion 1 contract with at least one claim.`);
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

function validateClaimShape(claim, claimIds, artifactNames, violations) {
  const label = typeof claim?.id === "string" && claim.id ? claim.id : "<missing-id>";
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
}

function validateMeasurementShape(claimId, measurement, measurementIds, violations) {
  const identity = typeof measurement?.identity === "string" ? measurement.identity.trim() : "";
  const assertion = measurement?.assertion;
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
}

function findTests(sourceFile) {
  const tests = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isTestCall(node.expression)) return;
    const title = stringLiteral(node.arguments[0]);
    const callback = [...node.arguments]
      .reverse()
      .find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (title !== null && callback) tests.push({ node, title, callback });
  });
  return tests;
}

function isTestCall(expression) {
  if (ts.isIdentifier(expression)) return expression.text === "test";
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "test" &&
    ["only", "skip", "fixme", "fail"].includes(expression.name.text)
  );
}

function optionalEvidenceGates(callback) {
  const gates = [];
  visit(callback.body, (node) => {
    if (!ts.isIfStatement(node)) return;
    const optionalCondition =
      findMethodCalls(node.expression, "count").length > 0 ||
      findMethodCalls(node.expression, "isVisible").length > 0 ||
      findMethodCalls(node.expression, "isHidden").length > 0;
    if (!optionalCondition) return;
    const branchContainsEvidence =
      containsEvidenceOperation(node.thenStatement) ||
      (node.elseStatement ? containsEvidenceOperation(node.elseStatement) : false);
    if (branchContainsEvidence) gates.push(node);
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
