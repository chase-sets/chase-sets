import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const allowedFallbackCategories = new Set([
  "host-owned bridge",
  "same-actor post-write recovery",
  "synchronous projection",
]);

const fallbackCategoryList = [...allowedFallbackCategories].join(", ");

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

function contextsByName(contextManifests) {
  const contexts = new Map();
  for (const context of contextManifests.values()) {
    if (isNonEmptyString(context.manifest.contextName)) {
      contexts.set(context.manifest.contextName, context);
    }
  }
  return contexts;
}

function sourceGuardValue(entry) {
  if (isNonEmptyString(entry.sourceGuard)) {
    return entry.sourceGuard;
  }
  if (isNonEmptyString(entry.catalogSourceGuard)) {
    return entry.catalogSourceGuard;
  }
  return "";
}

function validateRequiredString({ entry, entryLabel, fieldName, violations }) {
  if (!isNonEmptyString(entry[fieldName])) {
    violations.push(`${entryLabel}: ${fieldName} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateImplementation({ entry, entryLabel, violations }) {
  if (!isPlainObject(entry.implementation)) {
    violations.push(`${entryLabel}: implementation must be an object`);
    return;
  }

  if (!isNonEmptyString(entry.implementation.consumer)) {
    violations.push(`${entryLabel}: implementation.consumer must be a non-empty string`);
  }

  if (entry.category !== "host-owned bridge") {
    return;
  }

  if (!isNonEmptyStringArray(entry.implementation.hostBridges)) {
    violations.push(`${entryLabel}: host-owned bridge requires implementation.hostBridges`);
  }
  if (!isNonEmptyString(entry.implementation.providerSurface)) {
    violations.push(`${entryLabel}: host-owned bridge requires implementation.providerSurface`);
  }
}

function validateProof({ entry, entryLabel, violations }) {
  if (!isPlainObject(entry.proof)) {
    violations.push(`${entryLabel}: proof must be an object`);
    return;
  }

  if (!isNonEmptyStringArray(entry.proof.tests)) {
    violations.push(`${entryLabel}: proof.tests must list at least one test file`);
  }

  if ("testCases" in entry.proof && !isStringArray(entry.proof.testCases)) {
    violations.push(`${entryLabel}: proof.testCases must be an array of strings when provided`);
  }
}

function validateProjectionWaitedOn({ entry, entryLabel, targetContext, violations }) {
  if (!isPlainObject(entry.projectionWaitedOn)) {
    violations.push(`${entryLabel}: projectionWaitedOn must be an object`);
    return;
  }

  const projection = entry.projectionWaitedOn;
  const hasProjectionName = validateRequiredString({
    entry: projection,
    entryLabel: `${entryLabel} projectionWaitedOn`,
    fieldName: "projectionName",
    violations,
  });
  const hasReadModelTable = validateRequiredString({
    entry: projection,
    entryLabel: `${entryLabel} projectionWaitedOn`,
    fieldName: "readModelTable",
    violations,
  });
  const hasSourceContextName = validateRequiredString({
    entry: projection,
    entryLabel: `${entryLabel} projectionWaitedOn`,
    fieldName: "sourceContextName",
    violations,
  });

  if (
    hasSourceContextName &&
    isNonEmptyString(entry.sourceContextName) &&
    projection.sourceContextName !== entry.sourceContextName
  ) {
    violations.push(`${entryLabel}: projectionWaitedOn.sourceContextName must match sourceContextName`);
  }

  if (!targetContext || !hasProjectionName) {
    return;
  }

  const projectionGroup = (targetContext.manifest.projectionGroups ?? []).find(
    (group) => group.projectionName === projection.projectionName,
  );

  if (!projectionGroup) {
    violations.push(
      `${entryLabel}: projectionWaitedOn.projectionName '${projection.projectionName}' is not declared by target context projectionGroups`,
    );
    return;
  }

  if (hasSourceContextName && !(projectionGroup.sourceContextNames ?? []).includes(projection.sourceContextName)) {
    violations.push(
      `${entryLabel}: projectionWaitedOn.sourceContextName '${projection.sourceContextName}' is not declared by projection group '${projection.projectionName}'`,
    );
  }

  if (hasReadModelTable && !(projectionGroup.ownedTables ?? []).includes(projection.readModelTable)) {
    violations.push(
      `${entryLabel}: projectionWaitedOn.readModelTable '${projection.readModelTable}' is not owned by projection group '${projection.projectionName}'`,
    );
  }
}

function validateFallbackEntry({ context, entry, index, contextNames, entryIds, reportEntries, violations }) {
  const entryLabel = `${context.root}/context.json crossContextFallbackInventory[${index}]`;
  if (!isPlainObject(entry)) {
    violations.push(`${entryLabel}: inventory entry must be an object`);
    return;
  }

  const hasId = validateRequiredString({ entry, entryLabel, fieldName: "id", violations });
  validateRequiredString({ entry, entryLabel, fieldName: "owner", violations });
  const hasCategory = validateRequiredString({ entry, entryLabel, fieldName: "category", violations });
  const hasSourceContextName = validateRequiredString({
    entry,
    entryLabel,
    fieldName: "sourceContextName",
    violations,
  });
  const hasTargetContextName = validateRequiredString({
    entry,
    entryLabel,
    fieldName: "targetContextName",
    violations,
  });
  validateRequiredString({ entry, entryLabel, fieldName: "actorOwnershipGuard", violations });
  validateRequiredString({ entry, entryLabel, fieldName: "freshnessScope", violations });
  validateRequiredString({ entry, entryLabel, fieldName: "terminationRule", violations });
  validateRequiredString({ entry, entryLabel, fieldName: "observability", violations });

  if (!sourceGuardValue(entry)) {
    violations.push(`${entryLabel}: sourceGuard or catalogSourceGuard must be a non-empty string`);
  }

  if (hasId) {
    if (entryIds.has(entry.id)) {
      violations.push(`${entryLabel}: id '${entry.id}' must be unique`);
    }
    entryIds.add(entry.id);
  }

  if (hasCategory && !allowedFallbackCategories.has(entry.category)) {
    violations.push(
      `${entryLabel}: category '${entry.category}' is unsupported; expected one of ${fallbackCategoryList}`,
    );
  }

  if (hasSourceContextName && !contextNames.has(entry.sourceContextName)) {
    violations.push(`${entryLabel}: sourceContextName '${entry.sourceContextName}' does not match a bounded context`);
  }

  const targetContext = hasTargetContextName ? contextNames.get(entry.targetContextName) : null;
  if (hasTargetContextName && !targetContext) {
    violations.push(`${entryLabel}: targetContextName '${entry.targetContextName}' does not match a bounded context`);
  }

  if (
    hasTargetContextName &&
    isNonEmptyString(context.manifest.contextName) &&
    entry.targetContextName !== context.manifest.contextName
  ) {
    violations.push(`${entryLabel}: targetContextName must match owning context '${context.manifest.contextName}'`);
  }

  if (isNonEmptyString(entry.owner) && hasTargetContextName && entry.owner !== entry.targetContextName) {
    violations.push(`${entryLabel}: owner must match targetContextName '${entry.targetContextName}'`);
  }

  if (hasSourceContextName && hasTargetContextName && entry.sourceContextName === entry.targetContextName) {
    violations.push(`${entryLabel}: sourceContextName and targetContextName must be different contexts`);
  }

  validateImplementation({ entry, entryLabel, violations });
  validateProof({ entry, entryLabel, violations });
  validateProjectionWaitedOn({ entry, entryLabel, targetContext, violations });

  reportEntries.push({
    contextName: context.manifest.contextName ?? "(missing context)",
    id: entry.id ?? "(missing id)",
    owner: entry.owner ?? "(missing owner)",
    category: entry.category ?? "(missing category)",
    sourceContextName: entry.sourceContextName ?? "(missing source)",
    targetContextName: entry.targetContextName ?? "(missing target)",
    projectionName: entry.projectionWaitedOn?.projectionName ?? "(missing projection)",
    readModelTable: entry.projectionWaitedOn?.readModelTable ?? "(missing table)",
    sourceGuard: sourceGuardValue(entry) || "(missing source guard)",
    terminationRule: entry.terminationRule ?? "(missing termination rule)",
    observability: entry.observability ?? "(missing observability)",
  });
}

export function validateCrossContextFallbackInventory(options) {
  const { repoRoot, contextManifests, reportOutputPath = "artifacts/cross-context-fallback-inventory.md" } = options;
  const contextNames = contextsByName(contextManifests);
  const violations = [];
  const warnings = [];
  const reportEntries = [];
  const entryIds = new Set();

  for (const context of contextManifests.values()) {
    const inventory = context.manifest.crossContextFallbackInventory;
    if (inventory === undefined) {
      continue;
    }

    if (!Array.isArray(inventory)) {
      violations.push(`${context.root}/context.json: crossContextFallbackInventory must be an array when provided`);
      continue;
    }

    for (const [index, entry] of inventory.entries()) {
      validateFallbackEntry({
        context,
        entry,
        index,
        contextNames,
        entryIds,
        reportEntries,
        violations,
      });
    }
  }

  writeCrossContextFallbackInventoryReport({
    repoRoot,
    outputPath: reportOutputPath,
    entries: reportEntries,
    violations,
    warnings,
  });

  return {
    ok: violations.length === 0,
    reportEntries: reportEntries.sort((left, right) => left.id.localeCompare(right.id)),
    violations,
    warnings,
  };
}

export function writeCrossContextFallbackInventoryReport(options) {
  const { repoRoot, outputPath, entries, violations, warnings } = options;
  const absoluteOutputPath = path.resolve(repoRoot, outputPath);
  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });

  const lines = [
    "# Cross-Context Fallback Inventory",
    "",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "| Context | Inventory ID | Category | Owner | Source | Target | Projection waited on | Read model table | Source guard | Termination | Observability |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const entry of entries.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(
      `| ${markdownCell(entry.contextName)} | ${markdownCell(entry.id)} | ${markdownCell(entry.category)} | ${markdownCell(entry.owner)} | ${markdownCell(entry.sourceContextName)} | ${markdownCell(entry.targetContextName)} | ${markdownCell(entry.projectionName)} | ${markdownCell(entry.readModelTable)} | ${markdownCell(entry.sourceGuard)} | ${markdownCell(entry.terminationRule)} | ${markdownCell(entry.observability)} |`,
    );
  }

  lines.push("", "## Validation", "");
  if (violations.length === 0 && warnings.length === 0) {
    lines.push("- Passed with no violations or warnings.");
  } else {
    for (const violation of violations) {
      lines.push(`- Violation: ${violation}`);
    }
    for (const warning of warnings) {
      lines.push(`- Warning: ${warning}`);
    }
  }

  writeFileSync(absoluteOutputPath, `${lines.join("\n")}\n`, "utf8");
}
