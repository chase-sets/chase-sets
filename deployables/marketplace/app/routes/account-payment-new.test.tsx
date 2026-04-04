import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import type { OrderingOrderDetail } from "@chase-sets/ordering/web";
import type { ComponentProps } from "react";

const {
  mockUseActionData,
  mockUseLoaderData,
  mockUseNavigation,
  mockUseSubmit,
  mockRequireActorFromIdentityApi,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
} = vi.hoisted(() => ({
  mockUseActionData: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseSubmit: vi.fn(),
  mockRequireActorFromIdentityApi: vi.fn(),
  mockCreateOrderingRequestApiClient: vi.fn(),
  mockCreatePaymentsRequestApiClient: vi.fn(),
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

vi.mock("@chase-sets/ordering/client", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/ordering/client")>(
    "@chase-sets/ordering/client",
  );

  return {
    ...actual,
    createOrderingRequestApiClient: mockCreateOrderingRequestApiClient,
  };
});

vi.mock("@chase-sets/payments/client", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/payments/client")>(
    "@chase-sets/payments/client",
  );

  return {
    ...actual,
    createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
  };
});

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>(
    "@chase-sets/identity/server",
  );

  return {
    ...actual,
    requireActorFromIdentityApi: mockRequireActorFromIdentityApi,
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
    mockRequireActorFromIdentityApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "orders.manage"],
    });
  });

  afterEach(() => {
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
    const getBuyerOrder = vi
      .fn()
      .mockResolvedValueOnce(buildOrder("ord_1"))
      .mockResolvedValueOnce(buildOrder("ord_2"));

    mockCreateOrderingRequestApiClient.mockReturnValue({
      getBuyerOrder,
    });

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
    const createBuyerPayment = vi.fn().mockResolvedValue({
      payment_id: "pay_1",
    });

    mockCreatePaymentsRequestApiClient.mockReturnValue({
      createBuyerPayment,
    });

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

    expect(createBuyerPayment).toHaveBeenCalledWith({
      orderIds: ["ord_1", "ord_2"],
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/payments/pay_1");
  });
});
