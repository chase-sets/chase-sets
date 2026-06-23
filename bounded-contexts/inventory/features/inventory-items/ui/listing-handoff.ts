const FRESH_HANDOFF_SEARCH_KEYS = ["afterWrite", "postWriteHandoff"] as const;

export function inventoryListingHref(itemId: string, currentPath?: string | null) {
  const targetSearch = new URLSearchParams({
    inventoryItemId: itemId,
  });

  if (currentPath) {
    const currentUrl = new URL(currentPath, "https://chase-sets.local");
    for (const key of FRESH_HANDOFF_SEARCH_KEYS) {
      const value = currentUrl.searchParams.get(key);
      if (value) {
        targetSearch.set(key, value);
      }
    }
  }

  return `/account/listings?${targetSearch.toString()}`;
}
