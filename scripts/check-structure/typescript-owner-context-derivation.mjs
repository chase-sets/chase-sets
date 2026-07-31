import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { collectOpenSchemaObjectPaths, validateAgainstSchema } from "./identity-creation-path-registry.mjs";
import { repoRoot } from "../lib/repo.mjs";

export const typeScriptOwnerContextArtifactPath = "scripts/check-structure/typescript-owner-contexts.json";
export const typeScriptOwnerContextPartitionPath = "scripts/check-structure/typescript-owner-context-partition.json";
export const typeScriptOwnerContextSchemaPath = "scripts/check-structure/typescript-owner-contexts-v1.schema.json";

export class TypeScriptOwnerContextError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "TypeScriptOwnerContextError";
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function relativeTo(rootDir, absolutePath) {
  return normalizePath(path.relative(rootDir, absolutePath));
}

function readJson(rootDir, relativePath) {
  return JSON.parse(readFileSync(path.join(rootDir, relativePath), "utf8"));
}

function packageJsonForEntry(entryPath) {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, "package.json");
    try {
      return { path: candidate, value: JSON.parse(readFileSync(candidate, "utf8")) };
    } catch {
      current = path.dirname(current);
    }
  }
  throw new TypeScriptOwnerContextError(
    "typescript-owner-context-package-unavailable",
    `no package.json owns ${entryPath}`,
  );
}

