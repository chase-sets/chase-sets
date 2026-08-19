// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import MarketplaceAccountListingsRoute from "../routes/account-listings";

describe("account listings route rendering", () => {
  afterEach(cleanup);

  it("renders the real listings access-required route with tinted furniture chrome", async () => {
    const RouteStub = createRoutesStub([
      {
        path: "/account/listings",
        Component: MarketplaceAccountListingsRoute,
        loader: () => ({
          accountAccessRequired: {
            returnTo: "/account/listings",
            title: "Listing access is required",
            description: "Use an account that can manage marketplace listings.",
          },
        }),
      },
    ]);

    render(<RouteStub initialEntries={["/account/listings"]} />);

    const prompt = await screen.findByText(
      "Choose an account with listing access to continue. If this is the wrong account, use a different sign-in and return to this page.",
    );
    const root = prompt.closest(".rounded-tokenLg");
    expect(root).not.toBeNull();
    const tokens = new Set((root as HTMLElement).className.split(/\s+/));
    expect(tokens.has("bg-surface-2")).toBe(true);
    for (const excluded of ["surface-border", "ds-glass", "border", "shadow-tokenSm", "shadow-tokenLg", "ds-glow"])
      expect(tokens.has(excluded), `access-required prompt excludes ${excluded}`).toBe(false);
    expect(screen.getByRole("link", { name: "Use a different account" }).getAttribute("href")).toBe(
      "/sign-in?returnTo=%2Faccount%2Flistings",
    );
    expect(screen.getByRole("link", { name: "View account" }).getAttribute("href")).toBe("/account");
  });
});
