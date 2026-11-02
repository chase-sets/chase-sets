import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import {
  defineCatalogIntegrationUnitKey,
  parseCatalogIntegrationUnitKey,
  type CatalogIntegrationUnitKey,
} from "../api/integration-unit";
import type {
  CatalogIntegrationControlPlaneUnitReadiness,
  CatalogIntegrationProviderReadiness,
  CatalogProviderProfileVersionReview,
  SourceObservationIntegrationScope,
} from "./contracts";
import type { CatalogPrimaryWorkbenchInput } from "./primary-workbench-read-model-input";
import { comparableImportScopeKey, profilePointerForProfile } from "./primary-workbench-read-model-support";
import { findActiveProfile, inferUnitKey } from "./primary-workbench-route-selection";

// The provider and unit picker every surface renders: each provider the scopes,
// profiles or importable readiness units mention, with its units, their import
// scopes and the profile each unit points at.
export function providerScopeProviders(
  input: CatalogPrimaryWorkbenchInput,
  selectedProviderKey: string | null,
  selectedProfile: CatalogProviderProfileVersionReview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"] {
  const providerKeys = new Set<string>();
  for (const scope of input.scopes.items) {
    providerKeys.add(scope.provider_key);
  }
  for (const profile of input.profileReviews.items) {
    providerKeys.add(profile.providerKey);
  }
  for (const provider of input.controlPlaneOverview?.providerReadiness.providers ?? []) {
    if (providerReadinessHasImportUnit(provider, input.controlPlaneOverview?.readiness.units ?? [])) {
      providerKeys.add(provider.providerKey);
    }
  }
  if (selectedProviderKey) {
    providerKeys.add(selectedProviderKey);
  }

  return [...providerKeys].sort().map((providerKey) => {
    const providerProfiles = input.profileReviews.items.filter((profile) => profile.providerKey === providerKey);
    const profile =
      providerKey === selectedProviderKey ? selectedProfile : findActiveProfile(providerProfiles, providerKey);
    const providerScopes = input.scopes.items.filter((scope) => scope.provider_key === providerKey);
    const providerReadiness = input.controlPlaneOverview?.providerReadiness.providers.find(
      (provider) => provider.providerKey === providerKey,
    );
    const readinessUnits = (
      input.controlPlaneOverview?.readiness.units.filter(
        (unit) =>
          unit.providerKey === providerKey &&
          (!providerReadiness ||
            providerReadiness.unitKeys.length === 0 ||
            providerReadiness.unitKeys.includes(unit.unitKey)),
      ) ?? []
    ).filter((unit) => unit.ingestionPurpose !== "source-observation-proof");
    const visibleProfiles = uniqueProfilesByUnit([...providerProfiles, ...(profile ? [profile] : [])]);
    const unitsByKey = new Map<
      string,
      CatalogPrimaryWorkbenchReadModel["providerScope"]["providers"][number]["units"][number]
    >();

    for (const unitProfile of visibleProfiles) {
      const unitKey = unitProfile.ingestionUnitKey as CatalogIntegrationUnitKey;
      const readinessUnit = readinessUnits.find((unit) => unit.unitKey === unitKey) ?? null;
      const unitShape = integrationUnitShape(unitKey, unitProfile, readinessUnit);
      unitsByKey.set(unitKey, {
        unitKey,
        productDomain: unitShape.productDomain,
        productForm: unitShape.productForm,
        importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
        activeProfile: profilePointerForProfile(unitProfile),
      });
    }

    for (const readinessUnit of readinessUnits) {
      if (!unitsByKey.has(readinessUnit.unitKey)) {
        unitsByKey.set(readinessUnit.unitKey, {
          unitKey: readinessUnit.unitKey,
          productDomain: readinessUnit.productDomain,
          productForm: readinessUnit.productForm,
          importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
          activeProfile: profilePointerForProfile(
            visibleProfiles.find((candidate) => candidate.ingestionUnitKey === readinessUnit.unitKey) ?? null,
          ),
        });
      }
    }

    if (unitsByKey.size === 0) {
      const unitKey =
        inferUnitKey(input, providerKey, profile) ??
        defineCatalogIntegrationUnitKey({
          providerKey,
          productDomain: "catalog",
          productForm: "source-observation",
          ingestionPurpose: "import",
        });
      const unitShape = integrationUnitShape(unitKey, profile, null);
      unitsByKey.set(unitKey, {
        unitKey,
        productDomain: unitShape.productDomain,
        productForm: unitShape.productForm,
        importScopes: providerImportScopes(providerScopes, routeContext.importScope, providerKey),
        activeProfile: profilePointerForProfile(profile),
      });
    }

    return {
      providerKey,
      displayName: providerDisplayName(providerKey, providerProfiles, profile, readinessUnits),
      units: [...unitsByKey.values()].sort((left, right) => left.unitKey.localeCompare(right.unitKey)),
    };
  });
}

