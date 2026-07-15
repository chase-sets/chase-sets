// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import {
  appendFreshWriteToken,
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";
import { navigateAfterWriteWithPlatformPostWriteToken } from "@chase-sets/platform-runtime/post-write-tokens";
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

import MarketplaceAccountSaleRoute, { action, loader } from "../routes/account-sale";
import { loader as salesListLoader } from "../routes/account-sales";

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
  seller_item_net_amount: "19.00",
  seller_payout_amount: "23.99",
  total_amount: "24.99",
  status: "ready-for-fulfillment",
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:00:00.000Z",
  cancelled_at: null,
  ready_for_fulfillment_at: "2026-04-02T00:15:00.000Z",
  line_count: 1,
  total_quantity: 1,
  lines: [],
  inventory_holds: [],
};

const orderingCommit = {
  sourceContextName: "ordering",
  maxGlobalPosition: "43",
  eventIds: ["evt_sale_cancelled"],
};

describe("marketplace account sale route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_seller",
      permissions: ["orders.view", "listings.view", "reputation.view", "reputation.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads the sale and matching review opportunity", async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        fetchCalls.push(url);

        if (url.includes("/api/marketplace/account/sales/ord_1")) {
          return Promise.resolve(
            jsonResponse({
              ...order,
              reviewOpportunity: {
                order_id: "ord_1",
                subject_account_id: "acc_buyer",
                subject_display_name: "Buyer",
                author_role: "seller",
                eligible_at: "2026-04-02T00:00:00.000Z",
                active_review_id: null,
              },
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/sales/ord_1"),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.sale.order_id).toBe("ord_1");
    expect(result.reviewOutcome.opportunity?.subject_account_id).toBe("acc_buyer");
    expect(fetchCalls).toEqual([expect.stringContaining("/account/sales/ord_1")]);
  });

  it("redirects sale cancellation with the Ordering commit receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/sales/ord_1/cancel")) {
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
      request: new Request("http://localhost/account/sales/ord_1", {
        method: "POST",
        body: new URLSearchParams({ intent: "cancel-sale" }),
      }),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toContain("afterWrite=");
  });

  it("forwards fresh-write metadata and retries a temporarily missing sale", async () => {
    const fetchCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(request);
        const url = requestUrl(request);

        if (url.includes("/api/marketplace/account/sales/ord_1")) {
          return Promise.resolve(
            fetchCalls.length === 1 ? jsonResponse({ error: { code: "not_found" } }, 404) : jsonResponse(order),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/sales/ord_1", { commitPositions: [orderingCommit] })}`,
      ),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never);

    expect(result.sale.order_id).toBe("ord_1");
    expect(fetchCalls.filter((request) => request.url.includes("/account/sales/ord_1"))).toHaveLength(2);
    expect(fetchCalls.some((request) => request.url.includes("/reviews/opportunities"))).toBe(false);
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("ordering");
  });

  it("returns temporary recovery when a fresh sale read hits projection freshness timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/sales/ord_1")) {
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
        `http://localhost${appendFreshWriteToken("/account/sales/ord_1", { commitPositions: [orderingCommit] })}`,
      ),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Preparing sale");
    await expect(response.text()).resolves.toContain("preparing your sale");
  });

  it("returns permanent not-found when a sale handoff is expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/sales/ord_1")) {
          return Promise.resolve(jsonResponse({ error: { code: "not_found" } }, 404));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const response = (await loader({
      request: new Request(
        `http://localhost${appendFreshWriteToken(
          "/account/sales/ord_1",
          { commitPositions: [orderingCommit] },
          Date.now() - 40_000,
        )}`,
      ),
      params: { orderId: "ord_1" },
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Sale not found.");
  });

  it("forwards seller checkout freshness when loading the sales list", async () => {
    const fetchCalls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        fetchCalls.push(request);
        return Promise.resolve(jsonResponse({ items: [order], total: 1, count: 1 }));
      }),
    );

    const requestPath = await navigateAfterWriteWithPlatformPostWriteToken(
      { commitPositions: [orderingCommit] },
      "/account/sales",
    );
    expect(requestPath).toContain("postWriteToken=");
    expect(requestPath).not.toContain("afterWrite=");

    const result = await salesListLoader({
      request: new Request(`http://localhost${requestPath}`),
      params: {},
      context: undefined,
    } as never);

    expect(result.sales.items).toHaveLength(1);
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(fetchCalls[0]?.headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("ordering");
  });

  it("returns temporary recovery when the fresh sales list is still waiting on Ordering projections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/api/marketplace/account/sales")) {
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

    const response = (await salesListLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/sales", { commitPositions: [orderingCommit] })}`,
      ),
      params: {},
      context: undefined,
    } as never).catch((error) => error)) as Response;

    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Preparing sales");
  });

  it("renders a verified-sale counterparty review CTA", () => {
    mockUseLoaderData.mockReturnValue({
      sale: order,
      reviewOutcome: {
        status: "ready",
        opportunity: {
          order_id: "ord_1",
          subject_account_id: "acc_buyer",
          subject_display_name: "Buyer",
          author_role: "seller",
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
        <MarketplaceAccountSaleRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Leave account review")).toBeTruthy();
  });

  it("starts seller-cannot-fulfill intake from the sale detail without a role query", () => {
    mockUseLoaderData.mockReturnValue({
      sale: order,
      reviewOutcome: { status: "ready", opportunity: null },
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountSaleRoute />
      </ChaseRoot>,
    );

    const reportLink = screen.getByRole("link", { name: "Report a problem" });
    expect(reportLink.getAttribute("href")).toBe("/account/support?orderId=ord_1&flow=seller-cannot-fulfill");
  });
});
