import { describe, expect, it } from "vitest";
import { catalogProviderIntegrationProfiles } from "./provider-integration-profiles";
import type { CatalogProviderScope } from "./provider-integration-profiles";
import {
  catalogProviderImportScopeSecondSegmentKind,
  catalogProviderImportScopeSecondSegmentKindByProvider,
  type CatalogProviderImportScopeSecondSegmentKind,
} from "./provider-import-scope-shape";

// Derive the canonical import-scope second-segment shape straight from the provider
// registry: union every profile's declared `supportedScopes` per provider, then read
// the leading scope. A provider that imports at `product-line/category` reads the
// compact `language:X` second segment as a product line; one that leads with
// `set-name` reads it as an expansion; a provider that carries its own
// `language`/`series` hierarchy (TCGdex) reads it as a series — the default, which
// carries no projection entry.
function supportedScopesByProvider(): ReadonlyMap<string, ReadonlySet<CatalogProviderScope>> {
  const byProvider = new Map<string, Set<CatalogProviderScope>>();
  for (const profile of catalogProviderIntegrationProfiles) {
    const scopes = byProvider.get(profile.providerKey) ?? new Set<CatalogProviderScope>();
    for (const scope of profile.supportedScopes) {
      scopes.add(scope);
    }
    byProvider.set(profile.providerKey, scopes);
  }
  return byProvider;
}

function derivedSecondSegmentKind(
  supportedScopes: ReadonlySet<CatalogProviderScope>,
): CatalogProviderImportScopeSecondSegmentKind | null {
  if (supportedScopes.has("product-line/category")) {
    return "product-line";
  }
  if (supportedScopes.has("set-name") && !supportedScopes.has("language")) {
    return "expansion";
  }
  return null;
}

describe("Catalog provider import-scope shape projection", () => {
  const canonical = supportedScopesByProvider();

  it("stays in sync with the canonical provider registry for every provider", () => {
    const derived = new Map<string, CatalogProviderImportScopeSecondSegmentKind>();
    for (const [providerKey, supportedScopes] of canonical) {
      const kind = derivedSecondSegmentKind(supportedScopes);
      if (kind) {
        derived.set(providerKey, kind);
      }
      // The projection must agree with the registry for every provider, including
      // the default (series) providers that carry no entry.
      expect(catalogProviderImportScopeSecondSegmentKind(providerKey)).toBe(kind);
    }

    expect(Object.fromEntries([...derived].sort())).toStrictEqual(
      Object.fromEntries(Object.entries(catalogProviderImportScopeSecondSegmentKindByProvider).sort()),
    );
  });

  it("carries no projection entry for providers absent from the registry", () => {
    for (const providerKey of Object.keys(catalogProviderImportScopeSecondSegmentKindByProvider)) {
      expect(canonical.has(providerKey)).toBe(true);
    }
  });

  it("preserves the previously hardcoded two-segment scope shapes", () => {
    // Guards behavior parity with the deleted `twoSegment*ScopeProviders` sets.
    expect(catalogProviderImportScopeSecondSegmentKind("tcgplayer")).toBe("product-line");
    for (const providerKey of ["lorcanajson", "lorcast", "mtgjson", "scryfall", "scrydex", "ygojson", "ygoprodeck"]) {
      expect(catalogProviderImportScopeSecondSegmentKind(providerKey)).toBe("expansion");
    }
    // TCGdex carries its own language/series hierarchy, so the second segment is a
    // series selection (no product-line / expansion special-casing).
    expect(catalogProviderImportScopeSecondSegmentKind("tcgdex")).toBeNull();
    expect(catalogProviderImportScopeSecondSegmentKind(null)).toBeNull();
  });
});
