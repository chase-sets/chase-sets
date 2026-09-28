// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ItemDetailPage } from "../features/item-detail/ui/item-detail-page";
import { baseListing, createItem, requiredSchema } from "./item-detail-commerce-panel-test-harness";

vi.mock("@chase-sets/platform-runtime/realtime-react", () => ({
  useRealtimePatchedSnapshot: ({ initialSnapshot }: { initialSnapshot: unknown }) => initialSnapshot,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("item detail Listing fixture dependencies", () => {
  it.each([false, true])("implicit Product, dock actions and focus targets with Listing present=%s", (present) => {
    const listing = {
      ...baseListing,
      product_id: "cat_charizard::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
    };
    const { container } = render(
      <ItemDetailPage
        data={createItem({
          product_schema: requiredSchema,
          market_listings: present ? [listing] : [],
          offer_demand_matches: [],
        })}
        renderCommerce={() => ({ buy: <div>Buy workflow</div>, sell: <div>Sell workflow</div> })}
      />,
    );
    expect(container.querySelector("[data-product-options-surface]")?.getAttribute("data-product-id")).toBe(
      present ? listing.product_id : "",
    );
    expect(container.querySelectorAll("[data-focus-clearance-target]").length).toBe(present ? 1 : 0);
    const dock = within(screen.getByTestId("product-detail-mobile-dock"));
    expect(dock.queryByRole("button", { name: "Buy" }) !== null).toBe(present);
    expect(dock.queryByRole("button", { name: "Sell" }) !== null).toBe(present);
    expect(dock.queryByRole("link", { name: "Select options" }) !== null).toBe(!present);
  });
});
