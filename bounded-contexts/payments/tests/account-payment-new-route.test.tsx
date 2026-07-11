// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { encodeCommitReceipt, readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import type { ComponentProps } from "react";
import { jsonResponse, requestUrl } from "./test-support/http";

type PurchaseDetail = Readonly<{
  order_id: string;
  source_type: string;
  source_reference_id: string | null;
  buyer_account_id: string;
  buyer_display_name: string;
  seller_account_id: string;
  seller_display_name: string;
  shipping_option: string;
  item_subtotal_amount: string;
  shipping_base_amount: string;
  shipping_discount_amount: string;
  shipping_charge_amount: string;
  sales_tax_amount: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  seller_payout_amount: string;
  status: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  ready_for_fulfillment_at: string | null;
  line_count: number;
  total_quantity: number;
  lines: readonly unknown[];
  inventory_holds: readonly unknown[];
}>;

const { mockUseActionData, mockUseLoaderData, mockUseNavigation, mockUseSubmit, mockRequireActorFromAuthApi } =
  vi.hoisted(() => ({
    mockUseActionData: vi.fn(),
    mockUseLoaderData: vi.fn(),
    mockUseNavigation: vi.fn(),
    mockUseSubmit: vi.fn(),
    mockRequireActorFromAuthApi: vi.fn(),
  }));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Form: (props: ComponentProps<"form">) => <form {...props} />,
    useActionData: mockUseActionData,
    useLoaderData: mockUseLoaderData,
    useNavigation: mockUseNavigation,
    useSubmit: mockUseSubmit,
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

import MarketplaceAccountPaymentNewRoute, { action, loader } from "../routes/marketplace/account-payment-new";

async function readResolvedFreshWriteToken(url: URL) {
  const resolvedRequest = await resolvePlatformPostWriteRequest(new Request(url));
  return readFreshWriteToken(resolvedRequest.url);
}

function buildPurchase(purchaseId: string): PurchaseDetail {
  return {
    order_id: purchaseId,
    source_type: "checkout",
    source_reference_id: "chk_1",
    buyer_account_id: "acc_buyer",
    buyer_display_name: "Buyer",
    seller_account_id: "acc_seller",
    seller_display_name: "Seller",
    shipping_option: "standard",
    item_subtotal_amount: "10.00",
    shipping_base_amount: "1.00",
    shipping_discount_amount: "0.00",
    shipping_charge_amount: "1.00",
    sales_tax_amount: "0.00",
    total_amount: "11.00",
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.50",
    seller_net_amount: "9.50",
    seller_payout_amount: "9.50",
    status: "pending-payment",
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    cancelled_at: null,
    ready_for_fulfillment_at: null,
    line_count: 1,
    total_quantity: 1,
    lines: [],
    inventory_holds: [],
  };
}

const checkoutStatus = {
  order_ids: ["ord_1", "ord_2"],
  currency_code: "usd",
  amount: "22.00",
  marketplace_checkout_fee: {
    payment_method_category: "card" as const,
    external_basis_amount: "9.50",
    marketplace_checkout_fee_amount: "0.60",
    marketplace_checkout_fee_reduction_amount: "0.00",
    total_amount: "22.60",
    processor_amount: "10.10",
    policy_version: "marketplace-checkout-fee-v1",
    quote_fingerprint: "quote_card",
    quoted_at: "2026-04-01T00:00:00.000Z",
  },
  payment_method_quotes: [
    {
      payment_method_category: "card" as const,
      external_basis_amount: "9.50",
      marketplace_checkout_fee_amount: "0.60",
      marketplace_checkout_fee_reduction_amount: "0.00",
      total_amount: "22.60",
      processor_amount: "10.10",
      policy_version: "marketplace-checkout-fee-v1",
      quote_fingerprint: "quote_card",
      quoted_at: "2026-04-01T00:00:00.000Z",
    },
    {
      payment_method_category: "bank-account" as const,
      external_basis_amount: "9.50",
      marketplace_checkout_fee_amount: "0.05",
      marketplace_checkout_fee_reduction_amount: "0.55",
      total_amount: "22.05",
      processor_amount: "9.55",
      policy_version: "marketplace-checkout-fee-v1",
      quote_fingerprint: "quote_bank",
      quoted_at: "2026-04-01T00:00:00.000Z",
    },
  ],
  wallet_credit: {
    requested_amount: "12.50",
    applied_amount: "12.50",
    external_amount: "9.50",
  },
  can_start_payment: true,
  unavailable_reasons: [],
  unavailable_reason_details: [],
};

