import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", "artifacts"]);
const factoryNamePattern = /^create[A-Z][A-Za-z0-9]*RequestApiClient$/;
const authContextName = "auth";
const waveOneListenedSourceContexts = new Set(["checkout", "marketplace", "ordering", "payments"]);
const supportedClassifications = new Set([
  "composite-projection-servable",
  "read-your-writes",
  "genuinely-synchronous",
]);
const supportedWakePostures = new Set(["wave-1-listened", "poll-only"]);
const commandMethodPrefixes = [
  "accept",
  "add",
  "approve",
  "archive",
  "cancel",
  "claim",
  "clear",
  "complete",
  "create",
  "decline",
  "delete",
  "ensure",
  "generate",
  "mark",
  "open",
  "prepare",
  "publish",
  "recover",
  "refresh",
  "report",
  "reject",
  "remove",
  "request",
  "retry",
  "revoke",
  "set",
  "start",
  "submit",
  "sync",
  "update",
];

function normalizeRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTestFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relativeFile)
  );
}

function isRouteReadScanTarget(relativeFile) {
  return (
    /^bounded-contexts\/[^/]+\/routes\//.test(relativeFile) ||
    /^bounded-contexts\/[^/]+\/support\/route-support\//.test(relativeFile)
  );
}

function contextRootForFile(relativeFile) {
  const match = relativeFile.match(/^bounded-contexts\/[^/]+/);
  return match?.[0] ?? null;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function walkSourceFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function contextsByPackageName(contextManifests) {
  return new Map([...contextManifests.values()].map((context) => [context.packageName, context]));
}

function ownerContextForSpecifier(specifier, contextsByPackage) {
  for (const [packageName, context] of contextsByPackage.entries()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return context.manifest.contextName;
    }
  }
  return null;
}

function parseNamedImportEntries(importList) {
  return importList
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const withoutType = entry.replace(/^type\s+/, "").trim();
      const aliasMatch = withoutType.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        return { importedName: aliasMatch[1], localName: aliasMatch[2] };
      }
      const nameMatch = withoutType.match(/^([A-Za-z_$][\w$]*)$/);
      return nameMatch ? { importedName: nameMatch[1], localName: nameMatch[1] } : null;
    })
    .filter(Boolean);
}

function collectImportedRequestClientFactories({ content, currentContextName, contextsByPackage }) {
  const factories = new Map();
  const importPattern = /import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;

  for (const match of content.matchAll(importPattern)) {
    const isTypeOnlyImport = Boolean(match[1]);
    if (isTypeOnlyImport) {
      continue;
    }

    const [, , importList, specifier] = match;
    const ownerContextName = ownerContextForSpecifier(specifier, contextsByPackage);
    if (!ownerContextName || ownerContextName === authContextName || ownerContextName === currentContextName) {
      continue;
    }

    for (const entry of parseNamedImportEntries(importList)) {
      if (!factoryNamePattern.test(entry.importedName)) {
        continue;
      }

      factories.set(entry.localName, {
        factoryName: entry.localName,
        importedName: entry.importedName,
        sourceContextName: ownerContextName,
        importSpecifier: specifier,
      });
    }
  }

  return factories;
}

