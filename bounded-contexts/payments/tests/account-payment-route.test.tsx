// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";

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
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  seller_payout_amount: string;
  status: string;
  payment_deadline_at: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  ready_for_fulfillment_at: string | null;
  shipping_destination_snapshot: {
    name: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    email?: string | null;
  };
  line_count: number;
  total_quantity: number;
  lines: readonly unknown[];
  inventory_holds: readonly unknown[];
}>;

type PaymentsPaymentDetail = Readonly<{
  payment_id: string;
  buyer_account_id: string;
  order_ids: readonly string[];
  amount: string;
  currency_code: string;
  processor_name: string;
  processor_payment_kind: "checkout-session" | "payment-intent" | "balance-credit";
  processor_payment_reference: string;
  processor_amount: string;
  processor_client_secret: string | null;
  processor_redirect_url: string | null;
  processor_status: string;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  captured_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  processor_publishable_key: string | null;
  provider_events: readonly {
    provider_event_id: string;
    provider_name: string;
    event_kind: string;
    provider_object_reference: string | null;
    received_at: string;
  }[];
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  balance_credit_amount: string;
  seller_payout_amount: string;
}>;

type StripeMock = ReturnType<typeof vi.fn>;
type StripeWindow = Window &
  typeof globalThis & {
    Stripe?: StripeMock;
  };

type StripeAppearanceMock = Readonly<{
  theme: string;
  variables: Readonly<Record<string, string>>;
  rules?: Readonly<Record<string, unknown>>;
}>;

type StripeElementsOptionsMock = Readonly<{
  clientSecret: string;
  appearance: StripeAppearanceMock;
}>;

type StripeCheckoutOptionsMock = Readonly<{
  clientSecret: string;
  elementsOptions: {
    appearance: StripeAppearanceMock;
  };
}>;

const walletElementOptions = {
  wallets: {
    applePay: "auto",
    googlePay: "auto",
  },
};

const { mockUseActionData, mockUseLoaderData, mockUseRevalidator } = vi.hoisted(() => ({
  mockUseActionData: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseRevalidator: vi.fn(),
}));

const platformFeedbackPromptProps = vi.hoisted(() => ({
  calls: [] as unknown[],
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    Form: ({ children, ...props }: { children: ReactNode }) => React.createElement("form", props, children),
    useActionData: mockUseActionData,
    useLoaderData: mockUseLoaderData,
    useRevalidator: mockUseRevalidator,
  };
});

vi.mock("@chase-sets/platform-operations/web", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    PlatformFeedbackPrompt: (props: unknown) => {
      platformFeedbackPromptProps.calls.push(props);
      return React.createElement("section", { "data-testid": "platform-feedback-prompt" });
    },
  };
});

import MarketplaceAccountPaymentRoute from "../routes/marketplace/account-payment";

function buildPurchase(overrides: Partial<PurchaseDetail> = {}): PurchaseDetail {
  return {
    order_id: "ord_1",
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
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.50",
    seller_net_amount: "9.50",
    seller_payout_amount: "9.50",
    status: "pending-payment",
    payment_deadline_at: null,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    cancelled_at: null,
    ready_for_fulfillment_at: null,
    shipping_destination_snapshot: {
      name: "Buyer",
      line1: "1 Main St",
      city: "Maize",
      state: "KS",
      postalCode: "67101",
      country: "US",
      email: "buyer@example.com",
    },
    line_count: 1,
    total_quantity: 1,
    lines: [],
    inventory_holds: [],
    ...overrides,
  };
}

function buildPayment(overrides: Partial<PaymentsPaymentDetail> = {}): PaymentsPaymentDetail {
  return {
    payment_id: "pay_1",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "11.00",
    currency_code: "USD",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_123",
    processor_amount: "11.00",
    processor_client_secret: null,
    processor_redirect_url: null,
    processor_status: "requires_payment_method",
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
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.50",
    seller_net_amount: "9.50",
    balance_credit_amount: "0.00",
    seller_payout_amount: "9.50",
    ...overrides,
  };
}

async function findEnabledButton(name: string) {
  const buttons = await screen.findAllByRole("button", { name });

  await waitFor(() => expect(buttons.some((button) => !button.hasAttribute("disabled"))).toBe(true));

  const button = buttons.find((candidate) => !candidate.hasAttribute("disabled"));
  expect(button).toBeTruthy();
  return button!;
}

