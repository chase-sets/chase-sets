// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { formatDateTime } from "@chase-sets/localization";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { jsonResponse, requestUrl } from "./test-support/http";
import type { ReviewOpportunity } from "@chase-sets/marketplace/server";

const { mockUseLoaderData, mockUseActionData, mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockUseLoaderData: vi.fn(),
  mockUseActionData: vi.fn(),
  mockRequireActorFromAuthApi: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    useLoaderData: mockUseLoaderData,
    useActionData: mockUseActionData,
  };
});

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import MarketplaceAccountPurchaseRoute, { action, loader } from "../routes/account-purchase";

const destinationFixture = {
  name: "Recipient Only",
  company: "Dock 7",
  line1: "455 Market St",
  line2: "Suite 8",
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: "phone-sentinel",
  email: "email-sentinel@example.test",
  verification: {
    status: "verified",
    source: "verification-sentinel",
    checkedAt: "2026-04-02T00:00:00.000Z",
  },
} satisfies AddressSnapshot;

const order = {
  order_id: "ord_1",
  source_type: "cart-checkout",
  source_reference_id: null,
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Buyer",
  seller_account_id: "acc_seller",
  seller_display_name: "Seller",
  shipping_option: "standard",
  item_subtotal_amount: "20.00",
  shipping_base_amount: "4.99",
  shipping_discount_amount: "0.00",
  shipping_allowance_amount: "4.99",
  shipping_overage_amount: "0.00",
  shipping_charge_amount: "4.99",
  sales_tax_amount: "0.00",
  marketplace_sales_fee_amount: "1.00",
  seller_net_amount: "19.00",
  seller_item_net_amount: "19.00",
  seller_payout_amount: "23.99",
  shipping_allowance_percentage_bps: 500,
  taxable_amount: "24.99",
  tax_jurisdiction_country: "US",
  tax_jurisdiction_state: "IL",
  tax_rate_bps: 0,
  tax_provider_name: "local-tax-stub",
  tax_provider_quote_reference: null,
  tax_quoted_at: "2026-04-02T00:00:00.000Z",
  total_amount: "24.99",
  terms_schedule_id: "cts_default",
  terms_agreement_id: null,
  terms_resolved_at: "2026-04-02T00:00:00.000Z",
  shipping_destination_snapshot: destinationFixture,
  shipping_origin_snapshot: {
    name: "Seller",
    company: null,
    line1: "1 Main St",
    line2: null,
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
    phone: null,
    email: null,
  },
  status: "pending-payment",
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  cancelled_at: null,
  cancellation_reason: null,
  ready_for_fulfillment_at: null,
  self_service_cancellation_available: true,
  cancellation_unavailable_reason: null,
  line_count: 1,
  total_quantity: 1,
  lines: [],
  inventory_holds: [],
};

const orderingCommit = {
  sourceContextName: "ordering",
  maxGlobalPosition: "42",
  eventIds: ["evt_order_cancelled"],
};

