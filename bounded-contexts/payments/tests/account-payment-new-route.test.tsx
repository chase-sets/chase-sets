// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { encodeCommitReceipt, readCompactPostWriteToken, readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareMoneyAmounts, sumMoneyAmounts, trySignedMoneyToCents } from "@chase-sets/primitives/money";
import { jsonResponse, requestUrl } from "./test-support/http";
import type { PaymentsPaymentDetail } from "../client";

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
  sales_tax_amount: string | null;
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
    useFormAction: () => "/",
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

vi.mock("@chase-sets/primitives/money", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/primitives/money")>("@chase-sets/primitives/money");
  return {
    ...actual,
    compareMoneyAmounts: vi.fn(actual.compareMoneyAmounts),
    sumMoneyAmounts: vi.fn(actual.sumMoneyAmounts),
    trySignedMoneyToCents: vi.fn(actual.trySignedMoneyToCents),
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

const createdPayment = {
  payment_id: "pay_1",
  buyer_account_id: "acc_buyer",
  order_ids: ["ord_1", "ord_2"],
  amount: "22.00",
  balance_credit_amount: "12.50",
  processor_amount: "10.10",
  marketplace_sales_fee_amount: "1.00",
  marketplace_checkout_fee_amount: "0.60",
  marketplace_checkout_fee_policy_version: "marketplace-checkout-fee-v1",
  marketplace_checkout_fee_quote_fingerprint: "quote_card",
  payment_method_category: "card",
  saved_checkout_instrument_id: null,
  seller_net_amount: "21.00",
  seller_payout_amount: "21.00",
  seller_payouts: [],
  currency_code: "usd",
  processor_name: "stripe",
  processor_payment_kind: "payment-intent",
  processor_payment_reference: "pi_1",
  processor_client_secret: null,
  processor_redirect_url: null,
  processor_status: "requires_payment_method",
  source_context: null,
  source_reference_id: null,
  status: "pending-confirmation",
  failure_code: null,
  failure_message: null,
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
  captured_at: null,
  failed_at: null,
  cancelled_at: null,
  processor_publishable_key: null,
  provider_events: [],
} satisfies PaymentsPaymentDetail;

const paymentCommitSource = {
  sourceContextName: "payments",
  maxGlobalPosition: "42",
  eventIds: ["evt_payment_created"],
};

function requestMethod(input: string | URL | Request, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

type SurfaceTreatment = "outlined" | "elevated";

// Reads the rendered entity treatment back from the classes the design-system
// Surface owns: `outlined` is a hairline with no raised chrome, `elevated` the
// raised border and shadow.
function expectSurfaceTreatment(anchor: HTMLElement, treatment: SurfaceTreatment, glow = false) {
  const root = anchor.closest<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg");
  expect(root).toBeTruthy();
  const classes = root!.className.split(/\s+/);
  if (treatment === "elevated") expect(classes).toEqual(expect.arrayContaining(["surface-border", "shadow-tokenLg"]));
  else {
    expect(classes).toContain("border");
    expect(classes.includes("surface-border") || classes.some((name) => name.startsWith("shadow-"))).toBe(false);
  }
  expect(classes.includes("ds-glow")).toBe(glow);
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

  it.each([
    { amounts: ["0.10", "0.20"], taxes: [null, null], expected: "0.30", display: "$0.30", taxDisplay: "$0.00" },
    {
      amounts: ["0.10", "0.20"],
      fees: ["0.02", "0.04"],
      payouts: ["0.08", "0.16"],
      taxes: [null, null],
      expected: "0.30",
      display: "$0.30",
      feeDisplay: "$0.06",
      payoutDisplay: "$0.24",
      taxDisplay: "$0.00",
    },
    {
      amounts: ["0.10", "0.20", "0.00"],
      taxes: ["0.10", "0.20", null],
      expected: "0.30",
      display: "$0.30",
      taxDisplay: "$0.30",
    },
    {
      amounts: ["9999999.99", "9999999.99", "9999999.99"],
      taxes: [null, null, null],
      expected: "29999999.97",
      display: "$29,999,999.97",
      taxDisplay: "$0.00",
    },
  ])(
    "renders payment summary sums in exact cents ($expected)",
    ({ amounts, fees, payouts, taxes, expected, display, feeDisplay, payoutDisplay, taxDisplay }) => {
      mockUseLoaderData.mockReturnValue({
        orderIds: amounts.map((_, index) => `ord_${index}`),
        orders: amounts.map((amount, index) => ({
          ...buildPurchase(`ord_${index}`),
          total_amount: amount,
          marketplace_sales_fee_amount: fees?.[index] ?? amount,
          seller_payout_amount: payouts?.[index] ?? amount,
          sales_tax_amount: taxes[index],
        })),
        autostart: false,
        wallet: null,
        checkoutStatus,
      });

      const { container } = render(
        <ChaseRoot>
          <MarketplaceAccountPaymentNewRoute />
        </ChaseRoot>,
      );

      expect(container.querySelector<HTMLInputElement>('input[name="totalAmount"]')?.value).toBe(expected);
      expect(screen.getByText("Marketplace Sales Fee", { selector: "span" }).parentElement?.textContent).toContain(
        feeDisplay ?? display,
      );
      expect(screen.getByText("Seller payout", { selector: "span" }).parentElement?.textContent).toContain(
        payoutDisplay ?? display,
      );
      expect(screen.getByText("Sales tax").parentElement?.textContent).toContain(taxDisplay);
      expect(sumMoneyAmounts).toHaveBeenCalledWith(amounts);
      expect(sumMoneyAmounts).toHaveBeenCalledWith(fees ?? amounts);
      expect(sumMoneyAmounts).toHaveBeenCalledWith(payouts ?? amounts);
      expect(sumMoneyAmounts).toHaveBeenCalledWith(taxes.map((amount) => amount ?? "0.00"));
      expect(compareMoneyAmounts).toHaveBeenCalledWith("0.55", "0.00");
    },
  );

  it.each([
    { available: "-5.00", expected: "0.00", disabled: true },
    { available: "0.00", expected: "0.00", disabled: true },
    { available: "4.25", expected: "4.25", disabled: true },
    { available: "10.30", expected: "10.30", disabled: false },
    { available: "12.50", expected: "10.30", disabled: false },
    { available: "abc", expected: "0.00", disabled: true },
    { available: "12.50junk", expected: "0.00", disabled: true },
  ])(
    "caps balance credit at the order total and a non-negative balance ($available)",
    async ({ available, expected, disabled }) => {
      const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("/checkout/status")) {
          expect(new URL(url).searchParams.get("requestedBalanceCreditAmount")).toBe(expected);
          return Promise.resolve(jsonResponse(checkoutStatus));
        }
        if (url.includes("/account/payments") && requestMethod(input, init) === "POST") {
          expect(JSON.parse(String(init?.body)).requestedBalanceCreditAmount).toBe(expected);
          return Promise.resolve(
            jsonResponse(createdPayment, 201, {
              "Chase-Sets-Consistency": "eventual",
              "Chase-Sets-Commit-Receipt": encodeCommitReceipt([paymentCommitSource]),
              "Chase-Sets-Commit-Event-Ids": paymentCommitSource.eventIds.join(","),
              "Chase-Sets-Commit-Position": paymentCommitSource.maxGlobalPosition,
            }),
          );
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      });
      vi.stubGlobal("fetch", fetch);
      const response = await action({
        request: new Request("http://localhost/account/payments/new", {
          method: "POST",
          body: new URLSearchParams({
            orderIds: "ord_1",
            balanceCreditMode: "max",
            totalAmount: "10.30",
            availableBalance: available,
          }),
        }),
        params: {},
        context: undefined,
      } as never);
      expect(response).toBeInstanceOf(Response);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(trySignedMoneyToCents).toHaveBeenCalledWith(available);

      mockUseLoaderData.mockReturnValue({
        orderIds: ["ord_1"],
        orders: [{ ...buildPurchase("ord_1"), total_amount: "10.30" }],
        autostart: false,
        wallet: { available_balance_amount: available, currency_code: "usd" },
        checkoutStatus,
      });
      render(
        <ChaseRoot>
          <MarketplaceAccountPaymentNewRoute />
        </ChaseRoot>,
      );
      expect((screen.getByRole("option", { name: "Platform credit only" }) as HTMLOptionElement).disabled).toBe(
        disabled,
      );
      expect(screen.getByRole("option", { name: `Use up to $${expected}` })).toBeTruthy();
      expect(compareMoneyAmounts).toHaveBeenCalledWith(
        disabled ? (available === "4.25" ? "6.05" : "10.30") : "0.00",
        "0.00",
      );
    },
  );

  it.each([
    { available: "12.50", expected: "10.30" },
    { available: "-1.00", expected: "0.00" },
    { available: "abc", expected: "0.00" },
    { available: null, expected: "0.00" },
  ])("sends the exact-cent balance credit to checkout status ($available)", async ({ available, expected }) => {
    const statusRequests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/order-inputs")) {
          return Promise.resolve(
            jsonResponse({
              orders: [
                { ...buildPurchase("ord_1"), total_amount: "10.10" },
                { ...buildPurchase("ord_2"), total_amount: "0.20" },
              ],
            }),
          );
        }
        if (url.includes("/settlement/wallet")) {
          return Promise.resolve(
            available === null
              ? jsonResponse({}, 503)
              : jsonResponse({ available_balance_amount: available, currency_code: "usd" }),
          );
        }
        if (url.includes("/checkout/status")) {
          statusRequests.push(new URL(url));
          return Promise.resolve(jsonResponse(checkoutStatus));
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );
    await loader({
      request: new Request("http://localhost/account/payments/new?orderIds=ord_1,ord_2"),
      params: {},
      context: undefined,
    } as never);
    expect(statusRequests).toHaveLength(1);
    expect(statusRequests[0]?.searchParams.get("requestedBalanceCreditAmount")).toBe(expected);
    expect(sumMoneyAmounts).toHaveBeenCalledWith(["10.10", "0.20"]);
    expect(trySignedMoneyToCents).toHaveBeenCalledWith(available ?? "0.00");
  });

  it("routes money calculations without the retired float helpers", () => {
    const source = readFileSync(resolve("routes/marketplace/account-payment-new.tsx"), "utf8");
    expect(source).not.toMatch(/parseFloat|toFixed|decimalMoney|parseMoneyAmount/);
  });

  it.each(["abc", "1.0", "01.00", "1.234"])("rejects a non-canonical order amount (%s)", async (amount) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/order-inputs")) {
          return Promise.resolve(jsonResponse({ orders: [{ ...buildPurchase("ord_1"), total_amount: amount }] }));
        }
        if (url.includes("/settlement/wallet")) return Promise.resolve(jsonResponse({}, 503));
        if (url.includes("/checkout/status")) return Promise.resolve(jsonResponse(checkoutStatus));
        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );
    await expect(
      loader({
        request: new Request("http://localhost/account/payments/new?orderIds=ord_1"),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toThrow("Order amounts must be canonical money amounts.");
  });

  it.each(["abc", "10.30junk"])("treats an unparseable hidden total as zero (%s)", async (total) => {
    const statusRequests: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.includes("/checkout/status")) {
          statusRequests.push(new URL(url));
          return Promise.resolve(jsonResponse(checkoutStatus));
        }
        return Promise.resolve(jsonResponse(createdPayment, 201));
      }),
    );
    const response = await action({
      request: new Request("http://localhost/account/payments/new", {
        method: "POST",
        body: new URLSearchParams({
          orderIds: "ord_1",
          balanceCreditMode: "max",
          totalAmount: total,
          availableBalance: "12.50",
        }),
      }),
      params: {},
      context: undefined,
    } as never);
    expect(response).toBeInstanceOf(Response);
    expect(statusRequests).toHaveLength(1);
    expect(statusRequests[0]?.searchParams.get("requestedBalanceCreditAmount")).toBe("0.00");
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
    expect(screen.getByRole("region", { name: "Checkout" }).textContent).toContain("$22.60");
    expect(screen.getByText("Ready to initialize payment")).toBeTruthy();

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[1]).toEqual({ method: "post" });
    expect(submit.mock.calls[0]?.[0]).toBeInstanceOf(HTMLFormElement);
  });

  it("raises the payment setup host and outlines the evidence, fee quote, and purchase entities", () => {
    mockUseLoaderData.mockReturnValue({
      orderIds: ["ord_1"],
      orders: [
        {
          ...buildPurchase("ord_1"),
          listing_evidence: [
            {
              line_id: "line_1",
              item_title: "Evidence card",
              gallery: [
                { altText: "Front", assets: [{ role: "catalog-detail", publicUrl: "https://img.test/front.jpg" }] },
              ],
            },
          ],
        },
      ],
      autostart: false,
      wallet: null,
      checkoutStatus,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentNewRoute />
      </ChaseRoot>,
    );

    expectSurfaceTreatment(screen.getByText("Ready to initialize payment"), "elevated", true);
    expectSurfaceTreatment(screen.getByText("Evidence card"), "outlined");
    expectSurfaceTreatment(screen.getByText("Base card checkout fee"), "outlined");
    expectSurfaceTreatment(screen.getByRole("link", { name: "Open purchase" }), "outlined");
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
            jsonResponse(createdPayment, 201, {
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
