import { toCatalogAdminHref } from "../../../support/shell-support/ui/catalog-admin-hrefs";

// The provider key is the shared join key between an integration Source
// Observation and the Catalog Item it promotes into: promotion writes a
// `LinkExternalProductReference { providerKey }` onto the created/updated draft,
// and the Catalog Items list filters by that same provider via `?source=`. These
// two helpers are the seam between the integration surface and the Catalog Items
// area — the link is the handoff, no editing is duplicated across the boundary.

const CATALOG_ITEMS_LIST_PATH = "/catalog-items";
const CATALOG_INTEGRATIONS_PATH = "/catalog/integrations";

// Deep-link to the Catalog Items list filtered to a single source provider. This
// is where promotion's created/updated drafts land, so the daily Create / update
// stage uses it to point operators at the just-written items. An unknown or empty
// provider simply yields the unfiltered list — the list loader treats `source` as
// an opaque filter and renders an empty result, never a 500.
export function catalogItemsBySourceProviderHref(providerKey: string | null | undefined): string {
  const normalized = providerKey?.trim() ?? "";
  if (!normalized) {
    return toCatalogAdminHref(CATALOG_ITEMS_LIST_PATH);
  }

  const params = new URLSearchParams({ source: normalized });

  return `${toCatalogAdminHref(CATALOG_ITEMS_LIST_PATH)}?${params.toString()}`;
}

// Back-reference from a Catalog Item to the integration surface that produced it:
// the daily import-to-promotion flow scoped to the originating provider. The
// catalog item records its origin provider through its external product/catalog
// references, so a row's `providerKey` is enough to navigate back to the Source
// Observations and import jobs for that provider.
export function sourceObservationsForProviderHref(providerKey: string | null | undefined): string {
  const normalized = providerKey?.trim() ?? "";
  if (!normalized) {
    return CATALOG_INTEGRATIONS_PATH;
  }

  const params = new URLSearchParams({ providerKey: normalized });

  return `${CATALOG_INTEGRATIONS_PATH}?${params.toString()}`;
}
