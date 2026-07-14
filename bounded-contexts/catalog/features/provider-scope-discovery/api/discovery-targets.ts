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
// lines) the provider currently exposes. Only scope-level list queries with no
// required parent are eligible: product/card/SKU-level queries are per-set
// imports the sync planner owns, and parent-required queries (e.g. TCGplayer
// set-names under a product line) would need a coordinate the registry is the
// one trying to learn.
export type ProviderScopeDiscoveryTarget = Readonly<{
  providerKey: string;
  profileKey: string;
  ingestionUnitKey: string;
  productDomain: CatalogProviderIngestionUnitProductDomain | null;
  queryKind: string;
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
      const key = `${providerKey}:${unitKey}:${query.queryKind}:${DEFAULT_DISCOVERY_LANGUAGE}`;
      if (targets.has(key)) {
        continue;
      }

      targets.set(key, {
        providerKey,
        profileKey: version.profileKey,
        ingestionUnitKey: unitKey,
        productDomain: productDomainForUnitKey(unitKey),
        queryKind: query.queryKind,
        scopeKind: scopeKindForQuery(query),
        languageCode: DEFAULT_DISCOVERY_LANGUAGE,
      });
    }
  }

  return [...targets.values()];
}

function scopeKindForQuery(query: CatalogProviderOptionQuery): ProviderScopeObservationKind {
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
      return "set";
    default:
      throw new Error(`Provider option query '${query.queryKind}' is not a scope-discovery query.`);
  }
}

function productDomainForUnitKey(unitKey: string): CatalogProviderIngestionUnitProductDomain | null {
  try {
    return parseCatalogIntegrationUnitKey(unitKey).productDomain as CatalogProviderIngestionUnitProductDomain;
  } catch {
    return null;
  }
}

function isScopeDiscoveryQuery(query: CatalogProviderOptionQuery): boolean {
  if (!SCOPE_DISCOVERY_QUERY_SCOPES.includes(query.scope)) {
    return false;
  }
  return !query.parentValue?.required;
}