const paymentCommitSource = {
  sourceContextName: "payments",
  maxGlobalPosition: "42",
  eventIds: ["evt_payment_created"],
};

function requestMethod(input: string | URL | Request, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

describe("marketplace account payment start route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSubmit.mockReturnValue(vi.fn());
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["purchases.view", "purchases.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("auto-submits the payment form when checkout redirects with autostart enabled", async () => {
    const submit = vi.fn();
    mockUseLoaderData.mockReturnValue({
      orderIds: ["ord_1", "ord_2"],
      orders: [buildPurchase("ord_1"), buildPurchase("ord_2")],
      autostart: true,
      wallet: {
        available_balance_amount: "0.00",
        currency_code: "usd",
      },
      checkoutStatus,
    });
    mockUseSubmit.mockReturnValue(submit);

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentNewRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Start payment")).toBeTruthy();
    expect(screen.getAllByText("$22.60")).toHaveLength(2);
    expect(screen.getByText("Ready to initialize payment")).toBeTruthy();

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[1]).toEqual({ method: "post" });
    expect(submit.mock.calls[0]?.[0]).toBeInstanceOf(HTMLFormElement);
  });

  it("loads checkout-created purchases from Payments order inputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/account/order-inputs")) {
          return Promise.resolve(jsonResponse({ orders: [buildPurchase("ord_1"), buildPurchase("ord_2")] }));
        }

        if (url.includes("/api/settlement/wallet")) {
          return Promise.resolve(
            jsonResponse({
              available_balance_amount: "12.50",
              currency_code: "usd",
            }),
          );
        }

        if (url.includes("/api/marketplace/account/checkout/status")) {
          return Promise.resolve(jsonResponse(checkoutStatus));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/payments/new?orderIds=ord_1,ord_2&autostart=1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.orderIds).toEqual(["ord_1", "ord_2"]);
    expect(result.autostart).toBe(true);
    expect(result.orders.map((purchase) => purchase.order_id)).toEqual(["ord_1", "ord_2"]);
    expect(result.wallet?.available_balance_amount).toBe("12.50");
  });

  it("creates a buyer payment and redirects into the confirmation route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/account/checkout/status")) {
          return Promise.resolve(jsonResponse(checkoutStatus));
        }

        if (url.includes("/api/marketplace/account/payments") && requestMethod(input, init) === "POST") {
          return Promise.resolve(
            jsonResponse({ payment_id: "pay_1" }, 201, {
              "Chase-Sets-Consistency": "eventual",
              "Chase-Sets-Commit-Receipt": encodeCommitReceipt([paymentCommitSource]),
              "Chase-Sets-Commit-Event-Ids": paymentCommitSource.eventIds.join(","),
              "Chase-Sets-Commit-Position": paymentCommitSource.maxGlobalPosition,
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const form = new URLSearchParams();
    form.set("orderIds", "ord_1, ord_2");

    const response = (await action({
      request: new Request("http://localhost/account/payments/new", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    const redirectUrl = new URL(location ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/account/payments/pay_1");
    expect(readCompactPostWriteToken(redirectUrl)).toMatch(/^pwt_/);
    expect(redirectUrl.searchParams.has("afterWrite")).toBe(false);
    expect(redirectUrl.searchParams.has("postWriteHandoff")).toBe(false);
    expect((await readResolvedFreshWriteToken(redirectUrl))?.sources).toEqual([paymentCommitSource]);
  });
});
