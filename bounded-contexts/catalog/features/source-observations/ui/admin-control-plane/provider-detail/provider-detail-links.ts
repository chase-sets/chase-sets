// Href generation for the v2 Provider detail page (/catalog/providers/:providerKey).
//
// The v2 control-plane blueprint drops returnPath/section detour propagation: a
// provider is a real destination, not a workspace inside the deprecated
// ?section= router, so its hrefs are self-contained path + entity-reference query
// params (providerKey, profileVersion) rather than the legacy
// catalogPrimaryWorkbenchSupportingHref workspace lookup.
export const CATALOG_PROVIDER_DETAIL_BASE_PATH = "/catalog/providers";

export function catalogProviderDetailHref(
  providerKey: string | null,
  params?: Readonly<Record<string, string | null | undefined>>,
): string {
  if (!providerKey) {
    return CATALOG_PROVIDER_DETAIL_BASE_PATH;
  }

  const path = `${CATALOG_PROVIDER_DETAIL_BASE_PATH}/${encodeURIComponent(providerKey)}`;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) {
      searchParams.set(key, value);
    }
  }
  const query = searchParams.toString();

  return query ? `${path}?${query}` : path;
}
