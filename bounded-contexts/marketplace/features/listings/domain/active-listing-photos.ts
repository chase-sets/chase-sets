import type { MarketplaceListingPhoto } from "./domain";

/** Returns only the current (active) evidence entries. */
export function activeListingPhotos(photos: readonly MarketplaceListingPhoto[]): readonly MarketplaceListingPhoto[] {
  return photos.filter((photo) => photo.status === "active");
}
