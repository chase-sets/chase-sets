// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import MarketplaceAccountListingsNewRoute from "../routes/account-listings-new";

describe("new account listing route rendering", () => {
  afterEach(cleanup);

  it("renders the real new-listing access-required route with tinted furniture chrome", async () => {
    const RouteStub = createRoutesStub([
      {
        path: "/account/listings/new",
        Component: MarketplaceAccountListingsNewRoute,
        loader: () => ({
          accountAccessRequired: {
            returnTo: "/account/listings/new",
            title: "Listing access is required",
            description: "Use an account that can create marketplace listings.",
          },
        }),
      },
    ]);

    render(<RouteStub initialEntries={["/account/listings/new"]} />);

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
      "/sign-in?returnTo=%2Faccount%2Flistings%2Fnew",
    );
    expect(screen.getByRole("link", { name: "View account" }).getAttribute("href")).toBe("/account");
  });
});