function uniqueProfilesByUnit(
  profiles: readonly CatalogProviderProfileVersionReview[],
): readonly CatalogProviderProfileVersionReview[] {
  const byUnit = new Map<string, CatalogProviderProfileVersionReview>();
  for (const profile of profiles) {
    byUnit.set(profile.ingestionUnitKey, profile);
  }

  return [...byUnit.values()];
}

function integrationUnitShape(
  unitKey: CatalogIntegrationUnitKey,
  profile: CatalogProviderProfileVersionReview | null,
  readinessUnit: CatalogIntegrationControlPlaneUnitReadiness | null,
): Readonly<{ productDomain: string; productForm: string }> {
  try {
    const parsed = parseCatalogIntegrationUnitKey(unitKey);
    return { productDomain: parsed.productDomain, productForm: parsed.productForm };
  } catch {
    const [profileProductDomain, profileProductForm] = profile?.supportedScopes[0]?.split("/") ?? [];
    return {
      productDomain: readinessUnit?.productDomain ?? profileProductDomain ?? "catalog",
      productForm: readinessUnit?.productForm ?? profileProductForm ?? "source-observation",
    };
  }
}

function providerDisplayName(
  providerKey: string,
  providerProfiles: readonly CatalogProviderProfileVersionReview[],
  selectedProfile: CatalogProviderProfileVersionReview | null,
  readinessUnits: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): string {
  const activeProfiles = providerProfiles.filter((profile) => profile.active);
  if (activeProfiles.length <= 1) {
    return (
      selectedProfile?.displayName ??
      activeProfiles[0]?.displayName ??
      providerProfiles[0]?.displayName ??
      readinessUnits[0]?.displayName ??
      providerBaseDisplayName(providerKey)
    );
  }

  return providerBaseDisplayName(providerKey);
}

function providerBaseDisplayName(providerKey: string): string {
  const names = new Map([
    ["mtgjson", "MTGJSON"],
    ["scryfall", "Scryfall"],
    ["scrydex", "Scrydex"],
    ["tcgdex", "TCGdex"],
    ["tcgplayer", "TCGplayer"],
  ]);

  return names.get(providerKey) ?? providerKey;
}

function providerReadinessHasImportUnit(
  provider: CatalogIntegrationProviderReadiness,
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): boolean {
  return units.some(
    (unit) =>
      unit.providerKey === provider.providerKey &&
      (unit.ingestionPurpose === "import" || unit.ingestionPurpose === "source-observation-import") &&
      (provider.unitKeys.length === 0 || provider.unitKeys.includes(unit.unitKey)),
  );
}

function providerImportScopes(
  scopes: readonly SourceObservationIntegrationScope[],
  selectedImportScope: string | null,
  providerKey: string | null,
): readonly string[] {
  const maxProviderScopeOptions = 25;
  const selectedComparable = comparableImportScopeKey(selectedImportScope, providerKey);
  const selected = scopes.find(
    (scope) => comparableImportScopeKey(providerScopeValue(scope), providerKey) === selectedComparable,
  );
  const values = [
    ...(selectedImportScope ? [selectedImportScope] : []),
    ...(selected ? [providerScopeValue(selected)] : []),
    ...scopes.map(providerScopeValue),
  ];

  return [...new Set(values.filter(Boolean))].slice(0, maxProviderScopeOptions);
}

function providerScopeValue(scope: SourceObservationIntegrationScope): string {
  return [scope.language_code, scope.product_line_id, scope.series_id, scope.expansion_id].filter(Boolean).join(":");
}
