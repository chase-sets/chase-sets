// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceListingListPage } from "./listing-list-page";
import type {
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerOrderCapacity,
} from "./contracts";

const defaultOrderCapacity = {
  account_id: "acc_seller",
  max_open_orders: null,
  updated_at: "2026-06-01T00:00:00.000Z",
} satisfies MarketplaceSellerOrderCapacity;

const availableListings = {
  account_id: "acc_seller",
  status: "available",
  disabled_reason_category: null,
  available_again_on: null,
  available_again_at: null,
  disabled_at: null,
  enabled_at: "2026-06-01T00:00:00.000Z",
  away_window_starts_at: null,
  away_window_ends_at: null,
  away_window_reason_category: null,
  updated_at: "2026-06-01T00:00:00.000Z",
} satisfies MarketplaceSellerListingAvailability;

const unavailableListings = {
  account_id: "acc_seller",
  status: "unavailable",
  disabled_reason_category: "travel",
  available_again_on: "2026-07-20",
  available_again_at: "2026-07-20T05:00:00.000Z",
  disabled_at: "2026-07-13T12:00:00.000Z",
  enabled_at: null,
  away_window_starts_at: null,
  away_window_ends_at: null,
  away_window_reason_category: null,
  updated_at: "2026-07-13T12:00:00.000Z",
} satisfies MarketplaceSellerListingAvailability;

