// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import MarketplaceAccountListingsNewRoute from "../routes/account-listings-new";

afterEach(cleanup);

function expectTintedCard(root: Element | null) {
  expect(root).toBeTruthy();
  const className = (root as HTMLElement).className;
  expect(className.split(/\s+/)).toContain("bg-surface-2");
  expect(className).not.toMatch(
    /\b(?:ds-glass|border|border-muted|shadow-\S+|ds-glow|hover:border-accent|hover:shadow-tokenMd)\b/,
  );
}

describe("account listings new default route rendering", () => {
  it("renders populated access-required loader data through the real route and owns its tinted prompt root", async () => {
    const Stub = createRoutesStub([
      {
        path: "/account/listings/new",
        Component: MarketplaceAccountListingsNewRoute,
        loader: () => ({
          accountAccessRequired: {
            title: "Use a selling account to manage listings",
            description:
              "This signed-in account can browse the marketplace, but it is not the selling account for listing management.",
            returnTo: "/account/listings/new",
          },
          inventoryItems: [],
          hasListingStockLocation: false,
          claimError: null,
          createForm: null,
          evidenceReadiness: null,
        }),
      },
    ]);

    render(<Stub initialEntries={["/account/listings/new"]} />);

    expectTintedCard(
      (
        await screen.findByText(
          "Choose an account with listing access to continue. If this is the wrong account, use a different sign-in and return to this page.",
        )
      ).closest(".rounded-tokenLg"),
    );
  });
});
