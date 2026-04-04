import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import type { OrderingOrderDetail } from "@chase-sets/ordering/client";
import type { ComponentProps } from "react";
import { jsonResponse, requestUrl } from "./test-support/http";

const {
  mockUseActionData,
  mockUseLoaderData,
  mockUseNavigation,
  mockUseSubmit,
  mockRequireActorFromAuthApi,
} = vi.hoisted(() => ({
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

vi.mock("@chase-sets/auth-runtime", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/auth-runtime")>(
    "@chase-sets/auth-runtime",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
  };
});

import MarketplaceAccountPaymentNewRoute, {
  action,
  loader,
} from "./account-payment-new";

function buildOrder(orderId: string): OrderingOrderDetail {
  return {
    order_id: orderId,
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
    total_amount: "11.00",
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

describe("marketplace account payment start route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(undefined);
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseSubmit.mockReturnValue(vi.fn());
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "orders.manage"],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("auto-submits the payment form when checkout redirects with autostart enabled", async () => {
    const submit = vi.fn();
    mockUseLoaderData.mockReturnValue({
      orderIds: ["ord_1", "ord_2"],
      orders: [buildOrder("ord_1"), buildOrder("ord_2")],
      autostart: true,
    });
    mockUseSubmit.mockReturnValue(submit);

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentNewRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Start payment")).toBeTruthy();
    expect(screen.getByText("Total due: $22.00")).toBeTruthy();

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0]?.[1]).toEqual({ method: "post" });
    expect(submit.mock.calls[0]?.[0]).toBeInstanceOf(HTMLFormElement);
  });

  it("loads checkout-created orders from the ordering API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = requestUrl(input);

        if (url.includes("/api/marketplace/buyer/orders/ord_1")) {
          return Promise.resolve(jsonResponse(buildOrder("ord_1")));
        }

        if (url.includes("/api/marketplace/buyer/orders/ord_2")) {
          return Promise.resolve(jsonResponse(buildOrder("ord_2")));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await loader({
      request: new Request(
        "http://localhost/account/payments/new?orderIds=ord_1,ord_2&autostart=1",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.orderIds).toEqual(["ord_1", "ord_2"]);
    expect(result.autostart).toBe(true);
    expect(result.orders.map((order) => order.order_id)).toEqual(["ord_1", "ord_2"]);
  });

  it("creates a buyer payment and redirects into the confirmation route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);

        if (
          url.includes("/api/marketplace/buyer/payments") &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        ) {
          return Promise.resolve(jsonResponse({ payment_id: "pay_1" }, 201));
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
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
  });
});
