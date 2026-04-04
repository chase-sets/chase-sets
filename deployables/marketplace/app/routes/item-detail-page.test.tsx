import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { ItemDetailPage } from "@chase-sets/discovery/web";
import { MarketplaceOfferSubmissionSection } from "@chase-sets/marketplace/web";
import type { DiscoveryItemDetail } from "@chase-sets/discovery/web";

function buildItemDetail(
  overrides: Partial<DiscoveryItemDetail> = {},
): DiscoveryItemDetail {
  return {
    item_id: "item-1",
    title: "Charizard",
    subtitle: "Base Set 4/102 Holo Rare",
    description:
      "The iconic Base Set Charizard, seeded as a single catalog item whose sellable versions vary by form, condition, and grade.",
    blueprint_id: "bp-1",
    blueprint: { blueprintId: "bp-1", name: "Pokemon Card Single" },
    status: "active",
    field_values: [
      { fieldId: "card-number", fieldName: "Card Number", value: "4/102" },
      { fieldId: "set-name", fieldName: "Set Name", value: "Base Set" },
    ],
    categories: [{ categoryId: "cat-1", name: "Pokemon TCG" }],
    tags: ["base-set", "charizard", "holo"],
    image_urls: [],
    market_summary: {
      lowest_price_amount: "399.99",
      active_listing_count: 2,
      total_visible_quantity: 3,
    },
    market_listings: [
      {
        listing_id: "lst_1",
        account_id: "acc_1",
        inventory_record_id: "inv_1",
        catalog_item_id: "item-1",
        catalog_version_key: "item-1::condition:near-mint|form:raw",
        item_title: "Charizard",
        item_subtitle: "Base Set 4/102 Holo Rare",
        version_selection: [
          { dimensionId: "condition", choiceId: "near-mint" },
          { dimensionId: "form", choiceId: "raw" },
        ],
        version_summary: "Form: Raw | Condition: Near Mint",
        storage_location_name: "Vault annex",
        ship_from_code: "CHI-ANNEX-2",
        price_amount: "399.99",
        quantity_cap: 2,
        status: "active",
        seller_display_name: "Demo Seller",
        visible_quantity: 2,
        created_at: "2026-03-31T14:54:27.781Z",
        updated_at: "2026-03-31T14:54:27.781Z",
      },
    ],
    version_schema: {
      canonicalDimensionOrder: [
        { dimensionId: "form", dimensionName: "Form" },
        { dimensionId: "condition", dimensionName: "Condition" },
        { dimensionId: "grading-company", dimensionName: "Grading Company" },
        { dimensionId: "grade", dimensionName: "Grade" },
      ],
      dimensions: [
        {
          dimensionId: "form",
          dimensionName: "Form",
          required: true,
          appliesWhen: [],
          allowedChoices: [
            { choiceId: "raw", code: "raw", labels: [{ locale: "en-US", value: "Raw" }] },
            { choiceId: "graded", code: "graded", labels: [{ locale: "en-US", value: "Graded" }] },
          ],
        },
        {
          dimensionId: "condition",
          dimensionName: "Condition",
          required: true,
          appliesWhen: [],
          allowedChoices: [
            {
              choiceId: "near-mint",
              code: "NM",
              labels: [{ locale: "en-US", value: "Near Mint" }],
            },
            {
              choiceId: "excellent",
              code: "EX",
              labels: [{ locale: "en-US", value: "Excellent" }],
            },
          ],
        },
        {
          dimensionId: "grading-company",
          dimensionName: "Grading Company",
          required: true,
          appliesWhen: [{ dimensionId: "form", choiceIds: ["graded"] }],
          allowedChoices: [
            { choiceId: "ace", code: "ace", labels: [{ locale: "en-US", value: "ACE" }] },
            { choiceId: "psa", code: "psa", labels: [{ locale: "en-US", value: "PSA" }] },
          ],
        },
        {
          dimensionId: "grade",
          dimensionName: "Grade",
          required: true,
          appliesWhen: [{ dimensionId: "form", choiceIds: ["graded"] }],
          allowedChoices: [
            { choiceId: "10", code: "10", labels: [{ locale: "en-US", value: "Pristine 10" }] },
            { choiceId: "9", code: "9", labels: [{ locale: "en-US", value: "Mint 9" }] },
          ],
        },
      ],
    },
    updated_at: "2026-03-31T14:54:27.781Z",
    ...overrides,
  };
}

function renderItemDetail(data: DiscoveryItemDetail) {
  return render(
    <ChaseRoot>
      <ItemDetailPage data={data} />
    </ChaseRoot>,
  );
}