function extractFunctionSource(source, symbolName) {
  const marker = `function ${symbolName}(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new TypeScriptOwnerContextError(
      "typescript-owner-context-source-symbol-missing",
      `${symbolName} is missing from the installed compiler source`,
      { symbolName },
    );
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new TypeScriptOwnerContextError(
    "typescript-owner-context-source-symbol-unterminated",
    `${symbolName} is unterminated in the installed compiler source`,
    { symbolName },
  );
}

function switchCasesAtIndent(functionSource, spaces) {
  const expression = new RegExp(`^${" ".repeat(spaces)}case (\\d+) /\\* ([^*]+) \\*/:`, "gm");
  return [...functionSource.matchAll(expression)].map((match) => ({
    kind: Number(match[1]),
    name: match[2],
  }));
}

function lockfileKeys(lockfile) {
  const keys = [
    "typescript-api:",
    "version: '@typescript/typescript6@6.0.2'",
    "'@typescript/typescript6@6.0.2':",
    "'@typescript/old': typescript@6.0.3",
    "typescript@6.0.3:",
  ];
  return keys.map((key) => ({ key, occurrences: lockfile.split(key).length - 1 }));
}

function dispositionRows(namedEvaluationContexts) {
  const rows = {
    PropertyAssignment: {
      qualifier: "not a __proto__ setter",
      orderedOutcomes: [
        "stable:recursively-locally-rooted-object-path",
        "transparent:nameless-call-or-new-argument",
        "ambiguous",
      ],
    },
    ShorthandPropertyAssignment: {
      qualifier: "has objectAssignmentInitializer",
      orderedOutcomes: ["ambiguous"],
    },
    VariableDeclaration: {
      qualifier: "identifier name plus initializer",
      orderedOutcomes: ["stable:direct-local-identifier", "ambiguous"],
    },
    Parameter: {
      qualifier: "identifier default initializer and no rest token",
      orderedOutcomes: ["ambiguous"],
    },
    BindingElement: {
      qualifier: "identifier default initializer and no rest token",
      orderedOutcomes: ["ambiguous"],
    },
    PropertyDeclaration: {
      qualifier: "initializer present",
      orderedOutcomes: ["ambiguous"],
    },
    BinaryExpression: {
      qualifier: "identifier left and one derived assignment operator",
      orderedOutcomes: ["ambiguous"],
    },
    ExportAssignment: {
      qualifier: "any expression",
      orderedOutcomes: ["ambiguous"],
    },
  };
  return namedEvaluationContexts.map(({ name, kind }) => ({
    context: name,
    kind,
    ...rows[name],
  }));
}

export function loadTypeScriptOwnerContextArtifact(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.artifactPath ?? typeScriptOwnerContextArtifactPath);
}

export function loadTypeScriptOwnerContextPartition(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.partitionPath ?? typeScriptOwnerContextPartitionPath);
}

export function loadTypeScriptOwnerContextSchema(options = {}) {
  return readJson(options.repoRoot ?? repoRoot, options.schemaPath ?? typeScriptOwnerContextSchemaPath);
}

export function deriveTypeScriptOwnerContexts({
  resolutionRoot = repoRoot,
  lockfilePath = path.join(resolutionRoot, "pnpm-lock.yaml"),
} = {}) {
  const workspacePackagePath = path.join(resolutionRoot, "packages/typescript-compiler-api/package.json");
  const wrapperPath = path.join(resolutionRoot, "packages/typescript-compiler-api/index.mjs");
  const workspacePackage = JSON.parse(readFileSync(workspacePackagePath, "utf8"));
  const workspaceRequire = createRequire(wrapperPath);
  const aliasEntry = workspaceRequire.resolve("typescript-api");
  const aliasPackage = packageJsonForEntry(aliasEntry);
  const aliasRequire = createRequire(aliasEntry);
  const implementationEntry = realpathSync(aliasRequire.resolve("@typescript/old"));
  const implementationPackage = packageJsonForEntry(implementationEntry);
  const source = readFileSync(implementationEntry, "utf8");
  const runtimeSource = extractFunctionSource(source, "isFunctionLikeDeclarationKind");
  const functionLikeSource = extractFunctionSource(source, "isFunctionLikeKind");
  const namedSource = extractFunctionSource(source, "isNamedEvaluationSource");
  const runtimeKinds = switchCasesAtIndent(runtimeSource, 4);
  const namedEvaluationContexts = switchCasesAtIndent(namedSource, 4);
  const assignmentOperators = switchCasesAtIndent(namedSource, 8);
  const dispositions = dispositionRows(namedEvaluationContexts);
  const lockfile = readFileSync(lockfilePath, "utf8");

  return {
    contractVersion: "consent-authorization-owner-contexts/v1",
    workspace: {
      packageName: workspacePackage.name,
      packageVersion: workspacePackage.version,
      packagePath: relativeTo(resolutionRoot, workspacePackagePath),
      packageSha256: sha256(readFileSync(workspacePackagePath)),
      wrapperPath: relativeTo(resolutionRoot, wrapperPath),
      wrapperSha256: sha256(readFileSync(wrapperPath)),
    },
    resolution: {
      aliasName: aliasPackage.value.name,
      aliasVersion: aliasPackage.value.version,
      aliasEntryPath: relativeTo(resolutionRoot, realpathSync(aliasEntry)),
      implementationPackageName: implementationPackage.value.name,
      implementationVersion: implementationPackage.value.version,
      implementationPath: relativeTo(resolutionRoot, implementationEntry),
      implementationSourceSha256: sha256(source),
      lockfilePath: relativeTo(resolutionRoot, lockfilePath),
      lockfileSha256: sha256(lockfile),
      lockfileKeys: lockfileKeys(lockfile),
    },
    sourceSymbols: {
      functionLikeDeclarationKind: "isFunctionLikeDeclarationKind",
      functionLikeKind: "isFunctionLikeKind",
      namedEvaluationSource: "isNamedEvaluationSource",
      functionLikeKindSourceSha256: sha256(functionLikeSource),
    },
    runtimePredicate: "ts.isFunctionLike(node) && node.body",
    runtimeKinds,
    runtimeSetHash: sha256(JSON.stringify(runtimeKinds)),
    namedEvaluationContexts,
    namedEvaluationSetHash: sha256(JSON.stringify(namedEvaluationContexts)),
    assignmentOperators,
    assignmentOperatorSetHash: sha256(JSON.stringify(assignmentOperators)),
    dispositions,
    dispositionSetHash: sha256(JSON.stringify(dispositions)),
    unknownDisposition: "ambiguous",
  };
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function collectLeafPaths(value, prefix = "") {
  if (!isPlainObject(value)) return prefix ? [prefix] : [];
  return Object.keys(value)
    .sort()
    .flatMap((key) => collectLeafPaths(value[key], prefix ? `${prefix}.${key}` : key));
}

export function collectLeafDiffPaths(left, right) {
  const paths = new Set([...collectLeafPaths(left), ...collectLeafPaths(right)]);
  return [...paths]
    .filter((key) => JSON.stringify(valueAtPath(left, key)) !== JSON.stringify(valueAtPath(right, key)))
    .sort();
}

export function valueAtPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, segment) => current?.[segment], value);
}

export function semanticViolationCode(key) {
  return `derivation-artifact-${key.replaceAll(".", "-")}-mismatch`;
}

export function collectUnclassifiedFields(committedArtifact, derivedArtifact, partition) {
  const inventory = new Set(partition.inventory);
  const union = new Set([...collectLeafPaths(committedArtifact), ...collectLeafPaths(derivedArtifact)]);
  return [...union].filter((key) => !inventory.has(key)).sort();
}

function schemaViolations(artifact, schema, side) {
  return validateAgainstSchema(artifact, schema).map((message) => ({
    code: "derivation-artifact-schema-invalid",
    side,
    pointer: message.split(":", 1)[0],
    message,
  }));
}

export function compareTypeScriptOwnerContexts(
  committedArtifact,
  derivedArtifact,
  {
    partition = loadTypeScriptOwnerContextPartition(),
    schema = loadTypeScriptOwnerContextSchema(),
    comparedKeys = partition.semantic,
    inputs = null,
  } = {},
) {
  const unclassified = collectUnclassifiedFields(committedArtifact, derivedArtifact, partition);
  if (unclassified.length > 0) {
    return {
      ok: false,
      inputs,
      comparedKeys: [...comparedKeys],
      evaluatedKeys: [],
      artifact: derivedArtifact,
      violations: [
        {
          code: "derivation-artifact-field-unclassified",
          fields: unclassified,
          message: `unclassified derivation artifact field(s): ${unclassified.join(", ")}`,
        },
      ],
    };
  }

  const evaluatedKeys = [];
  for (const key of comparedKeys) {
    evaluatedKeys.push(key);
    if (JSON.stringify(valueAtPath(committedArtifact, key)) !== JSON.stringify(valueAtPath(derivedArtifact, key))) {
      return {
        ok: false,
        inputs,
        comparedKeys: [...comparedKeys],
        evaluatedKeys,
        artifact: derivedArtifact,
        violations: [
          {
            code: semanticViolationCode(key),
            key,
            message: `${key} differs from the committed semantic compiler identity`,
          },
        ],
      };
    }
  }

  const openSchemaObjects = collectOpenSchemaObjectPaths(schema);
  const invalidSchema = openSchemaObjects.map((pointer) => ({
    code: "derivation-artifact-schema-open",
    side: "schema",
    pointer,
    message: `${pointer}: object schema is not recursively closed`,
  }));
  const invalidArtifacts = [
    ...schemaViolations(committedArtifact, schema, "committed"),
    ...schemaViolations(derivedArtifact, schema, "derived"),
  ];
  if (invalidSchema.length > 0 || invalidArtifacts.length > 0) {
    return {
      ok: false,
      inputs,
      comparedKeys: [...comparedKeys],
      evaluatedKeys,
      artifact: derivedArtifact,
      violations: [...invalidSchema, ...invalidArtifacts],
    };
  }

  return {
    ok: true,
    inputs,
    comparedKeys: [...comparedKeys],
    evaluatedKeys,
    artifact: derivedArtifact,
    violations: [],
  };
}

export function evaluateTypeScriptOwnerContexts({
  resolutionRoot = repoRoot,
  lockfilePath = path.join(resolutionRoot, "pnpm-lock.yaml"),
  committedArtifact = loadTypeScriptOwnerContextArtifact(),
  partition = loadTypeScriptOwnerContextPartition(),
  schema = loadTypeScriptOwnerContextSchema(),
  comparedKeys = partition.semantic,
  deriveArtifact = deriveTypeScriptOwnerContexts,
} = {}) {
  const inputs = {
    resolutionRoot: path.resolve(resolutionRoot),
    lockfilePath: path.resolve(lockfilePath),
  };
  const derivedArtifact = deriveArtifact(inputs);
  return compareTypeScriptOwnerContexts(committedArtifact, derivedArtifact, {
    partition,
    schema,
    comparedKeys,
    inputs,
  });
}

export function formatTypeScriptOwnerContextDiagnostics(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
