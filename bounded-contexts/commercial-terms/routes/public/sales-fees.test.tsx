// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import SalesFeesRoute, { loader, meta } from "./sales-fees";

const publishedSchedule = {
  value: {
    label: "Standard seller terms",
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    shippingAllowancePercentageBps: 500,
  },
  source: "policy" as const,
  documentId: "pol_standard",
  effectiveFrom: "2026-07-03T00:00:00.000Z",
  resolvedAt: "2026-07-12T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sales fees route", () => {
  it("loads the canonical published schedule from Commercial Terms", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(publishedSchedule), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      loader({ request: new Request("https://chasesets.test/sales-fees"), params: {}, context: undefined } as never),
    ).resolves.toEqual(publishedSchedule);
    expect(fetch).toHaveBeenCalledWith(
      "https://chasesets.test/api/public/commercial-terms/marketplace-sales-fee-schedule",
      expect.anything(),
    );
  });

  it("renders the schedule with canonical percentage and money formatters", async () => {
    const router = createMemoryRouter(
      [{ path: "/sales-fees", loader: () => publishedSchedule, Component: SalesFeesRoute }],
      { initialEntries: ["/sales-fees"] },
    );

    render(<RouterProvider router={router} />);

    expect(
      await screen.findByText(/5% of the item price plus \$0\.00, never more than \$25\.00 per item/),
    ).toBeTruthy();
    expect(screen.getByText(/The fixed seller fee is \$0\.00/)).toBeTruthy();
  });

  it("publishes standard-schedule metadata", () => {
    expect(meta({} as never)).toEqual(
      expect.arrayContaining([
        { title: "Marketplace Seller Fees | Chase Sets" },
        {
          name: "description",
          content:
            "Review the single Chase Sets standard seller fee schedule, per-item cap, and listing-time fee confirmation.",
        },
      ]),
    );
  });
});