describe("marketplace item detail page", () => {
  it("renders image galleries when catalog imagery is available", () => {
    renderItemDetail(
      buildItemDetail({
        image_urls: [
          "https://images.example/charizard-front.jpg",
          "https://images.example/charizard-back.jpg",
        ],
      }),
    );

    expect(screen.getAllByAltText("Charizard image 1").length).toBeGreaterThan(0);
    expect(screen.getAllByAltText("Charizard image 2").length).toBeGreaterThan(0);
  });

  it("renders a branded empty media placeholder when imagery is unavailable", () => {
    renderItemDetail(buildItemDetail());

    expect(screen.getByText("Image coming soon")).toBeTruthy();
    expect(screen.getByText("Catalog imagery has not been added yet.")).toBeTruthy();
  });

  it("reveals conditional version dimensions when the buyer selects a graded form", () => {
    renderItemDetail(buildItemDetail());

    expect(screen.getByText("Choose Version")).toBeTruthy();
    expect(screen.queryAllByText("Grading Company")).toHaveLength(0);
    expect(screen.queryAllByText("Grade")).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: "Graded" }));

    expect(screen.getAllByText("Grading Company").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Grade").length).toBeGreaterThan(0);
  });

  it("updates the selected-version summary from the current dimension selections", () => {
    renderItemDetail(buildItemDetail());

    expect(screen.getByText("Selected Version")).toBeTruthy();
    expect(screen.getAllByText("Raw").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Near Mint").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Graded" }));

    expect(screen.getAllByText("ACE").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pristine 10").length).toBeGreaterThan(0);
  });

  it("renders compact metadata in the purchase rail with a formatted timestamp", () => {
    renderItemDetail(buildItemDetail());

    expect(screen.getAllByText("Pokemon Card Single").length).toBeGreaterThan(0);
    expect(screen.getByText("Pokemon TCG")).toBeTruthy();
    expect(screen.getByText("base-set")).toBeTruthy();
    expect(screen.getByText(/Mar 31, 2026/)).toBeTruthy();
    expect(screen.queryByText("2026-03-31T14:54:27.781Z")).toBeNull();
  });

  it("filters visible listings from the selected version", () => {
    renderItemDetail(
      buildItemDetail({
        market_listings: [
          {
            listing_id: "lst_raw",
            account_id: "acc_1",
            inventory_record_id: "inv_1",
            catalog_item_id: "item-1",
            catalog_version_key: "item-1::condition:near-mint|form:raw",
            item_title: "Charizard",
            item_subtitle: "Base Set 4/102 Holo Rare",
            version_selection: [
              { dimensionId: "condition", choiceId: "near-mint" },
              { dimensionId: "form", choiceId: "raw" },
            ],
            version_summary: "Form: Raw | Condition: Near Mint",
            storage_location_name: "Vault annex",
            ship_from_code: "CHI-ANNEX-2",
            price_amount: "399.99",
            quantity_cap: 1,
            status: "active",
            seller_display_name: "Raw Seller",
            visible_quantity: 1,
            created_at: "2026-03-31T14:54:27.781Z",
            updated_at: "2026-03-31T14:54:27.781Z",
          },
          {
            listing_id: "lst_graded",
            account_id: "acc_1",
            inventory_record_id: "inv_2",
            catalog_item_id: "item-1",
            catalog_version_key:
              "item-1::condition:near-mint|form:graded|grade:10|grading-company:ace",
            item_title: "Charizard",
            item_subtitle: "Base Set 4/102 Holo Rare",
            version_selection: [
              { dimensionId: "condition", choiceId: "near-mint" },
              { dimensionId: "form", choiceId: "graded" },
              { dimensionId: "grading-company", choiceId: "ace" },
              { dimensionId: "grade", choiceId: "10" },
            ],
            version_summary:
              "Form: Graded | Condition: Near Mint | Grading Company: ACE | Grade: Pristine 10",
            storage_location_name: "Vault annex",
            ship_from_code: "CHI-ANNEX-2",
            price_amount: "1499.99",
            quantity_cap: 1,
            status: "active",
            seller_display_name: "Graded Seller",
            visible_quantity: 1,
            created_at: "2026-03-31T14:54:27.781Z",
            updated_at: "2026-03-31T14:54:27.781Z",
          },
        ],
      }),
    );

    expect(screen.getByText("Raw Seller")).toBeTruthy();
    expect(screen.queryByText("Graded Seller")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Graded" }));

    expect(screen.getByText("Graded Seller")).toBeTruthy();
    expect(screen.queryByText("Raw Seller")).toBeNull();
  });

  it("binds the offer submission section to the selected version", () => {
    render(
      <ChaseRoot>
        <ItemDetailPage
          data={buildItemDetail()}
          renderAfterListings={(context) => (
            <MarketplaceOfferSubmissionSection
              catalogItemId={context.itemId}
              catalogVersionKey={context.selectedCatalogVersionKey}
              itemTitle={context.itemTitle}
              versionSelection={context.selectedVersionSelection}
              versionSummary={context.selectedVersionSummary}
              visibleListingCount={context.visibleListings.length}
            />
          )}
        />
      </ChaseRoot>,
    );

    expect(screen.getByText("Make An Offer")).toBeTruthy();
    expect(
      screen.getAllByText("Form: Raw | Condition: Near Mint").length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Graded" }));

    expect(
      screen.getAllByText(
        "Form: Graded | Condition: Near Mint | Grading Company: ACE | Grade: Pristine 10",
      ).length,
    ).toBeGreaterThan(0);
  });
});

