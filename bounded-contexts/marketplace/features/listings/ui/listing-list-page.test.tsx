import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarketplaceListingListPage } from "./listing-list-page";
import type { MarketplaceSellerListingAvailability } from "./contracts";

const availableListings = {
  account_id: "acc_seller",
  status: "available",
  disabled_reason_category: null,
  available_again_on: null,
  disabled_at: null,
  enabled_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
} satisfies MarketplaceSellerListingAvailability;

describe("marketplace listing form migration smoke", () => {
  it("keeps create-listing multipart payload fields after migration to shared Form", () => {
    const markup = renderToString(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        inventoryItems={[]}
        hasListingStockLocation
      />,
    );

    expect(markup).toContain('method="post"');
    expect(markup).toMatch(/encType="multipart\/form-data"|enctype="multipart\/form-data"/);
    expect(markup).toContain('name="selectedOptions"');
    expect(markup).toContain('name="catalogItemId"');
    expect(markup).toContain('name="priceAmount"');
    expect(markup).toContain('name="quantityCap"');
    expect(markup).toContain('name="listingPhotos"');
    expect(markup).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(markup).toContain('value="create-and-publish-listing"');
    expect(markup).toContain('value="preview-listing"');
    expect(markup).toContain('value="create-listing"');
  });
});
