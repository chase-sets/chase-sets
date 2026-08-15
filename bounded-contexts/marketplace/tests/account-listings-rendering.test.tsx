// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import MarketplaceAccountListingsRoute from "../routes/account-listings";

afterEach(cleanup);

function expectTintedCard(root: Element | null) {
  expect(root).toBeTruthy();
  const className = (root as HTMLElement).className;
  expect(className.split(/\s+/)).toContain("bg-surface-2");
  expect(className).not.toMatch(
    /\b(?:ds-glass|border|border-muted|shadow-\S+|ds-glow|hover:border-accent|hover:shadow-tokenMd)\b/,
  );
}

describe("account listings default route rendering", () => {
  it("renders populated access-required loader data through the real route and owns its tinted prompt root", async () => {
    const Stub = createRoutesStub([
      {
        path: "/account/listings",
        Component: MarketplaceAccountListingsRoute,
        loader: () => ({
          accountAccessRequired: {
            title: "Use a selling account to manage listings",
            description:
              "This signed-in account can browse the marketplace, but it is not the selling account for listing management.",
            returnTo: "/account/listings",
          },
          listings: { items: [], total: 0, count: 0 },
          feeLockReport: { items: [], total: 0, count: 0 },
          listingAvailability: null,
          orderCapacity: null,
          openOrderCount: null,
          filters: { status: null, search: "" },
          sellerBehavioralMetrics: null,
        }),
      },
    ]);

    render(<Stub initialEntries={["/account/listings"]} />);

    expectTintedCard(
      (
        await screen.findByText(
          "Choose an account with listing access to continue. If this is the wrong account, use a different sign-in and return to this page.",
        )
      ).closest(".rounded-tokenLg"),
    );
  });
});
