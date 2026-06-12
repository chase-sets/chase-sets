export type MarketIntent = "buy" | "sell" | "watch";
export type MarketBookTab = "listings" | "offers" | "sales" | "details";
export type MarketSelectionSource = "explicit" | "implicit";
export type ExplicitSelectionParam = "listing" | "offer";

export function itemDetailRailAnalyticsWorkflow({
  intent,
  hasListing,
  listingSource,
  hasOffer,
  offerSource,
}: {
  intent: MarketIntent;
  hasListing: boolean;
  listingSource: MarketSelectionSource;
  hasOffer: boolean;
  offerSource: MarketSelectionSource;
}) {
  if (intent === "watch") {
    return "watch";
  }

  if (intent === "sell") {
    if (!hasOffer) {
      return "selected_product";
    }

    return offerSource === "explicit" ? "selected_offer" : "best_offer";
  }

  if (!hasListing) {
    return "selected_product";
  }

  return listingSource === "explicit" ? "selected_listing" : "best_available_listing";
}

export function itemDetailRailAnalyticsSelection({
  intent,
  hasListing,
  listingSource,
  hasOffer,
  offerSource,
}: {
  intent: MarketIntent;
  hasListing: boolean;
  listingSource: MarketSelectionSource;
  hasOffer: boolean;
  offerSource: MarketSelectionSource;
}) {
  if (intent === "buy" && hasListing) {
    return listingSource;
  }

  if (intent === "sell" && hasOffer) {
    return offerSource;
  }

  return "none";
}

export function readMarketIntentFromSearch(searchParams: URLSearchParams): MarketIntent {
  return searchParams.get("market") === "sell" ? "sell" : searchParams.get("market") === "watch" ? "watch" : "buy";
}

export function readExplicitSelectionId(searchParams: URLSearchParams, key: ExplicitSelectionParam) {
  const ids = new Set(
    searchParams
      .getAll(key)
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return ids.size === 1 ? [...ids][0] : null;
}

function commitItemDetailUrl(url: URL, mode: "push" | "replace") {
  if (typeof window === "undefined") {
    return;
  }

  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextUrl === currentUrl) {
    return;
  }

  if (mode === "push") {
    window.history.pushState(window.history.state, "", nextUrl);
  } else {
    window.history.replaceState(window.history.state, "", nextUrl);
  }
}

export function updateMarketIntentUrl(marketIntent: "buy" | "sell" | "watch") {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("market", marketIntent);
  commitItemDetailUrl(url, "replace");
}

export function updateExplicitSelectionUrl(
  selection: { listingId?: string | null; offerId?: string | null },
  mode: "push" | "replace" = "push",
) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);

  if ("listingId" in selection) {
    if (selection.listingId) {
      url.searchParams.set("listing", selection.listingId);
    } else {
      url.searchParams.delete("listing");
    }
  }

  if ("offerId" in selection) {
    if (selection.offerId) {
      url.searchParams.set("offer", selection.offerId);
    } else {
      url.searchParams.delete("offer");
    }
  }

  commitItemDetailUrl(url, mode);
}
