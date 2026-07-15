// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import SalesFeesRoute, { headers, loader, meta } from "./sales-fees";

const values = {
  "marketplace-sales-fee.standard.bps": policyValue("bps", 500),
  "marketplace-sales-fee.standard.fixed": policyValue("money", "0.00", "USD"),
  "marketplace-sales-fee.standard.cap": policyValue("money", "25.00", "USD"),
  "checkout-processing-fee.card.bps": policyValue("bps", 290),
  "checkout-processing-fee.card.fixed": policyValue("money", "0.30", "USD"),
  "checkout-processing-fee.bank-account.bps": policyValue("bps", 50),
  "checkout-processing-fee.bank-account.fixed": policyValue("money", "0.00", "USD"),
  "checkout-processing-fee.platform-credit.bps": policyValue("bps", 0),
  "checkout-processing-fee.platform-credit.fixed": policyValue("money", "0.00", "USD"),
};

function policyValue(type: "bps" | "money", value: number | string, currency?: string) {
  return { type, value, ...(currency ? { currency } : {}), effectiveFrom: "2026-07-03T00:00:00.000Z", upcoming: [] };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sales fees route", () => {
  it("resolves the canonical article from the public whitelisted policy read", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            values,
            resolvedAt: "2026-07-12T00:00:00.000Z",
            propagationSeconds: 300,
            changeCalloutDays: 30,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await loader({
      request: new Request("https://chasesets.test/sales-fees"),
      params: {},
      context: undefined,
    } as never);

    expect(fetch).toHaveBeenCalledWith("https://chasesets.test/api/public-presence/policy-values", expect.anything());
    expect(JSON.stringify(result.article.blocks)).not.toContain('"type":"policy-value"');
  });

  it("renders the standard account schedule and each checkout processing fee", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            values,
            resolvedAt: "2026-07-12T00:00:00.000Z",
            propagationSeconds: 300,
            changeCalloutDays: 30,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const data = await loader({
      request: new Request("https://chasesets.test/sales-fees"),
      params: {},
      context: undefined,
    } as never);
    const router = createMemoryRouter([{ path: "/sales-fees", loader: () => data, Component: SalesFeesRoute }], {
      initialEntries: ["/sales-fees"],
    });

    render(<RouterProvider router={router} />);

    expect(
      await screen.findByText(/Personal, business, and enterprise accounts all use the same standard schedule/),
    ).toBeTruthy();
    expect(document.body.textContent).toContain("5% of the item price plus $0.00, capped at $25.00 per item");
    expect(screen.getByText(/Card:/).textContent).toContain("2.9% plus $0.30");
    expect(screen.getByText(/Bank account:/).textContent).toContain("0.5% plus $0.00");
    expect(screen.getByText(/Chase Sets credit:/).textContent).toContain("0% plus $0.00");
    expect(document.body.textContent).toContain("Wave 1: 100 invites");
    expect(document.body.textContent).toContain("Wave 2: 250 invites");
    expect(document.body.textContent).toContain("Wave 3: 500 invites");
    expect(document.body.textContent).toContain(
      "A qualified seller signup chooses Sell or Buy and sell, names at least one supported game, and selects an inventory-size range.",
    );
  });

  it("publishes article metadata and the bounded propagation window", async () => {
    expect(
      meta({ data: { article: { title: "Marketplace sales and checkout fees", description: "Live fees" } } } as never),
    ).toEqual(
      expect.arrayContaining([
        { title: "Marketplace sales and checkout fees | Chase Sets" },
        { name: "description", content: "Live fees" },
      ]),
    );
    expect(headers()["Cache-Control"]).toContain("s-maxage=300");
  });
});
