import { parseCatalogIntegrationUnitKey } from "../../source-observations/api/integration-unit";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderOptionQuery,
  type CatalogProviderScope,
} from "../../source-observations/api/provider-integration-profiles";
import {
  catalogScopeProductDomainContracts,
  normalizeCatalogScopeProductDomain,
  type CatalogScopeProductDomain,
} from "../../scope-registry/domain/contract";

// A scope-discovery target is one provider option query the scheduled refresh
// executes to learn which scope options (series, expansions, sets, product
// lines) the provider currently exposes. Product/card/SKU-level queries are
// per-set imports the sync planner owns. A parent-required scope query remains
// eligible, but the runtime expands it only from the uniquely classified
// current-scan parent declared by the profile.
export type ProviderScopeDiscoveryTarget = Readonly<{
  providerKey: string;
  profileKey: string;
  ingestionUnitKey: string;
  productDomain: CatalogScopeProductDomain | null;
  queryKind: string;
  providerScope: CatalogProviderScope;
  parentScope: CatalogProviderScope | null;
  parentRequired: boolean;
  scopeKind: ProviderScopeObservationKind;
  languageCode: string;
}>;

export type ProviderScopeObservationKind = "language" | "product-line" | "series" | "expansion" | "set";

const SCOPE_DISCOVERY_QUERY_SCOPES: readonly CatalogProviderScope[] = [
  "language",
  "series",
  "expansion",
  "set-name",
  "product-line/category",
];

const DEFAULT_DISCOVERY_LANGUAGE = "en";

export function listProviderScopeDiscoveryTargets(
  profileVersions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): readonly ProviderScopeDiscoveryTarget[] {
  const targets = new Map<string, ProviderScopeDiscoveryTarget>();

  for (const version of profileVersions) {
    if (!version.active || version.lifecycle !== "active") {
      continue;
    }
    if (!version.profile.capabilities.includes("provider-option-query")) {
      continue;
    }

    for (const query of version.profile.optionQueries) {
      if (!isScopeDiscoveryQuery(query)) {
        continue;
      }

      const providerKey = version.providerKey.trim().toLowerCase();
      const unitKey = catalogProviderProfileVersionIngestionUnitKey(version);
      const productDomain = normalizeCatalogScopeProductDomain(productDomainForUnitKey(unitKey));
      const scopeKind = scopeKindForQuery(query, productDomain);
      if (!scopeKind) {
        continue;
      }
      const key = `${providerKey}:${unitKey}:${query.queryKind}:${DEFAULT_DISCOVERY_LANGUAGE}`;
      if (targets.has(key)) {
        continue;
      }

      targets.set(key, {
        providerKey,
        profileKey: version.profileKey,
        ingestionUnitKey: unitKey,
        productDomain,
        queryKind: query.queryKind,
        providerScope: query.scope,
        parentScope: query.parentScope,
        parentRequired: query.parentValue?.required === true,
        scopeKind,
        languageCode: DEFAULT_DISCOVERY_LANGUAGE,
      });
    }
  }

  return [...targets.values()];
}

function scopeKindForQuery(
  query: CatalogProviderOptionQuery,
  productDomain: CatalogScopeProductDomain | null,
): ProviderScopeObservationKind | null {
  switch (query.scope) {
    case "language":
      return "language";
    case "product-line/category":
      return "product-line";
    case "series":
      return "series";
    case "expansion":
      return "expansion";
    case "set-name":
      return productDomain ? catalogScopeProductDomainContracts[productDomain].leafReferenceTypeKey : null;
    default:
      throw new Error(`Provider option query '${query.queryKind}' is not a scope-discovery query.`);
  }
}

function productDomainForUnitKey(unitKey: string): string | null {
  try {
    return parseCatalogIntegrationUnitKey(unitKey).productDomain;
  } catch {
    return null;
  }
}

function isScopeDiscoveryQuery(query: CatalogProviderOptionQuery): boolean {
  return SCOPE_DISCOVERY_QUERY_SCOPES.includes(query.scope);
}
