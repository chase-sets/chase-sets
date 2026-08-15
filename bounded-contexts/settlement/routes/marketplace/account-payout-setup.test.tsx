// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { mockUseLoaderData } = vi.hoisted(() => ({ mockUseLoaderData: vi.fn() }));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useLoaderData: mockUseLoaderData };
});

import MarketplaceAccountPayoutSetupRoute from "./account-payout-setup";

describe("MarketplaceAccountPayoutSetupRoute", () => {
  it("renders the access-recovery next step as flat page furniture", () => {
    mockUseLoaderData.mockReturnValue({
      accountAccessRequired: {
        returnTo: "/account/desk/settings",
        title: "Account access required",
        description: "Use an account with payout setup access.",
      },
      payoutReadiness: null,
      mode: "setup",
      returnTo: null,
      stripePublishableKey: null,
      setupNotice: null,
    });

    const html = renderToStaticMarkup(<MarketplaceAccountPayoutSetupRoute />);
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const nextStep = rendered.querySelector('[data-testid="account-access-next-step-furniture"]');
    expect(nextStep?.textContent).toContain("Use a different account");
    expect(nextStep?.querySelector(".ds-glass")).toBeNull();
  });
});