describe("marketplace account payment route", () => {
  beforeEach(() => {
    mockUseActionData.mockReturnValue(null);
    mockUseRevalidator.mockReturnValue({
      revalidate: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    platformFeedbackPromptProps.calls = [];
    delete (window as StripeWindow).Stripe;
    document.head.innerHTML = "";
  });

  it("renders the captured payment summary and linked purchases", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [
        buildPurchase({
          status: "ready-for-fulfillment",
          ready_for_fulfillment_at: "2026-04-01T00:05:00.000Z",
        }),
      ],
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Payment pay_1")).toBeTruthy();
    expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$11.00").length).toBeGreaterThan(0);
    expect(screen.getByText("ready-for-fulfillment")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open purchase" })).toBeTruthy();
    expect(screen.queryByText("Confirm payment")).toBeNull();
    expect(screen.getByTestId("platform-feedback-prompt")).toBeTruthy();
    expect(platformFeedbackPromptProps.calls[0]).toMatchObject({
      workflow: "checkout-payment",
      sourceRoutePath: "/account/payments/pay_1",
      relatedEntities: [
        { type: "payment", id: "pay_1" },
        { type: "order", id: "ord_1" },
      ],
    });
  });

  it("renders payment deadline guidance for pending confirmations", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "pending-confirmation",
      }),
      orders: [
        buildPurchase({
          payment_deadline_at: "2026-04-01T01:00:00.000Z",
        }),
      ],
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Complete payment by deadline")).toBeTruthy();
  });

  it("shows checkout feedback for zero-dollar completed outcomes but not unresolved or failed statuses", () => {
    for (const status of ["pending-confirmation", "failed", "cancelled"]) {
      cleanup();
      platformFeedbackPromptProps.calls = [];
      mockUseLoaderData.mockReturnValue({
        payment: buildPayment({
          status,
          processor_amount: "0.00",
        }),
        orders: [buildPurchase()],
        isGuestCheckoutPayment: false,
        showSupportDetails: false,
      });

      render(
        <ChaseRoot>
          <MarketplaceAccountPaymentRoute />
        </ChaseRoot>,
      );

      expect(screen.queryByTestId("platform-feedback-prompt")).toBeNull();
      expect(platformFeedbackPromptProps.calls).toHaveLength(0);
    }

    cleanup();
    platformFeedbackPromptProps.calls = [];
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_amount: "0.00",
      }),
      orders: [buildPurchase()],
      isGuestCheckoutPayment: false,
      showSupportDetails: false,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByTestId("platform-feedback-prompt")).toBeTruthy();
    expect(platformFeedbackPromptProps.calls[0]).toMatchObject({
      workflow: "checkout-payment",
      sourceRoutePath: "/account/payments/pay_1",
    });
  });

  it("hydrates payment timelines without locale-dependent timestamp text", async () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
        provider_events: [
          {
            provider_event_id: "evt_1",
            provider_name: "stripe",
            event_kind: "payment-captured",
            provider_object_reference: "pi_123",
            received_at: "2026-04-01T00:04:00.000Z",
          },
        ],
      }),
      orders: [
        buildPurchase({
          status: "ready-for-fulfillment",
          ready_for_fulfillment_at: "2026-04-01T00:05:00.000Z",
        }),
      ],
      isGuestCheckoutPayment: false,
      showSupportDetails: true,
    });
    const dateLocaleString = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockImplementation(() => "server locale timestamp");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = (
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>
    );
    const container = document.createElement("div");
    let root: Root | undefined;

    container.innerHTML = renderToString(route);
    dateLocaleString.mockImplementation(() => "client locale timestamp");
    document.body.appendChild(container);

    try {
      await act(async () => {
        root = hydrateRoot(container, route);
      });

      expect(dateLocaleString).not.toHaveBeenCalled();
      expect(screen.getAllByText("Apr 1, 2026, 12:00 AM UTC").length).toBeGreaterThan(0);
      expect(screen.getByText("Apr 1, 2026, 12:04 AM UTC")).toBeTruthy();
      expect(screen.getAllByText("Apr 1, 2026, 12:05 AM UTC").length).toBeGreaterThan(0);
      expect(
        consoleError.mock.calls.some((call) => call.some((entry) => String(entry).toLowerCase().includes("hydration"))),
      ).toBe(false);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      consoleError.mockRestore();
      dateLocaleString.mockRestore();
    }
  });

  it("renders a retry path when Stripe reports a failed payment", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "failed",
        processor_status: "requires_payment_method",
        failure_message: "Card was declined.",
        failed_at: "2026-04-01T00:04:00.000Z",
        order_ids: ["ord_1", "ord_2"],
      }),
      orders: [buildPurchase(), buildPurchase({ order_id: "ord_2" })],
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Card was declined.")).toBeTruthy();
    const retryLink = screen.getByRole("link", { name: "Retry payment" });
    expect(retryLink.getAttribute("href")).toBe("/account/payments/new?orderIds=ord_1%2Cord_2");
  });

  it("renders guest retry errors beside the retry form", () => {
    mockUseActionData.mockReturnValue({
      scope: "retry",
      error: "Fee quote changed.",
    });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "failed",
        processor_status: "requires_payment_method",
        failure_message: "Card was declined.",
        failed_at: "2026-04-01T00:04:00.000Z",
      }),
      orders: [buildPurchase()],
      isGuestCheckoutPayment: true,
      guestClaimContext: null,
      showSupportDetails: false,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Could not retry payment")).toBeTruthy();
    expect(screen.getByText("Fee quote changed.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry payment" }).length).toBeGreaterThan(0);
  });

  it("renders guest retry when a failed payment has no processor message", () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "failed",
        processor_status: "requires_payment_method",
        failure_message: null,
        failed_at: "2026-04-01T00:04:00.000Z",
      }),
      orders: [buildPurchase()],
      isGuestCheckoutPayment: true,
      guestClaimContext: null,
      showSupportDetails: false,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getAllByText("The secure processor could not complete this payment.").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Retry payment" }).length).toBeGreaterThan(0);
  });

  it("does not render manual guest claim token entry when no gated local token is present", () => {
    mockUseActionData.mockReturnValue({
      status: "claim-link-sent",
      token: null,
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [buildPurchase({ status: "paid" })],
      isGuestCheckoutPayment: true,
      guestClaimContext: {
        accountId: "acc_guest",
        paymentId: "pay_1",
        contactEmail: "jane@example.com",
        contactName: "Jane Smith",
      },
      showSupportDetails: false,
      buyerEmail: null,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Save this order")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Email me a claim link" })).toBeTruthy();
    expect(screen.queryByLabelText("Claim token")).toBeNull();
    expect(screen.queryByText("Local recovery token. In production this arrives by email.")).toBeNull();
  });

  it("renders manual guest claim token entry only when action data carries a gated local token", () => {
    mockUseActionData.mockReturnValue({
      status: "claim-link-sent",
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        status: "captured",
        processor_status: "succeeded",
        captured_at: "2026-04-01T00:05:00.000Z",
      }),
      orders: [buildPurchase({ status: "paid" })],
      isGuestCheckoutPayment: true,
      guestClaimContext: {
        accountId: "acc_guest",
        paymentId: "pay_1",
        contactEmail: "jane@example.com",
        contactName: "Jane Smith",
      },
      showSupportDetails: false,
      buyerEmail: null,
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    expect(screen.getByLabelText("Claim token")).toHaveProperty("value", "magic_token");
    expect(screen.getByText("Local recovery token. In production this arrives by email.")).toBeTruthy();
  });

  it("confirms a pending Stripe payment and revalidates afterward", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const elementsCreate = vi.fn(() => paymentElement);
    const elements = vi.fn((_options: StripeElementsOptionsMock) => ({
      create: elementsCreate,
    }));
    const confirmPayment = vi.fn().mockResolvedValue({});
    const revalidate = vi.fn();

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
      buyerEmail: "buyer@example.com",
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements,
      confirmPayment,
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await findEnabledButton("Confirm payment");
    fireEvent.click(button);

    await waitFor(() =>
      expect(confirmPayment).toHaveBeenCalledWith({
        elements: expect.any(Object),
        redirect: "if_required",
      }),
    );

    await waitFor(() => expect(revalidate).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(elements).toHaveBeenCalledWith({
      clientSecret: "pi_secret_123",
      appearance: expect.objectContaining({
        theme: "flat",
        variables: expect.objectContaining({
          colorPrimary: "#1d5fd6",
          colorText: "#0f172a",
        }),
        rules: expect.objectContaining({
          ".Input": expect.objectContaining({
            color: "#0f172a",
          }),
        }),
      }),
    });
    expect(elementsCreate).toHaveBeenCalledWith("payment", {
      ...walletElementOptions,
      defaultValues: {
        billingDetails: {
          email: "buyer@example.com",
        },
      },
    });
    expect(paymentElement.mount).toHaveBeenCalled();
  });

  it("loads versioned Stripe.js for Checkout Sessions", async () => {
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "cs_live_123_secret_456",
        processor_publishable_key: "pk_live_123",
        processor_payment_kind: "checkout-session",
      }),
      orders: [buildPurchase()],
      buyerEmail: "buyer@example.com",
    });

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await waitFor(() =>
      expect(document.querySelector<HTMLScriptElement>('script[data-stripe-js="true"]')?.src).toBe(
        "https://js.stripe.com/dahlia/stripe.js",
      ),
    );
  });

  it("confirms a pending Checkout Session with loaded Checkout actions", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const confirm = vi.fn().mockResolvedValue({});
    const createPaymentElement = vi.fn(() => paymentElement);
    const initCheckoutElementsSdk = vi.fn((_options: StripeCheckoutOptionsMock) => ({
      createPaymentElement,
      loadActions: vi.fn().mockResolvedValue({
        type: "success",
        actions: { confirm },
      }),
    }));
    const revalidate = vi.fn();

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "cs_live_123_secret_456",
        processor_publishable_key: "pk_live_123",
        processor_payment_kind: "checkout-session",
      }),
      orders: [buildPurchase()],
      buyerEmail: "buyer@example.com",
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      initCheckoutElementsSdk,
      elements: vi.fn(),
      confirmPayment: vi.fn(),
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await findEnabledButton("Confirm payment");
    fireEvent.click(button);

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({
        redirect: "if_required",
        email: "buyer@example.com",
      }),
    );

    await waitFor(() => expect(revalidate).toHaveBeenCalled(), {
      timeout: 1000,
    });
    const initCheckoutOptions = initCheckoutElementsSdk.mock.calls[0]?.[0];
    expect(initCheckoutOptions).toMatchObject({
      clientSecret: "cs_live_123_secret_456",
      elementsOptions: {
        appearance: {
          theme: "flat",
          variables: expect.objectContaining({
            colorPrimary: "#1d5fd6",
            colorText: "#0f172a",
          }),
        },
      },
    });
    expect(initCheckoutOptions?.elementsOptions.appearance.rules).toBeUndefined();
    expect(createPaymentElement).toHaveBeenCalledWith({
      ...walletElementOptions,
      defaultValues: {
        billingDetails: {
          email: "buyer@example.com",
        },
      },
    });
    expect(paymentElement.mount).toHaveBeenCalled();
  });

  it("updates the Payment Element appearance in place when the scoped theme changes", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const create = vi.fn(() => paymentElement);
    const update = vi.fn();
    const elements = vi.fn((_options: StripeElementsOptionsMock) => ({
      create,
      update,
    }));

    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements,
      confirmPayment: vi.fn(),
    }));

    const { rerender } = render(
      <ChaseRoot theme={{ colors: { foreground: "#111111" } }}>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());

    rerender(
      <ChaseRoot theme={{ colors: { foreground: "#eeeeee" } }}>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        appearance: expect.objectContaining({
          variables: expect.objectContaining({ colorText: "#eeeeee" }),
        }),
      }),
    );

    expect(paymentElement.destroy).not.toHaveBeenCalled();
    expect(elements).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(elements.mock.calls[0]?.[0].appearance.variables.colorText).toBe("#111111");
  });

  it("restyles a Checkout Session element in place when the scoped theme changes", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const changeAppearance = vi.fn();
    const initCheckoutElementsSdk = vi.fn((_options: StripeCheckoutOptionsMock) => ({
      createPaymentElement: vi.fn(() => paymentElement),
      loadActions: vi.fn().mockResolvedValue({
        type: "success",
        actions: { confirm: vi.fn() },
      }),
      changeAppearance,
    }));

    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "cs_live_123_secret_456",
        processor_publishable_key: "pk_live_123",
        processor_payment_kind: "checkout-session",
      }),
      orders: [buildPurchase()],
      buyerEmail: "buyer@example.com",
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      initCheckoutElementsSdk,
      elements: vi.fn(),
      confirmPayment: vi.fn(),
    }));

    const { rerender } = render(
      <ChaseRoot theme={{ colors: { foreground: "#111111" } }}>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    await findEnabledButton("Confirm payment");

    rerender(
      <ChaseRoot theme={{ colors: { foreground: "#eeeeee" } }}>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await waitFor(() =>
      expect(changeAppearance).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({ colorText: "#eeeeee" }),
        }),
      ),
    );

    expect(paymentElement.destroy).not.toHaveBeenCalled();
    expect(initCheckoutElementsSdk).toHaveBeenCalledTimes(1);
  });

  it("surfaces a rejected confirm() as a styled danger alert and re-enables retry", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const confirmPayment = vi.fn().mockRejectedValue(new Error("Network dropped mid-confirm."));
    const revalidate = vi.fn();

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
        update: vi.fn(),
      })),
      confirmPayment,
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await findEnabledButton("Confirm payment");
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Payment issue");
    expect(alert.textContent).toContain("Network dropped mid-confirm.");
    expect(revalidate).not.toHaveBeenCalled();
    await findEnabledButton("Confirm payment");
  });

  it("falls back to processor copy when confirm() rejects without a message", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const confirmPayment = vi.fn().mockRejectedValue(new Error(""));

    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
        update: vi.fn(),
      })),
      confirmPayment,
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await findEnabledButton("Confirm payment");
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The secure processor could not complete this payment.");
  });

  it("renders decline messages inside a danger alert", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const confirmPayment = vi.fn().mockResolvedValue({ error: { message: "Your card was declined." } });

    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
        update: vi.fn(),
      })),
      confirmPayment,
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await findEnabledButton("Confirm payment");
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your card was declined.");
    await findEnabledButton("Confirm payment");
  });

  it("keeps the form locked after a successful confirm until webhook truth lands", async () => {
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    let resolveConfirm: (value: { error?: { message?: string } }) => void = () => {};
    const confirmPayment = vi.fn(
      () =>
        new Promise<{ error?: { message?: string } }>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    const revalidate = vi.fn();

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
        update: vi.fn(),
      })),
      confirmPayment,
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    const button = await findEnabledButton("Confirm payment");
    fireEvent.click(button);

    // While confirm is in flight the button is disabled; a second click is inert.
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);
    expect(confirmPayment).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm({});
    });

    // Confirm succeeded but the payment is still pending webhook truth: the
    // form stays locked instead of inviting a double submission.
    const processingButton = await screen.findByRole("button", { name: "Processing payment..." });
    expect(processingButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Payment in progress")).toBeTruthy();
    fireEvent.click(processingButton);
    expect(confirmPayment).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(revalidate).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(screen.queryByRole("button", { name: "Confirm payment" })).toBeNull();
  });

  it("backs off polling on errors instead of revalidating the route", async () => {
    vi.useFakeTimers();
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const revalidate = vi.fn();
    const fetchPayment = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("payments api blip"));

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
        update: vi.fn(),
      })),
      confirmPayment: vi.fn(),
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    // First poll at 2s fails.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchPayment).toHaveBeenCalledTimes(1);

    // Backoff doubles: the retry lands 4s later, not 2s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchPayment).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchPayment).toHaveBeenCalledTimes(2);

    // Next retry backs off to 8s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(fetchPayment).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchPayment).toHaveBeenCalledTimes(3);

    // Poll errors never trigger full-route revalidation.
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("stops polling after the max duration and leaves the tail to reconciliation", async () => {
    vi.useFakeTimers();
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const revalidate = vi.fn();
    const fetchPayment = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify(buildPayment()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
        update: vi.fn(),
      })),
      confirmPayment: vi.fn(),
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 2_000);
    });

    const pollCountAtCap = fetchPayment.mock.calls.length;
    expect(pollCountAtCap).toBeGreaterThan(0);
    expect(pollCountAtCap).toBeLessThanOrEqual(150);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchPayment).toHaveBeenCalledTimes(pollCountAtCap);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("polls only the payment while Stripe confirmation is pending", async () => {
    vi.useFakeTimers();
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const revalidate = vi.fn();
    const fetchPayment = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(buildPayment()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
      })),
      confirmPayment: vi.fn(),
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(fetchPayment).toHaveBeenCalledTimes(1);
    const requestedPayment = fetchPayment.mock.calls[0]?.[0];
    const requestedPaymentUrl =
      requestedPayment instanceof Request ? requestedPayment.url : requestedPayment?.toString();
    expect(requestedPaymentUrl).toContain("/api/marketplace/account/payments/pay_1");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("revalidates the route once the payment is no longer pending", async () => {
    vi.useFakeTimers();
    const paymentElement = {
      mount: vi.fn(),
      destroy: vi.fn(),
    };
    const revalidate = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          buildPayment({
            status: "captured",
            processor_status: "succeeded",
            captured_at: "2026-04-01T00:05:00.000Z",
          }),
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment({
        processor_client_secret: "pi_secret_123",
        processor_publishable_key: "pk_test_123",
      }),
      orders: [buildPurchase()],
    });

    (window as StripeWindow).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({
        create: vi.fn(() => paymentElement),
      })),
      confirmPayment: vi.fn(),
    }));

    render(
      <ChaseRoot>
        <MarketplaceAccountPaymentRoute />
      </ChaseRoot>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});