function buildListingRow(overrides: Partial<MarketplaceListingListItem> = {}): MarketplaceListingListItem {
  return {
    listing_id: "lst_1",
    account_id: "acc_seller",
    inventory_item_id: "inv_1",
    catalog_catalog_item_id: "cat_charizard",
    product_id: "cat_charizard::raw",
    item_language_code: "en",
    item_title: "Charizard",
    item_subtitle: "Base Set",
    selected_options: [],
    product_summary: null,
    product_measure_snapshot: { weightOunces: 1 } as never,
    graded_card: null,
    storage_location_name: "North shelf",
    ship_from_code: "CHI",
    ship_from_address: {
      name: "Seller Shipping",
      line1: "1 Warehouse Way",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    price_amount: "20.00",
    marketplace_sales_fee_unit_amount: "1.00",
    seller_net_unit_amount: "19.00",
    shipping_allowance_percentage_bps: 500,
    terms_schedule_id: "cts_default",
    terms_agreement_id: null,
    terms_resolved_at: "2026-04-17T00:00:00.000Z",
    fee_quote_fingerprint: "20.00|1.00|19.00|cts_default|",
    fee_locks: [],
    quantity_cap: 1,
    max_units_per_order: null,
    max_units_per_day: null,
    max_units_per_customer_account: null,
    evidence_requirements: null,
    evidence: [],
    status: "active",
    created_at: "2026-04-17T00:00:00.000Z",
    updated_at: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("marketplace listings workbench", () => {
  it("links to the dedicated create-listing route instead of embedding a create form", () => {
    const markup = renderToString(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
      />,
    );

    expect(markup).toContain('href="/account/listings/new"');
    expect(markup).not.toContain('name="catalogItemId"');
    expect(markup).not.toContain('encType="multipart/form-data"');
  });

  it("renders status-count metrics from server-computed status counts", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
        statusCounts={{ active: 3, draft: 2, paused: 1, withdrawn: 4 }}
      />,
    );

    expect(screen.getByText("Active listings")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Draft listings")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Paused listings")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Withdrawn listings")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
  });

  it("renders seller-reliability metrics from the own-account behavioral-metrics read, gating null rates to 'not enough orders yet'", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
        sellerBehavioralMetrics={{
          seller_account_id: "acc_seller",
          window_days: 90,
          orders_created_count: 20,
          seller_cancelled_count: 1,
          cancellation_rate: "0.0500",
          shipments_dispatched_count: 18,
          shipments_on_time_count: 17,
          on_time_shipment_rate: "0.9444",
          disputes_resolved_count: 0,
          disputes_against_seller_count: 0,
          dispute_rate: null,
          computed_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Seller reliability")).toBeTruthy();
    expect(screen.getByText("On-time shipment rate")).toBeTruthy();
    expect(screen.getByText("94.4%")).toBeTruthy();
    expect(screen.getByText("Cancellation rate")).toBeTruthy();
    expect(screen.getByText("5%")).toBeTruthy();
    expect(screen.getByText("Dispute rate")).toBeTruthy();
    expect(screen.getByText("Not enough orders yet")).toBeTruthy();
  });

  it("renders a URL-persisted status filter and title search", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [buildListingRow()] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
        filters={{ status: "paused", search: "Charizard" }}
      />,
    );

    expect((screen.getByLabelText("Search by title") as HTMLInputElement).value).toBe("Charizard");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("paused");
    expect(screen.getByText("Title: Charizard")).toBeTruthy();
    expect(screen.getByText("Status: Paused")).toBeTruthy();
  });

  it("selects listing rows and submits bulk pause with the selected ids", () => {
    const { container } = render(
      <MarketplaceListingListPage
        data={{ items: [buildListingRow({ listing_id: "lst_1" }), buildListingRow({ listing_id: "lst_2" })] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
      />,
    );

    // DataTable renders both a mobile card list and a desktop table; select the row's checkbox
    // by its accessible label (each surface renders one, both toggle the same selection state).
    fireEvent.click(screen.getAllByLabelText("Select row lst_1")[0]!);

    expect(screen.getByText("Pause selected")).toBeTruthy();
    expect(screen.getByText("Withdraw selected")).toBeTruthy();
    const hiddenInput = container.querySelector('input[type="hidden"][name="listingIds"]') as HTMLInputElement | null;
    expect(hiddenInput?.value).toBe("lst_1");

    const pauseButton = screen.getByRole("button", { name: "Pause selected" }) as HTMLButtonElement;
    expect(pauseButton.getAttribute("name")).toBe("intent");
    expect(pauseButton.getAttribute("value")).toBe("bulk-pause-listings");
  });

  it("renders per-row bulk action outcomes with success and failure badges", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [buildListingRow()] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
        bulkActionOutcomes={[
          { listingId: "lst_1", label: "Listing lst_1", outcome: "success", message: null },
          { listingId: "lst_2", label: "Listing lst_2", outcome: "error", message: "Listing is withdrawn." },
        ]}
      />,
    );

    expect(screen.getByText("1 succeeded, 1 failed")).toBeTruthy();
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Listing is withdrawn.")).toBeTruthy();
  });

  it("captures the seller-local resume instant client-side when a return date is chosen", () => {
    const { container } = render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
      />,
    );

    const dateInput = screen.getByLabelText("Available again on") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-07-20" } });

    const hiddenInstant = container.querySelector(
      'input[type="hidden"][name="availableAgainAt"]',
    ) as HTMLInputElement | null;
    expect(hiddenInstant?.value).toBe(new Date("2026-07-20T00:00:00").toISOString());
  });

  it("clears the hidden resume instant when the return date is cleared", () => {
    const { container } = render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
      />,
    );

    const dateInput = screen.getByLabelText("Available again on") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-07-20" } });
    fireEvent.change(dateInput, { target: { value: "" } });

    const hiddenInstant = container.querySelector(
      'input[type="hidden"][name="availableAgainAt"]',
    ) as HTMLInputElement | null;
    expect(hiddenInstant?.value).toBe("");
  });

  it("allows refreshing away settings while already unavailable, prefilled from current state", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={unavailableListings}
        orderCapacity={defaultOrderCapacity}
      />,
    );

    expect(screen.getByRole("button", { name: "Turn on listings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update away settings" })).toBeTruthy();
    expect((screen.getByLabelText("Reason") as HTMLSelectElement).value).toBe("travel");
    expect((screen.getByLabelText("Available again on") as HTMLInputElement).value).toBe("2026-07-20");
  });

  it("labels the away-settings action as turning listings off while currently available", () => {
    render(
      <MarketplaceListingListPage
        data={{ items: [] }}
        listingAvailability={availableListings}
        orderCapacity={defaultOrderCapacity}
      />,
    );

    expect(screen.getByRole("button", { name: "Turn off listings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on listings" })).toBeNull();
  });
});
