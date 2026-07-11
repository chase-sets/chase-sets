const FRESH_HANDOFF_SEARCH_KEYS = ["afterWrite", "postWriteHandoff"] as const;

export function appendInventoryHandoffSearch(path: string, currentPath?: string | null) {
  if (!currentPath) {
    return path;
  }

  const targetUrl = new URL(path, "https://chase-sets.local");
  const currentUrl = new URL(currentPath, "https://chase-sets.local");
  for (const key of FRESH_HANDOFF_SEARCH_KEYS) {
    const value = currentUrl.searchParams.get(key);
    if (value) {
      targetUrl.searchParams.set(key, value);
    }
  }

  return `${targetUrl.pathname}${targetUrl.search}`;
}

export function inventoryListingHref(itemId: string, currentPath?: string | null) {
  return appendInventoryHandoffSearch(
    `/account/listings/new?${new URLSearchParams({ inventoryItemId: itemId })}`,
    currentPath,
  );
}