describe("marketplace account purchase route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads the purchase and matching review opportunity", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        fetchCalls.push(url);

        if (url.includes("/reviews/opportunities/orders/ord_1")) {
          return Promise.resolve(
            jsonResponse({
              order_id: "ord_1",
              subject_account_id: "acc_seller",
              subject_display_name: "seller",
              author_role: "buyer",
              eligible_at: "2026-04-02T00:00:00.000Z",
              active_review_id: "rev_1",
              active_review_revealed_at: "2026-04-05T00:00:00.000Z",
              submission_state: "allowed",
              hold_reason: null,
              window_expired: false,
              window_expires_at: "2026-06-01T00:00:00.000Z",
            } satisfies ReviewOpportunity),
          );
        }

        if (url.includes("/api/marketplace/account/purchases/ord_1")) {
          return Promise.resolve(
            jsonResponse({
              ...order,
              reviewOpportunity: {
                order_id: "ord_1",
                subject_account_id: "acc_seller",
                subject_display_name: "Seller",
                author_role: "buyer",
                eligible_at: "2026-04-02T00:00:00.000Z",
                active_review_id: "rev_1",
                response: "Thank you for sharing this.",
                revealed: true,
                scoring_disposition: "context-only",
              },
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/purchases/ord_1"),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.purchase.order_id).toBe("ord_1");
    expect(result.reviewOutcome.opportunity?.subject_account_id).toBe("acc_seller");
    expect(result.reviewOutcome.opportunity?.response).toBe("Thank you for sharing this.");
    expect(result.reviewOutcome.opportunity?.revealed).toBe(true);
    expect(result.reviewOutcome.opportunity?.scoring_disposition).toBe("context-only");
    expect(fetchCalls).toEqual([
      expect.stringContaining("/account/purchases/ord_1"),
      expect.stringContaining("/reviews/opportunities/orders/ord_1"),
    ]);
  });

  it.each(["revealed", "pending", "expired", "held", "404", "503", "network"] as const)(
    "composes the real purchase loader and panel for review %s",
    async (state) => {
      const calls: Request[] = [];
      const opportunity: ReviewOpportunity = {
        order_id: "ord_1",
        subject_account_id: "acc_seller",
        subject_display_name: null,
        author_role: "buyer",
        eligible_at: "2026-04-02T00:00:00.000Z",
        active_review_id: state === "expired" ? null : "rev_authoritative",
        active_review_revealed_at: state === "pending" || state === "expired" ? null : "2026-04-05T00:00:00.000Z",
        submission_state: state === "held" ? "held" : state === "pending" ? "allowed" : "expired",
        hold_reason: state === "held" ? "feedback-on-hold" : null,
        window_expired: state === "expired",
        window_expires_at: "2026-06-01T00:00:00.000Z",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          calls.push(request);
          if (request.url.includes("/account/purchases/ord_1"))
            return Promise.resolve(
              jsonResponse({
                ...order,
                reviewOpportunity: { author_role: "buyer", active_review_id: "rev_stale", revealed: true },
              }),
            );
          expect(request.url).toContain("/reviews/opportunities/orders/ord_1");
          if (state === "network") return Promise.reject(new Error("Network unavailable"));
          if (state === "404" || state === "503")
            return Promise.resolve(jsonResponse({ error: "Review read failed" }, Number(state)));
          return Promise.resolve(jsonResponse(opportunity));
        }),
      );
      const result = await loader({
        request: new Request("http://localhost/account/purchases/ord_1", { headers: { cookie: "session=test" } }),
        params: { purchaseId: "ord_1" },
        context: undefined,
      } as never);
      expect(result.purchase.order_id).toBe("ord_1");
      expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
        "/api/marketplace/account/purchases/ord_1",
        "/api/marketplace/reviews/opportunities/orders/ord_1",
      ]);
      expect(calls[1]?.headers.get("cookie")).toBe("session=test");
      expect(calls[1]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
      expect(result.reviewOutcome.status).toBe(["503", "network"].includes(state) ? "unavailable" : "ready");
      if (["404", "503", "network"].includes(state)) expect(result.reviewOutcome.opportunity).toBeNull();
      if (state === "revealed") expect(result.reviewOutcome.opportunity?.revealed).toBe(true);
      mockUseLoaderData.mockReturnValue(result);
      render(
        <ChaseRoot>
          <MarketplaceAccountPurchaseRoute />
        </ChaseRoot>,
      );
      const labels = {
        revealed: "Published",
        pending: "Awaiting publication",
        expired: "Review window closed",
        held: "Review paused",
        "404": "Review not available yet",
        "503": "Review status is temporarily unavailable",
        network: "Review status is temporarily unavailable",
      };
      expect(screen.getByText(labels[state])).toBeTruthy();
      for (const label of new Set(Object.values(labels))) {
        if (label !== labels[state]) expect(screen.queryByText(label)).toBeNull();
      }
      expect(screen.getByRole("heading", { name: "Order outcome" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Leave account review" })).toBeNull();
      expect(document.querySelector('a[href*="rev_stale"]')).toBeNull();
      expect(screen.queryByText(/Reviews open only after delivery/)).toBeNull();
      if (state === "revealed" || state === "pending") {
        expect(screen.getByRole("link", { name: "Open your review" }).getAttribute("href")).toBe(
          "/account/reviews/rev_authoritative",
        );
      } else {
        expect(screen.queryByRole("link", { name: "Open your review" })).toBeNull();
      }
    },
  );

  it("does not request a review when the purchase read fails", async () => {
    const fetch = vi.fn((_input: string | URL | Request) =>
      Promise.resolve(jsonResponse({ error: "Order unavailable" }, 503)),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      loader({
        request: new Request("http://localhost/account/purchases/ord_1"),
        params: { purchaseId: "ord_1" },
        context: undefined,
      } as never),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetch.mock.calls[0]![0]!)).toContain("/account/purchases/ord_1");
  });

  it("renders recorded delivery through the HTTP request client and real purchase loader", async () => {
    const deliveredAt = "2026-04-09T17:42:00.000Z";
    const delivery_summary = { shipment_count: 2, delivered_count: 2, latest_delivered_at: deliveredAt };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        if (requestUrl(input).includes("/reviews/opportunities")) {
          return Promise.resolve(jsonResponse({ error: "No opportunity" }, 404));
        }
        expect(requestUrl(input)).toContain("/api/marketplace/account/purchases/ord_1");
        return Promise.resolve(
          jsonResponse({
            ...order,
            status: "ready-for-fulfillment",
            self_service_cancellation_available: false,
            cancellation_unavailable_reason: "fulfillment-started",
            delivery_summary,
          }),
        );
      }),
    );
    const result = await loader({
      request: new Request("http://localhost/account/purchases/ord_1"),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never);
    expect(result.purchase.delivery_summary).toEqual(delivery_summary);
    mockUseLoaderData.mockReturnValue(result);
    render(
      <ChaseRoot>
        <MarketplaceAccountPurchaseRoute />
      </ChaseRoot>,
    );
    expect(screen.getByText("Delivered")).toBeTruthy();
    expect(screen.getByText(formatDateTime(deliveredAt))).toBeTruthy();
    expect(screen.queryByText(/The seller has started packing/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Ask to cancel" })).toBeNull();
    expect(document.querySelector('a[href*="flow=buyer-cancel-request"]')).toBeNull();
  });

  it("forwards fresh-write metadata and retries a temporarily missing purchase", async () => {
    const fetchCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(request);
        const url = requestUrl(request);

        if (url.includes("/api/marketplace/account/purchases/ord_1")) {
          return Promise.resolve(
            fetchCalls.length === 1 ? jsonResponse({ error: { code: "not_found" } }, 404) : jsonResponse(order),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/purchases/ord_1", { commitPositions: [orderingCommit] }, Date.now())}`,
      ),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.purchase.order_id).toBe("ord_1");
    expect(fetchCalls.filter((request) => request.url.includes("/account/purchases/ord_1"))).toHaveLength(2);
    expect(fetchCalls.filter((request) => request.url.includes("/reviews/opportunities"))).toHaveLength(1);
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("ordering");
  });

  it("redirects purchase cancellation with the Ordering commit receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/purchases/ord_1/cancel")) {
          return Promise.resolve(
            jsonResponse({ id: "ord_1", version: 3, status: "cancelled" }, 200, {
              "Chase-Sets-Consistency": "committed",
              [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([orderingCommit]),
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = await action({
      request: new Request("http://localhost/account/purchases/ord_1", {
        method: "POST",
        body: new URLSearchParams({ intent: "cancel-purchase" }),
      }),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toContain("afterWrite=");
  });

  it("returns temporary recovery when a fresh purchase read hits projection freshness timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/purchases/ord_1")) {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: "Projection did not catch up.",
                },
              },
              503,
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = (await loader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/purchases/ord_1",
          { commitPositions: [orderingCommit] },
          Date.now(),
        )}`,
      ),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Preparing purchase");
    await expect(response.text()).resolves.toContain("preparing your purchase");
  });

  it("returns permanent not-found when a purchase handoff is expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/purchases/ord_1")) {
          return Promise.resolve(jsonResponse({ error: { code: "not_found" } }, 404));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = (await loader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/purchases/ord_1",
          { commitPositions: [orderingCommit] },
          Date.now() - 40_000,
        )}`,
      ),
      params: { purchaseId: "ord_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Purchase not found.");
  });

  it("renders a verified-purchase account review CTA", () => {
    expect(order.shipping_destination_snapshot.verification?.source).toBe("verification-sentinel");
    mockUseLoaderData.mockReturnValue({
      purchase: order,
      reviewOutcome: {
        status: "ready",
        opportunity: {
          order_id: "ord_1",
          subject_account_id: "acc_seller",
          subject_display_name: "Seller",
          author_role: "buyer",
          eligible_at: "2026-04-02T00:00:00.000Z",
          active_review_id: null,
          submission_state: "allowed",
          hold_reason: null,
          window_expired: false,
        },
      },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPurchaseRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Leave account review")).toBeTruthy();
    const destinations = screen.getAllByRole("region", { name: "Shipping destination" });
    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.querySelectorAll("address")).toHaveLength(1);
  });

  it("hides the review CTA when the order is not verified for review", () => {
    expect(order.shipping_destination_snapshot.verification?.source).toBe("verification-sentinel");
    mockUseLoaderData.mockReturnValue({
      purchase: order,
      reviewOutcome: { status: "ready", opportunity: null },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPurchaseRoute />
      </ChaseRoot>,
    );

    expect(screen.queryByText("Leave account review")).toBeNull();
  });

  it("shows direct cancellation for a fulfillment-ready purchase inside the cancellation window", () => {
    expect(order.shipping_destination_snapshot.verification?.source).toBe("verification-sentinel");
    mockUseLoaderData.mockReturnValue({
      purchase: {
        ...order,
        status: "ready-for-fulfillment",
        ready_for_fulfillment_at: "2026-04-02T00:10:00.000Z",
        self_service_cancellation_available: true,
        cancellation_unavailable_reason: null,
      },
      reviewOutcome: { status: "ready", opportunity: null },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPurchaseRoute />
      </ChaseRoot>,
    );

    expect(screen.getByRole("button", { name: "Cancel purchase" })).toBeTruthy();
  });

  it("routes cancellation to support after fulfillment starts", () => {
    expect(order.shipping_destination_snapshot.verification?.source).toBe("verification-sentinel");
    mockUseLoaderData.mockReturnValue({
      purchase: {
        ...order,
        status: "ready-for-fulfillment",
        ready_for_fulfillment_at: "2026-04-02T00:10:00.000Z",
        self_service_cancellation_available: false,
        cancellation_unavailable_reason: "fulfillment-started",
      },
      reviewOutcome: { status: "ready", opportunity: null },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPurchaseRoute />
      </ChaseRoot>,
    );

    expect(screen.queryByRole("button", { name: "Cancel purchase" })).toBeNull();
    expect(screen.getByRole("link", { name: "Ask to cancel" }).getAttribute("href")).toBe(
      "/account/support?orderId=ord_1&flow=buyer-cancel-request",
    );
  });
});
