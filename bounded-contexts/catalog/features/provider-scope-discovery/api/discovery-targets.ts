import { parseCatalogIntegrationUnitKey } from "../../source-observations/api/integration-unit";
import type { CatalogProviderIngestionUnitProductDomain } from "../../source-observations/api/provider-integration-mapping-contract";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderOptionQuery,
  type CatalogProviderScope,
} from "../../source-observations/api/provider-integration-profiles";

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
  productDomain: ProviderScopeDiscoveryProductDomain | null;
  queryKind: string;
  providerScope: CatalogProviderScope;
  parentScope: CatalogProviderScope | null;
  parentRequired: boolean;
  scopeKind: ProviderScopeObservationKind;
  languageCode: string;
}>;

export type ProviderScopeObservationKind = "language" | "product-line" | "series" | "expansion" | "set";

export type ProviderScopeDiscoveryProductDomain = Exclude<CatalogProviderIngestionUnitProductDomain, "mtg"> | "magic";

export type ProviderScopeDiscoveryTargetClassification = Readonly<{
  productDomain: ProviderScopeDiscoveryProductDomain;
  scopeKind: ProviderScopeObservationKind;
}>;

export type ProviderScopeDiscoveryTargetClassifier = (
  input: Readonly<{
    productDomain: string | null;
    providerScope: CatalogProviderScope;
  }>,
) => ProviderScopeDiscoveryTargetClassification | null;

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
  classifyTarget: ProviderScopeDiscoveryTargetClassifier,
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
      const classification = classifyTarget({
        productDomain: productDomainForUnitKey(unitKey),
        providerScope: query.scope,
      });
      if (!classification) {
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
        productDomain: classification.productDomain,
        queryKind: query.queryKind,
        providerScope: query.scope,
        parentScope: query.parentScope,
        parentRequired: query.parentValue?.required === true,
        scopeKind: classification.scopeKind,
        languageCode: DEFAULT_DISCOVERY_LANGUAGE,
      });
    }
  }

  return [...targets.values()];
}

function productDomainForUnitKey(unitKey: string): CatalogProviderIngestionUnitProductDomain | null {
  try {
    return parseCatalogIntegrationUnitKey(unitKey).productDomain as CatalogProviderIngestionUnitProductDomain;
  } catch {
    return null;
  }
}

function isScopeDiscoveryQuery(query: CatalogProviderOptionQuery): boolean {
  return SCOPE_DISCOVERY_QUERY_SCOPES.includes(query.scope);
}
