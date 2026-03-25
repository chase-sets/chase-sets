import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { CatalogAdminApp as App } from "./app";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });
}

function installFetchMock() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;

    switch (url) {
      case "/api/catalog/dimensions?limit=50&offset=0":
        return jsonResponse({
          items: [
            {
              dimension_id: "dim_1",
              key: "size",
              name: "Size",
              description: "Card size",
              status: "active",
              updated_at: "2026-03-08T00:00:00.000Z",
            },
          ],
          total: 1,
          count: 1,
        });
      case "/api/catalog/categories?limit=50&offset=0":
        return jsonResponse({
          items: [
            {
              category_id: "cat_1",
              key: "pokemon",
              name: "Pokemon",
              description: "Pokemon cards",
              status: "active",
              parent_category: null,
              display_order: 1,
              updated_at: "2026-03-08T00:00:00.000Z",
            },
          ],
          total: 1,
          count: 1,
        });
      case "/api/catalog/dimensions/dim_1":
        return jsonResponse({
          dimension_id: "dim_1",
          key: "size",
          name: "Size",
          description: "Card size",
          status: "active",
          updated_at: "2026-03-08T00:00:00.000Z",
          choices: [
            {
              choice_id: "chc_1",
              dimension_id: "dim_1",
              code: "standard",
              labels: [
                {
                  locale: "en",
                  value: "Standard",
                },
              ],
              display_order: 0,
              numeric_value: null,
              status: "active",
            },
          ],
        });
      default:
        throw new Error(`Unhandled fetch: ${url}`);
    }
  });
}

describe("catalog admin app", () => {
  it("boots on the default route and renders dimension data", async () => {
    const fetchMock = installFetchMock();

    render(<App />);

    expect(screen.getByText("Catalog Admin")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Dimensions" })).toBeTruthy();
    expect((await screen.findAllByText("Size")).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/catalog/dimensions?limit=50&offset=0",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("reacts to hash navigation and renders the target list page", async () => {
    installFetchMock();

    render(<App />);
    await screen.findByRole("heading", { name: "Dimensions" });

    act(() => {
      window.location.hash = "#/categories";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(await screen.findByRole("heading", { name: "Categories" })).toBeTruthy();
    expect((await screen.findAllByText("Pokemon")).length).toBeGreaterThan(0);
  });

  it("fetches and renders a detail page route", async () => {
    installFetchMock();

    render(<App />);

    act(() => {
      window.location.hash = "#/dimensions/dim_1";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(await screen.findByText("Choices")).toBeTruthy();
    expect((await screen.findAllByText("standard")).length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByText("Card size")).toBeTruthy();
    });
  });
});
