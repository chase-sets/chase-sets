// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import {
  POLICY_VALUE_KEY_ATTRIBUTE,
  POLICY_VALUE_STATE_ATTRIBUTE,
  POLICY_VALUE_UNAVAILABLE_STATE,
  POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE,
  POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE,
  parsePolicyValueKeys,
} from "@chase-sets/public-presence/web";
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
  vi.restoreAllMocks();
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

  it.each([
    ["non-OK", () => vi.fn(async () => new Response("unavailable", { status: 503 }))],
    ["network", () => vi.fn(async () => Promise.reject(new Error("network unavailable")))],
    [
      "missing-key",
      () =>
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                values: Object.fromEntries(
                  Object.entries(values).filter(([key]) => key !== "marketplace-sales-fee.standard.bps"),
                ),
                resolvedAt: "2026-07-12T00:00:00.000Z",
                propagationSeconds: 300,
                changeCalloutDays: 30,
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
        ),
    ],
  ])("keeps the page available with explicit markers on a %s policy failure", async (_failure, createFetch) => {
    vi.stubGlobal("fetch", createFetch());
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const data = await loader({
      request: new Request("https://chasesets.test/sales-fees"),
      params: {},
      context: undefined,
    } as never);
    const router = createMemoryRouter([{ path: "/sales-fees", loader: () => data, Component: SalesFeesRoute }], {
      initialEntries: ["/sales-fees"],
    });

    render(<RouterProvider router={router} />);

    expect((await screen.findAllByText("Temporarily unavailable")).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("5% of the item price");
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      "[public-presence] Public policy values are unavailable.",
      expect.objectContaining({
        event: "public-policy-values.unavailable",
        route: "/sales-fees",
        unresolvedKeys: expect.arrayContaining(["marketplace-sales-fee.standard.bps"]),
      }),
    );

    const [, loggedFields] = error.mock.calls[0] as [string, { unresolvedKeys: readonly string[] }];
    const expectedKeys = [...loggedFields.unresolvedKeys].sort();
    const markers = [
      ...document.querySelectorAll(`[${POLICY_VALUE_STATE_ATTRIBUTE}="${POLICY_VALUE_UNAVAILABLE_STATE}"]`),
    ]
      .map((node) => node.getAttribute(POLICY_VALUE_KEY_ATTRIBUTE))
      .sort();
    expect(markers).toEqual(expectedKeys);
    const aggregate = document.querySelector(`[${POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE}]`);
    expect([...parsePolicyValueKeys(aggregate!.getAttribute(POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE)!)].sort()).toEqual(
      expectedKeys,
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
