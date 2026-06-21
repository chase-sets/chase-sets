// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const acerolaProductSchema = {
  canonicalDimensionOrder: [
    { dimensionId: "form" },
    { dimensionId: "condition" },
    { dimensionId: "grading_company" },
    { dimensionId: "grade" },
  ],
  dimensions: [
    {
      dimensionId: "form",
      dimensionName: "Form",
      required: true,
      appliesWhen: [],
      allowedOptions: [
        { optionId: "graded", code: "graded", label: "Graded" },
        { optionId: "raw", code: "raw", label: "Raw" },
      ],
    },
    {
      dimensionId: "condition",
      dimensionName: "Condition",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["raw"] }],
      allowedOptions: [
        { optionId: "damaged", code: "damaged", label: "Damaged" },
        { optionId: "near_mint", code: "near_mint", label: "Near Mint" },
      ],
    },
    {
      dimensionId: "grading_company",
      dimensionName: "Grading Company",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["graded"] }],
      allowedOptions: [{ optionId: "psa", code: "psa", label: "PSA" }],
    },
    {
      dimensionId: "grade",
      dimensionName: "Grade",
      required: true,
      appliesWhen: [{ dimensionId: "form", optionIds: ["graded"] }],
      allowedOptions: [{ optionId: "gem_mint_10", code: "gem_mint_10", label: "Gem Mint 10" }],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("preserves claimed draft product options without posting inactive dimensions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "Acerola's Mischief",
            product_schema: acerolaProductSchema,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const { container } = render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        inventoryItems={[]}
        hasListingStockLocation={false}
        catalogItemApiBaseUrl="/catalog-items"
        createForm={{
          catalogItemId: "cat_acerola",
          selectedOptions: [
            { dimensionId: "form", optionId: "raw" },
            { dimensionId: "condition", optionId: "damaged" },
          ],
          priceAmount: "21.74",
          quantityCap: "1",
        }}
      />,
    );

    await screen.findByText("Acerola's Mischief");

    await waitFor(() =>
      expect((container.querySelector('input[name="selectedOptions"]') as HTMLInputElement | null)?.value).toBe(
        JSON.stringify([
          { dimensionId: "form", optionId: "raw" },
          { dimensionId: "condition", optionId: "damaged" },
        ]),
      ),
    );
    expect(screen.getByLabelText("Form")).toBeTruthy();
    expect(screen.getByLabelText("Condition")).toBeTruthy();
    expect(screen.queryByLabelText("Grading Company")).toBeNull();
    expect(screen.queryByLabelText("Grade")).toBeNull();
  });
});
