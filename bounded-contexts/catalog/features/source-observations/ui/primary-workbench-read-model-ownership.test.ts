import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every member the #8320 audit inventoried in primary-workbench-read-model-composition.ts,
// keyed by the behavior owner that declares it now. The composition module keeps
// only the per-surface slice choice and the model assembly; everything else lives
// with the owner of that derivation, and no owner keeps a copy of another's body.
const ownerByMember = {
  "primary-workbench-read-model-composition.ts": [
    "buildCatalogPrimaryWorkbenchReadModelForSurface",
    "buildCatalogPrimaryWorkbenchDeferredSourceOptions",
    "emptyControlPlaneInput",
    "emptyProviderSliceInput",
    "emptyProviderSliceDerived",
    "assembleReadModel",
  ],
  "primary-workbench-route-selection.ts": [
    "inferProviderKey",
    "inferUnitKey",
    "normalizeSelectedUnitKey",
    "providerOnlyScopeContext",
    "selectedProviderScopeRows",
    "structuredSelectionImportScope",
    "structuredScopeWithProfileLanguage",
    "providerScopeLanguageForStructuredSet",
    "legacyImportScopeConflictsWithSelectedProvider",
    "legacyImportScopeConflictsWithSelectedProviderScope",
    "sourceObservationScopeProductLineConflictsWithUnit",
    "productDomainFromIntegrationUnitKey",
    "productDomainFromIntegrationScope",
    "tcgplayerProductLineDomain",
    "productDomainFromProductLineName",
    "productDomainFromProductLineId",
    "normalizeDomainSegment",
    "sourceOptionProfileCannotSelectScope",
    "sanitizeScopeForSourceOptionProfile",
    "sourceObservationFiltersForRouteContext",
    "inferImportScope",
    "findActiveProfile",
    "providerHasMultipleActiveProfileUnits",
    "findSelectedProfile",
    "profileMatchesUnit",
    "uniqueProfileUnitKeys",
  ],
  "primary-workbench-route-context.ts": [
    "requestHasStructuredImportScopeSelection",
    "requestHasExplicitLanguageScopeSelection",
    "requestHasSourceOptionIntent",
  ],
  "primary-workbench-scope-context.ts": [
    "importScopeMatchesStructuredSelection",
    "normalizedScopeSegment",
    "providerScopeMatchesStructuredSet",
    "optionalScopeSegmentMatches",
    "pairedScopeSegmentMatches",
  ],
  "primary-workbench-provider-scope.ts": [
    "providerScopeProviders",
    "uniqueProfilesByUnit",
    "integrationUnitShape",
    "providerDisplayName",
    "providerBaseDisplayName",
    "providerReadinessHasImportUnit",
    "providerImportScopes",
    "providerScopeValue",
  ],
  "primary-workbench-core-read-model.ts": [
    "CatalogPrimaryWorkbenchCore",
    "CatalogPrimaryWorkbenchDerived",
    "buildCatalogPrimaryWorkbenchCore",
    "readinessBlockersFor",
    "promotionResultFromOutcome",
    "uniqueStrings",
  ],
  "primary-workbench-surface-actions.ts": [
    "buildSurfaceActions",
    "buildActions",
    "importBlockersForSelectedScope",
    "isProviderScopeBlocker",
    "lifecycleAction",
    "actionStateForBlockers",
    "reviewReadModelBlockersFor",
    "mergeCandidateCommandBlockersFor",
    "isReviewReadModelBlocker",
  ],
  "primary-workbench-surface-slices.ts": [
    "providersSurfaceSlices",
    "conflictAndLifecycleSlices",
    "governanceControlsSlice",
    "healthTriageSlice",
    "healthSurfaceSlices",
  ],
} as const satisfies Record<string, readonly string[]>;

type OwnerFile = keyof typeof ownerByMember;

const ownerFiles = Object.keys(ownerByMember) as OwnerFile[];

// The derivation layers, lowest first. A module may import only from layers
// below it, so selection never reaches into actions and nothing reaches back
// into the composition root.
const derivationLayers: readonly (readonly OwnerFile[])[] = [
  ["primary-workbench-route-context.ts", "primary-workbench-scope-context.ts"],
  ["primary-workbench-route-selection.ts"],
  ["primary-workbench-provider-scope.ts"],
  ["primary-workbench-core-read-model.ts"],
  ["primary-workbench-surface-actions.ts", "primary-workbench-surface-slices.ts"],
  ["primary-workbench-read-model-composition.ts"],
];

const compositionLocalImports = [
  "../api/primary-workbench-admin-contracts",
  "./admin-control-plane/information-architecture",
  "./primary-workbench-core-read-model",
  "./primary-workbench-read-model-input",
  "./primary-workbench-surface-actions",
  "./primary-workbench-surface-slices",
];

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

function topLevelDeclarations(file: string): readonly string[] {
  return [...source(file).matchAll(/^(?:export )?(?:function|type) (\w+)/gm)].map((match) => match[1]!);
}

function localImports(file: string): readonly string[] {
  return [...source(file).matchAll(/^import [^;]*? from "(\.{1,2}\/[^"]+)";/gms)].map((match) => match[1]!);
}

describe("Catalog primary workbench read-model ownership", () => {
  it("workbench derivation ownership is complete", () => {
    const members = Object.values(ownerByMember).flat();
    // The audited module held 66 functions and the 2 core types at dispatch.
    expect(members).toHaveLength(68);
    expect(new Set(members).size).toBe(members.length);

    const declarationsByFile = new Map(ownerFiles.map((file) => [file, topLevelDeclarations(file)]));
    for (const file of ownerFiles) {
      const declarations = declarationsByFile.get(file)!;
      for (const member of ownerByMember[file]) {
        expect(
          declarations.filter((declaration) => declaration === member),
          `${member} declared once in ${file}`,
        ).toHaveLength(1);
      }
      for (const otherFile of ownerFiles.filter((candidate) => candidate !== file)) {
        const copies = ownerByMember[otherFile].filter((member) => declarations.includes(member));
        expect(copies, `${file} keeps no body owned by ${otherFile}`).toEqual([]);
      }
    }

    // The composition root only chooses slices and assembles the model.
    expect(declarationsByFile.get("primary-workbench-read-model-composition.ts")).toEqual(
      ownerByMember["primary-workbench-read-model-composition.ts"],
    );
    expect([...localImports("primary-workbench-read-model-composition.ts")].sort()).toEqual(compositionLocalImports);

    derivationLayers.forEach((layer, index) => {
      const higherLayers = derivationLayers.slice(index + 1).flat();
      for (const file of layer) {
        const imported = localImports(file).map((specifier) => `${specifier.replace(/^\.\//, "")}.ts`);
        const upward = higherLayers.filter((higher) => imported.includes(higher));
        expect(upward, `${file} imports only lower derivation layers`).toEqual([]);
      }
    });
  });
});
