// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUcpMcpRoutes } from "@chase-sets/platform-runtime/ucp";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import type { DiscoveryItemsServices } from "../../../support/item-support/runtime";
import { createDiscoveryUcpHandlers } from "../../../support/ucp-support/catalog";
import { AgentProductCardsView } from "./agent-product-cards-view";
import retiredEnvelope from "./retired-envelope.negative.json";

const origin = "https://marketplace.example";

// The real catalog and MCP handlers, with only the storage reads replaced.
async function capture(
  operation: "search_catalog" | "lookup_catalog" | "get_product",
  catalog: Record<string, unknown>,
  outcome: "success" | "empty" | "error" = "success",
) {
  const item = {
    catalog_item_id: "cat_test",
    slug: "charizard",
    title: "Charizard",
    description: "Base Set",
    image_urls: ["/seed/charizard.webp"],
    market_listings: [
      {
        listing_id: "listing_test",
        listing_slug: "charizard-listing",
        price_amount: "12.34",
        price_currency_code: "USD",
      },
    ],
  };
  const items = {
    search: {
      searchItems: async () => ({ items: outcome === "empty" ? [] : [item], total: outcome === "empty" ? 0 : 1 }),
    },
    detail: { getItemDetail: async () => (outcome === "success" ? item : null) },
  } as unknown as DiscoveryItemsServices;
  const app = createUcpMcpRoutes({
    mcpToolHandlers: createDiscoveryUcpHandlers(items).mcpToolHandlers,
    allowInMemoryIdempotencyStoreForTests: true,
  });
  const response = await app.request(origin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "cards",
      method: "tools/call",
      params: { name: operation, arguments: { catalog } },
    }),
  });
  expect(response.status).toBe(200);
  const { result } = await response.json();
  expectUcpCapture(result.structuredContent, { operation, kind: outcome === "error" ? "error" : "resource" });
  return result;
}

afterEach(cleanup);

describe("agent product cards states", () => {
  it("shows loading before a result and fails closed for absent, malformed and retired results", () => {
    const props = { allowedOrigins: [origin], openLink: vi.fn() };
    const view = render(<AgentProductCardsView {...props} state={{ kind: "loading" }} />);
    expect(screen.getByText("Loading products")).toBeTruthy();
    for (const result of [undefined, { structuredContent: { products: [] } }, retiredEnvelope]) {
      view.rerender(<AgentProductCardsView {...props} state={{ kind: "result", result }} />);
      expect(screen.getByRole("alert").textContent).toContain("Product results could not be displayed");
      expect(screen.queryByRole("button")).toBeNull();
    }
  });

  it("renders empty searches and lookups and renders UCP error messages", async () => {
    const search = await capture("search_catalog", { query: "missing" }, "empty");
    const lookup = await capture("lookup_catalog", { ids: ["missing"] }, "empty");
    const error = await capture("get_product", { id: "missing" }, "error");
    const props = { allowedOrigins: [origin], openLink: vi.fn() };
    const view = render(<AgentProductCardsView {...props} state={{ kind: "result", result: search }} />);
    expect(screen.getByText("No matching products")).toBeTruthy();
    view.rerender(<AgentProductCardsView {...props} state={{ kind: "result", result: lookup }} />);
    expect(screen.getByText("No matching products")).toBeTruthy();
    view.rerender(<AgentProductCardsView {...props} state={{ kind: "result", result: error }} />);
    expect(screen.getByRole("alert").textContent).toContain("The requested product was not found.");
  });

  it.each([
    ["search_catalog", { query: "charizard" }, "light"],
    ["lookup_catalog", { ids: ["cat_test"] }, "dark"],
    ["get_product", { id: "cat_test" }, "light"],
  ] as const)("renders the pinned %s Product (%j) in %s host context", async (operation, catalog, theme) => {
    const result = await capture(operation, catalog);
    const openLink = vi.fn(async () => {});
    const view = render(
      <AgentProductCardsView
        theme={theme}
        state={{ kind: "result", result }}
        allowedOrigins={[origin]}
        openLink={openLink}
      />,
    );
    expect(view.container.querySelector("[data-chase-theme]")?.getAttribute("data-color-mode")).toBe(theme);
    expect(screen.getByText("Charizard")).toBeTruthy();
    expect(screen.getByText("$12.34")).toBeTruthy();
    expect(view.container.querySelector("img")?.src).toBe(`${origin}/seed/charizard.webp`);
    fireEvent.click(screen.getByRole("button", { name: "View on Chase Sets" }));
    expect(openLink).toHaveBeenCalledExactlyOnceWith(`${origin}/items/charizard`);
  });
});
