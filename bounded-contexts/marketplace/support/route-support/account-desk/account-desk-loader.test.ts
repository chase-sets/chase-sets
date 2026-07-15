import { afterEach, describe, expect, it, vi } from "vitest";

const requireActorFromAuthApi = vi.fn();
const listOfferMatches = vi.fn();
const listSellerListings = vi.fn();
const getSellerOpenOrderCount = vi.fn();

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: (...args: unknown[]) => requireActorFromAuthApi(...args),
}));
vi.mock("../../request-support/api-client", () => ({
  createMarketplaceRequestApiClient: () => ({
    listOfferMatches: (...args: unknown[]) => listOfferMatches(...args),
    listSellerListings: (...args: unknown[]) => listSellerListings(...args),
  }),
}));
vi.mock("../../request-support/ordering-open-orders-api-client", () => ({
  createOrderingOpenOrdersRequestApiClient: () => ({
    getSellerOpenOrderCount: (...args: unknown[]) => getSellerOpenOrderCount(...args),
  }),
}));

const { loader } = await import("./account-desk-loader");

function request() {
  return new Request("https://example.test/account/desk");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Seller Desk home loader", () => {
  it("composes the queue and KPI band from the marketplace reads", async () => {
    requireActorFromAuthApi.mockResolvedValue({ accountId: "acct-1" });
    listOfferMatches.mockResolvedValue({
      items: [
        {
          offer_id: "off-1",
          item_title: "Charizard",
          status: "submitted",
          created_at: "2026-07-13T00:00:00.000Z",
        },
      ],
    });
    listSellerListings.mockResolvedValue({
      items: [
        { listing_id: "lst-1", item_title: "Blastoise", status: "draft", updated_at: "2026-07-11T00:00:00.000Z" },
      ],
      statusCounts: { active: 7, draft: 1, paused: 0, withdrawn: 0 },
    });
    getSellerOpenOrderCount.mockResolvedValue(3);

    const data = await loader({ request: request() } as Parameters<typeof loader>[0]);

    expect(data.kpis).toEqual({
      activeListings: 7,
      openOrdersToShip: 3,
      nextPayoutAmount: null,
      walletBalanceAmount: null,
    });
    expect(data.queue.rollup.total).toBe(2);
    expect(data.queue.items.map((item) => item.source)).toEqual(["offer-response", "listing-action"]);
    expect(data.queue.degraded).toBe(false);
  });

  it("degrades the offer source and the KPI tile when the reads fail", async () => {
    requireActorFromAuthApi.mockResolvedValue({ accountId: "acct-1" });
    listOfferMatches.mockRejectedValue(new Error("offers down"));
    listSellerListings.mockResolvedValue({
      items: [],
      statusCounts: { active: 2, draft: 0, paused: 0, withdrawn: 0 },
    });
    getSellerOpenOrderCount.mockRejectedValue(new Error("ordering down"));

    const data = await loader({ request: request() } as Parameters<typeof loader>[0]);

    expect(data.kpis.activeListings).toBe(2);
    expect(data.kpis.openOrdersToShip).toBeNull();
    expect(data.queue.degraded).toBe(true);
    const offerHealth = data.queue.sources.find((source) => source.id === "offer-response");
    expect(offerHealth?.status).toBe("unavailable");
  });
});
