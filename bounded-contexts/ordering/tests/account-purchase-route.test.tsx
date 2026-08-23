// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { jsonResponse, requestUrl } from "./test-support/http";

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
    expect(fetchCalls).toEqual([expect.stringContaining("/account/purchases/ord_1")]);
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
    expect(fetchCalls.some((request) => request.url.includes("/reviews/opportunities"))).toBe(false);
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
