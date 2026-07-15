import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimePath = "bounded-contexts/catalog/features/source-observations/api/runtime.ts";
const transportClientPaths = [
  "bounded-contexts/catalog/features/source-observations/api/tcgdex-client.ts",
  "bounded-contexts/catalog/features/source-observations/api/tcgplayer-automation-catalog-client.ts",
  "bounded-contexts/catalog/features/source-observations/api/tcgplayer-automation-client.ts",
];
const executableMappingImportPattern = new RegExp(
  String.raw`from ["']\.\/(tcgdex|tcgplayer|scrydex)-executable-mapping-contract["']`,
);

// Scope-first sync planning boundary: the functions that decide WHICH provider
// units participate in a Catalog sync scope by default (eligibility + default
// participation) AND the function that resolves a unit's child execution scope
// must derive their result purely from the canonical scope descriptor
// (productDomain / productForm / reference.kind / unitKey shape) and the
// accepted Provider Scope Mapping — never from a literal provider-key branch, a
// raw provider set-name / product-line-name equality check, the deleted
// `providerHints` escape hatch, or the scope reference's raw id/name (raw-name
// scope resolution is forbidden: coordinates come from accepted mappings only).
const scopePlannerPath = "bounded-contexts/catalog/features/source-observations/api/catalog-sync-scope-planner.ts";
const scopePlannerDefaultParticipationFunctionNames = [
  "unitMatchesCatalogSyncScope",
  "eligibilityBlockers",
  "unitSupportsReferenceScope",
  "childScopeForProviderUnit",
];
const providerKeyLiteralBranchPattern =
  /\.providerKey\s*(?:===|!==)\s*["'][a-z0-9-]+["']|["'][a-z0-9-]+["']\s*(?:===|!==)\s*[a-zA-Z0-9.]*\.providerKey\b/;
const rawScopeNameEqualityBranchPattern =
  /\.(?:setName|productLineName|expansionName)\s*(?:===|!==)\s*["']|["']\s*(?:===|!==)\s*[a-zA-Z0-9.]*\.(?:setName|productLineName|expansionName)\b/;

function extractFunctionSource(content, functionName) {
  const declarationPattern = new RegExp(String.raw`function\s+${functionName}\s*\(`);
  const match = declarationPattern.exec(content);
  if (!match) {
    throw new Error(`Could not locate function ${functionName} to check the scope-first sync-planning boundary.`);
  }

  const bodyStart = content.indexOf("{", match.index);
  let depth = 0;
  for (let index = bodyStart; index < content.length; index += 1) {
    if (content[index] === "{") {
      depth += 1;
    } else if (content[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(match.index, index + 1);
      }
    }
  }

  throw new Error(`Could not find the closing brace for function ${functionName}.`);
}

describe("Catalog provider mapping boundaries", () => {
  it("keeps Source Observation runtime independent from concrete provider profile constants", () => {
    const content = readFileSync(runtimePath, "utf8");

    expect(content).not.toContain("tcgdexPokemonTcgProviderProfile");
    expect(content).not.toContain("tcgplayerAutomationClientProviderProfile");
    expect(content).not.toContain("scrydexScryfallCardProviderProfile");
    expect(content).not.toMatch(executableMappingImportPattern);
  });

  it("keeps runtime import planning off concrete provider-key branches", () => {
    const content = readFileSync(runtimePath, "utf8");

    expect(content).not.toMatch(/providerProfile\.providerKey\s*(?:===|!==)\s*["'](?:tcgdex|tcgplayer)["']/);
    expect(content).not.toContain("processTcgplayerIntegrationImportJob");
    expect(content).not.toContain("previewTcgplayerIntegrationImportTargets");
    expect(content).not.toContain("previewTcgdexIntegrationImportTargets");
  });

  it("keeps the retired provider-key compatibility import entry points from returning", () => {
    const content = readFileSync(runtimePath, "utf8");

    // The `importTcgdexSet` / `importTcgplayerScope` service facets and the
    // provider-key one-set import branch (`importTcgdexSetScope`) were retired so
    // the shared profile-driven integration path is the only way to import.
    // Import must flow through the durable ...JobTurn worker, never a bespoke
    // synchronous one-shot importer.
    expect(content).not.toContain("importTcgdexSet");
    expect(content).not.toContain("importTcgplayerScope");
    expect(content).not.toMatch(/function\s+processIntegrationImportJob(?!Turn)\b/);
    expect(content).not.toMatch(/function\s+processProviderAdapterIntegrationImportJob(?!Turn)\b/);
  });

  it("keeps transport clients from owning Source Observation mapping semantics", () => {
    for (const filePath of transportClientPaths) {
      const content = readFileSync(filePath, "utf8");

      expect(content, filePath).not.toMatch(/export function to[A-Z][A-Za-z0-9]+SourceObservation/);
      expect(content, filePath).not.toContain("requireCatalogProviderSourceObservation");
      expect(content, filePath).not.toContain("requireActiveCatalogProviderSourceObservationMappingContract");
      expect(content, filePath).not.toContain("tcgdexPokemonTcgProviderProfile");
      expect(content, filePath).not.toContain("tcgplayerAutomationClientProviderProfile");
      expect(content, filePath).not.toContain("scrydexScryfallCardProviderProfile");
    }
  });
});

describe("Catalog scope-first sync-planning boundaries", () => {
  it("keeps default provider-unit participation matching off provider-key branches and raw scope-name equality", () => {
    const content = readFileSync(scopePlannerPath, "utf8");

    for (const functionName of scopePlannerDefaultParticipationFunctionNames) {
      const functionSource = extractFunctionSource(content, functionName);

      expect(functionSource, `${scopePlannerPath}:${functionName}`).not.toMatch(providerKeyLiteralBranchPattern);
      expect(functionSource, `${scopePlannerPath}:${functionName}`).not.toMatch(rawScopeNameEqualityBranchPattern);
    }
  });

  it("keeps default provider-unit participation matching off the providerHints escape hatch", () => {
    const content = readFileSync(scopePlannerPath, "utf8");

    for (const functionName of scopePlannerDefaultParticipationFunctionNames) {
      const functionSource = extractFunctionSource(content, functionName);

      expect(functionSource, `${scopePlannerPath}:${functionName}`).not.toContain("providerHints");
      expect(functionSource, `${scopePlannerPath}:${functionName}`).not.toMatch(/\bhint\??\./);
    }
  });

  it("keeps runtime import planning off provider-key branches for scope eligibility (extends the existing boundary)", () => {
    const content = readFileSync(runtimePath, "utf8");

    expect(content).not.toMatch(providerKeyLiteralBranchPattern);
  });

  it("forbids the deleted providerHints escape hatch and raw scope-reference name/id resolution anywhere in the planner", () => {
    const content = readFileSync(scopePlannerPath, "utf8");

    // providerHints is gone; provider coordinates come only from accepted
    // Provider Scope Mappings keyed by the canonical scope record id.
    expect(content).not.toContain("providerHints");
    // A sync scope reference carries only { kind, scopeRecordId } — the planner
    // must never fall back to a raw reference id/name/series coordinate.
    expect(content).not.toMatch(/\.reference\.(?:id|name|seriesId|seriesName)\b/);
  });

  it("[fixture] flags raw scope-reference name/id resolution reintroduced into the planner", () => {
    const violatingFixture = `
      function childScopeForProviderUnit(scope, version, unitKey, mapping) {
        return { setId: mapping?.setId ?? scope.reference.id ?? undefined };
      }
    `;

    expect(violatingFixture).toMatch(/\.reference\.(?:id|name|seriesId|seriesName)\b/);
  });

  it("[fixture] flags a provider-key literal branch reintroduced into scope-eligibility resolution", () => {
    const violatingFixture = `
      function unitMatchesCatalogSyncScope(version, unitKey, scope) {
        if (version.providerKey === "tcgdex") {
          return true;
        }
        return unitMatchesProductDomain(unitKey, scope.productDomain);
      }
    `;

    expect(violatingFixture).toMatch(providerKeyLiteralBranchPattern);
  });

  it("[fixture] flags a raw set-name/product-line-name equality branch reintroduced into scope-eligibility resolution", () => {
    const violatingFixture = `
      function eligibilityBlockers(version, unitKey, scope) {
        if (version.profile.setName === "Base Set") {
          return [];
        }
        return [blockedBecauseSetNameMismatch];
      }
    `;

    expect(violatingFixture).toMatch(rawScopeNameEqualityBranchPattern);
  });

  it("[fixture] flags providerHints leaking into default provider-unit participation matching", () => {
    const violatingFixture = `
      function unitMatchesCatalogSyncScope(version, unitKey, scope) {
        const hint = scope.providerHints?.find((candidate) => candidate.providerKey === version.providerKey);
        return Boolean(hint?.setId);
      }
    `;

    expect(violatingFixture).toContain("providerHints");
    expect(violatingFixture).toMatch(/\bhint\??\./);
  });

  it("keeps clean fixtures free of the forbidden patterns (proves the guard is not vacuously true)", () => {
    const cleanFixture = `
      function unitMatchesCatalogSyncScope(version, unitKey, scope) {
        return (
          unitMatchesProductDomain(unitKey, scope.productDomain) &&
          unitSupportsReferenceScope(version, scope.reference.kind)
        );
      }
    `;

    expect(cleanFixture).not.toMatch(providerKeyLiteralBranchPattern);
    expect(cleanFixture).not.toMatch(rawScopeNameEqualityBranchPattern);
    expect(cleanFixture).not.toContain("providerHints");
  });
});
