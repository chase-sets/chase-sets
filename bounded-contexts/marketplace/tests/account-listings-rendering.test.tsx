// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import MarketplaceAccountListingsRoute, { loader as listingsLoader } from "../routes/account-listings";

const sellerActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.view", "listings.manage"],
};

const listingAvailability = {
  account_id: "acc_1",
  status: "available",
  disabled_reason_category: null,
  available_again_on: null,
  available_again_at: null,
  disabled_at: null,
  enabled_at: null,
  away_window_starts_at: null,
  away_window_ends_at: null,
  away_window_reason_category: null,
  updated_at: "2026-04-17T00:00:00.000Z",
};

const insufficientHistorySellerMetrics = {
  seller_account_id: "acc_1",
  window_days: 30,
  orders_created_count: 3,
  seller_cancelled_count: 0,
  cancellation_rate: null,
  shipments_dispatched_count: 2,
  shipments_on_time_count: 2,
  on_time_shipment_rate: null,
  disputes_resolved_count: 0,
  disputes_against_seller_count: 0,
  dispute_rate: null,
  missing_responsibility_count: 0,
  computed_at: "2026-07-01 00:00:00+00",
  updated_at: "2026-07-01 00:00:00+00",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("account listings route rendering", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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

  it("discriminates a failed Seller Reliability read from insufficient history through the live loader", async () => {
    let sellerMetrics: () => Promise<Response> = () => Promise.reject(new TypeError("fetch failed"));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) return Promise.resolve(json({ actor: sellerActor }));
        if (url.includes("/api/marketplace/account/seller-metrics")) return sellerMetrics();
        if (url.includes("/api/marketplace/account/listing-availability")) {
          return Promise.resolve(json(listingAvailability));
        }
        if (url.includes("/api/ordering/account/sales/order-capacity")) {
          return Promise.resolve(json({ open_order_count: 4 }));
        }
        return Promise.resolve(json({ items: [], total: 0, count: 0 }));
      }),
    );
    const renderLiveRoute = () => {
      const RouteStub = createRoutesStub([
        { path: "/account/listings", Component: MarketplaceAccountListingsRoute, loader: listingsLoader },
      ]);
      render(<RouteStub initialEntries={["/account/listings"]} />);
    };

    // Failure: an unavailable notice, never insufficient-history copy or invented values.
    renderLiveRoute();
    expect(await screen.findByText(t("marketplace.features.sellerDesk.degraded.title"))).toBeTruthy();
    expect(screen.queryByText("Not enough orders yet")).toBeNull();
    expect(screen.queryByText(/from the last \d+ days/)).toBeNull();
    expect(screen.queryByText(/shipments dispatched/)).toBeNull();
    expect(screen.getByText("Listing health")).toBeTruthy();
    cleanup();

    // Control: a successful null-rate summary keeps insufficient history with its real fields.
    sellerMetrics = async () => json(insufficientHistorySellerMetrics);
    renderLiveRoute();
    expect(await screen.findByText(/from the last 30 days/)).toBeTruthy();
    expect(screen.getAllByText("Not enough orders yet")).toHaveLength(3);
    expect(screen.getByText("2 shipments dispatched")).toBeTruthy();
    expect(screen.getByText("3 orders, seller-caused only")).toBeTruthy();
    expect(screen.queryByText(t("marketplace.features.sellerDesk.degraded.title"))).toBeNull();
    expect(screen.getByText("Listing health")).toBeTruthy();
  });
});