function findMatchingCloseParen(content, openParenIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openParenIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function parseOptionalTypeArguments(content, index) {
  let cursor = index;
  while (/\s/.test(content[cursor] ?? "")) {
    cursor += 1;
  }

  if (content[cursor] !== "<") {
    return cursor;
  }

  let depth = 0;
  for (let position = cursor; position < content.length; position += 1) {
    const char = content[position];
    if (char === "<") {
      depth += 1;
    } else if (char === ">") {
      depth -= 1;
      if (depth === 0) {
        return position + 1;
      }
    }
  }

  return cursor;
}

function methodCallAfterMember(content, index) {
  let cursor = parseOptionalTypeArguments(content, index);
  while (/\s/.test(content[cursor] ?? "")) {
    cursor += 1;
  }
  return content[cursor] === "(";
}

function collectClientVariables({ content, factoryName }) {
  const variables = [];
  const declarationPattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?${escapeRegExp(factoryName)}\\s*\\(`,
    "g",
  );

  for (const match of content.matchAll(declarationPattern)) {
    variables.push({
      variableName: match[1],
      index: match.index ?? 0,
    });
  }

  return variables;
}

function collectVariableMethodCalls({ content, variableName }) {
  const calls = [];
  const methodPattern = new RegExp(`\\b${escapeRegExp(variableName)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");

  for (const match of content.matchAll(methodPattern)) {
    const methodName = match[1];
    const afterMethodIndex = (match.index ?? 0) + match[0].length;
    if (!methodCallAfterMember(content, afterMethodIndex)) {
      continue;
    }
    calls.push({
      methodName,
      index: match.index ?? 0,
    });
  }

  return calls;
}

function collectDirectFactoryMethodCalls({ content, factoryName }) {
  const calls = [];
  const factoryPattern = new RegExp(`\\b${escapeRegExp(factoryName)}\\s*\\(`, "g");

  for (const match of content.matchAll(factoryPattern)) {
    const openParenIndex = content.indexOf("(", match.index);
    const closeParenIndex = findMatchingCloseParen(content, openParenIndex);
    if (closeParenIndex === -1) {
      continue;
    }

    const memberMatch = content.slice(closeParenIndex + 1).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (!memberMatch) {
      continue;
    }

    const methodName = memberMatch[1];
    const afterMethodIndex = closeParenIndex + 1 + memberMatch[0].length;
    if (!methodCallAfterMember(content, afterMethodIndex)) {
      continue;
    }

    calls.push({
      methodName,
      index: match.index ?? 0,
    });
  }

  return calls;
}

function isCommandMethodName(methodName) {
  const normalized = methodName.trim();
  return commandMethodPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function buildReadCallId(call, occurrence) {
  return `${call.file}:${call.sourceContextName}:${call.clientFactory}.${call.methodName}#${occurrence}`;
}

function withStableIds(calls) {
  const occurrenceCounts = new Map();
  return calls
    .sort((left, right) => {
      const fileCompare = left.file.localeCompare(right.file);
      if (fileCompare !== 0) {
        return fileCompare;
      }
      return left.line - right.line || left.sourceContextName.localeCompare(right.sourceContextName);
    })
    .map((call) => {
      const occurrenceKey = `${call.file}:${call.sourceContextName}:${call.clientFactory}:${call.methodName}`;
      const occurrence = (occurrenceCounts.get(occurrenceKey) ?? 0) + 1;
      occurrenceCounts.set(occurrenceKey, occurrence);
      return {
        ...call,
        occurrence,
        id: buildReadCallId(call, occurrence),
      };
    });
}

export async function collectCrossContextRequestPathReadCalls(options) {
  const { repoRoot, contextManifests } = options;
  const contextsByPackage = contextsByPackageName(contextManifests);
  const boundedContextRoot = path.join(repoRoot, "bounded-contexts");
  const files = existsSync(boundedContextRoot) ? await walkSourceFiles(boundedContextRoot) : [];
  const calls = [];

  for (const filePath of files) {
    const relativeFile = normalizeRelative(filePath, repoRoot);
    if (!isRouteReadScanTarget(relativeFile) || isTestFile(relativeFile)) {
      continue;
    }

    const contextRoot = contextRootForFile(relativeFile);
    const context = contextRoot ? contextManifests.get(contextRoot) : null;
    const currentContextName = context?.manifest.contextName;
    if (!currentContextName) {
      continue;
    }

    const content = readFileSync(filePath, "utf8");
    if (!content.includes("RequestApiClient")) {
      continue;
    }

    const factories = collectImportedRequestClientFactories({
      content,
      currentContextName,
      contextsByPackage,
    });

    for (const factory of factories.values()) {
      const methodCalls = [
        ...collectDirectFactoryMethodCalls({ content, factoryName: factory.factoryName }),
        ...collectClientVariables({ content, factoryName: factory.factoryName }).flatMap(({ variableName }) =>
          collectVariableMethodCalls({ content, variableName }),
        ),
      ];

      const uniqueMethodCalls = new Map();
      for (const methodCall of methodCalls) {
        if (isCommandMethodName(methodCall.methodName)) {
          continue;
        }

        const key = `${methodCall.index}:${methodCall.methodName}`;
        uniqueMethodCalls.set(key, methodCall);
      }

      for (const methodCall of uniqueMethodCalls.values()) {
        calls.push({
          consumerContextName: currentContextName,
          sourceContextName: factory.sourceContextName,
          file: relativeFile,
          line: lineNumberAt(content, methodCall.index),
          clientFactory: factory.importedName,
          localClientFactory: factory.factoryName,
          methodName: methodCall.methodName,
          importSpecifier: factory.importSpecifier,
        });
      }
    }
  }

  return withStableIds(calls);
}

function baselineWakePostureForSource(sourceContextName) {
  return waveOneListenedSourceContexts.has(sourceContextName) ? "wave-1-listened" : "poll-only";
}

function readBaseline(repoRoot, baselinePath) {
  const absolutePath = path.resolve(repoRoot, baselinePath);
  if (!existsSync(absolutePath)) {
    return {
      issue: "#2775",
      owner: "bounded context owners",
      reviewBy: "2026-07-31",
      entries: [],
    };
  }
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}

function validateBaselineEntry(entry, index, violations) {
  const label = `scripts/check-structure/cross-context-read-baseline.json entries[${index}]`;
  if (!isPlainObject(entry)) {
    violations.push(`${label}: entry must be an object`);
    return;
  }

  for (const field of [
    "id",
    "consumerContextName",
    "sourceContextName",
    "file",
    "clientFactory",
    "methodName",
    "classification",
    "sourceWakePosture",
    "issue",
    "migration",
  ]) {
    if (!isNonEmptyString(entry[field])) {
      violations.push(`${label}: ${field} must be a non-empty string`);
    }
  }

  if (!Number.isInteger(entry.line) || entry.line < 1) {
    violations.push(`${label}: line must be a positive integer`);
  }

  if (isNonEmptyString(entry.classification) && !supportedClassifications.has(entry.classification)) {
    violations.push(`${label}: classification must be one of ${[...supportedClassifications].sort().join(", ")}`);
  }

  if (isNonEmptyString(entry.sourceWakePosture) && !supportedWakePostures.has(entry.sourceWakePosture)) {
    violations.push(`${label}: sourceWakePosture must be one of ${[...supportedWakePostures].sort().join(", ")}`);
  }

  if (entry.classification === "genuinely-synchronous" && !isNonEmptyString(entry.justification)) {
    violations.push(`${label}: genuinely-synchronous entries require justification`);
  }

  if (entry.classification === "composite-projection-servable" && !/^#\d+/.test(entry.issue ?? "")) {
    violations.push(`${label}: composite-projection-servable entries must link the migration slice issue`);
  }
}

function validateBaselineShape(baseline, violations) {
  if (!isPlainObject(baseline)) {
    violations.push("scripts/check-structure/cross-context-read-baseline.json: baseline must be an object");
    return [];
  }

  if (!isStringArray(baseline.classificationGuide ?? [])) {
    violations.push(
      "scripts/check-structure/cross-context-read-baseline.json: classificationGuide must be an array of strings",
    );
  }

  if (!Array.isArray(baseline.entries)) {
    violations.push("scripts/check-structure/cross-context-read-baseline.json: entries must be an array");
    return [];
  }

  const seenIds = new Set();
  for (const [index, entry] of baseline.entries.entries()) {
    validateBaselineEntry(entry, index, violations);
    if (isPlainObject(entry) && isNonEmptyString(entry.id)) {
      if (seenIds.has(entry.id)) {
        violations.push(`scripts/check-structure/cross-context-read-baseline.json: duplicate entry id '${entry.id}'`);
      }
      seenIds.add(entry.id);
    }
  }

  return baseline.entries.filter(isPlainObject);
}

function currentCallLabel(call) {
  return `${call.file}:${call.line} ${call.consumerContextName} -> ${call.sourceContextName} ${call.clientFactory}.${call.methodName}`;
}

function missingBaselineMessage(call) {
  return (
    `${currentCallLabel(call)} is a net-new foreign request-path read-client call. ` +
    "Use a view-owned composite projection like bounded-contexts/checkout/features/cart/integrations/*, " +
    "then classify/ratchet scripts/check-structure/cross-context-read-baseline.json and the generated artifacts/cross-context-read-inventory.json. " +
    "See docs/architecture/cross-context-request-path-read-inventory.md, #2774, and #2776."
  );
}

function staleBaselineMessage(entry) {
  return (
    `scripts/check-structure/cross-context-read-baseline.json: stale cross-context read baseline entry '${entry.id}' ` +
    `(${entry.file}:${entry.line} ${entry.clientFactory}.${entry.methodName}) was not discovered; remove it as the migration ratchets down.`
  );
}

function writeInventoryArtifact({ repoRoot, outputPath, baseline, calls, baselineById }) {
  const absoluteOutputPath = path.resolve(repoRoot, outputPath);
  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });

  const entries = calls.map((call) => {
    const baselineEntry = baselineById.get(call.id);
    return {
      ...call,
      classification: baselineEntry?.classification ?? "unclassified-new-read",
      migration:
        baselineEntry?.migration ?? "Classify this row in scripts/check-structure/cross-context-read-baseline.json.",
      issue: baselineEntry?.issue ?? "#2776",
      sourceWakePosture: baselineEntry?.sourceWakePosture ?? baselineWakePostureForSource(call.sourceContextName),
      justification: baselineEntry?.justification,
    };
  });

  const artifact = {
    generatedAt: new Date().toISOString(),
    issue: "#2776",
    sourceBaseline: "scripts/check-structure/cross-context-read-baseline.json",
    targetPattern: "bounded-contexts/checkout/features/cart/integrations/*",
    classificationGuide: baseline.classificationGuide ?? [],
    entries,
  };

  writeFileSync(absoluteOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function validateCrossContextReadInventory(options) {
  const {
    repoRoot,
    contextManifests,
    baselinePath = "scripts/check-structure/cross-context-read-baseline.json",
    artifactOutputPath = "artifacts/cross-context-read-inventory.json",
    failOnNewReads = process.env.CI === "true",
  } = options;
  const violations = [];
  const warnings = [];
  const calls = await collectCrossContextRequestPathReadCalls({ repoRoot, contextManifests });
  const baseline = readBaseline(repoRoot, baselinePath);
  const baselineEntries = validateBaselineShape(baseline, violations);
  const baselineById = new Map(baselineEntries.map((entry) => [entry.id, entry]));
  const callsById = new Map(calls.map((call) => [call.id, call]));

  for (const entry of baselineEntries) {
    const currentCall = callsById.get(entry.id);
    if (!currentCall) {
      violations.push(staleBaselineMessage(entry));
      continue;
    }

    for (const field of ["consumerContextName", "sourceContextName", "file", "clientFactory", "methodName"]) {
      if (entry[field] !== currentCall[field]) {
        violations.push(
          `scripts/check-structure/cross-context-read-baseline.json: entry '${entry.id}' ${field} is '${entry[field]}' but scanner found '${currentCall[field]}'`,
        );
      }
    }

    const expectedWakePosture = baselineWakePostureForSource(currentCall.sourceContextName);
    if (entry.sourceWakePosture !== expectedWakePosture) {
      violations.push(
        `scripts/check-structure/cross-context-read-baseline.json: entry '${entry.id}' sourceWakePosture must be '${expectedWakePosture}' for ${currentCall.sourceContextName}`,
      );
    }
  }

  for (const call of calls) {
    if (baselineById.has(call.id)) {
      continue;
    }

    const message = missingBaselineMessage(call);
    if (failOnNewReads) {
      violations.push(message);
    } else {
      warnings.push(message);
    }
  }

  writeInventoryArtifact({
    repoRoot,
    outputPath: artifactOutputPath,
    baseline,
    calls,
    baselineById,
  });

  return {
    ok: violations.length === 0,
    calls,
    baselineEntries,
    violations,
    warnings,
  };
}
