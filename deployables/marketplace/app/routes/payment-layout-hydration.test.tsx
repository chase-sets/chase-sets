// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StripePaymentElementMock = Readonly<{
  mount: (target: HTMLElement | string) => void;
  destroy: () => void;
}>;

type StripeWindow = Window &
  typeof globalThis & {
    Stripe?: ReturnType<typeof vi.fn>;
  };

const {
  mockUseActionData,
  mockUseLoaderData,
  mockUseLocation,
  mockUseNavigate,
  mockUseRevalidator,
  mockUseRouteLoaderData,
} = vi.hoisted(() => ({
  mockUseActionData: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseLocation: vi.fn(),
  mockUseNavigate: vi.fn(),
  mockUseRevalidator: vi.fn(),
  mockUseRouteLoaderData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    ...actual,
    Form: ({ children, ...props }: { children: ReactNode }) => React.createElement("form", props, children),
    Outlet: () => <MarketplaceAccountPaymentRoute />,
    useActionData: mockUseActionData,
    useLoaderData: mockUseLoaderData,
    useLocation: mockUseLocation,
    useNavigate: () => mockUseNavigate,
    useRevalidator: mockUseRevalidator,
    useRouteLoaderData: mockUseRouteLoaderData,
  };
});

import { MemoryRouter } from "react-router";
import MarketplaceAccountPaymentRoute from "@chase-sets/payments/routes/marketplace/account-payment";
import MarketplaceLayoutRoute from "./layout";

const actor = {
  permissions: ["accounts.view", "offers.view", "orders.view", "orders.manage", "payouts.view", "reputation.view"],
};

const actorDisplay = {
  account: {
    account_id: "acc_buyer",
    display_name: "M47 Buyer m47psmqqjprwn",
    name: "M47 Buyer m47psmqqjprwn",
    badges: [],
  },
  membership: {
    membership_id: "mbr_buyer",
    role_key: "owner",
  },
  user: {
    user_id: "usr_buyer",
    display_name: "M47 Buyer",
    primary_email: "buyer@example.com",
  },
};

function buildPayment(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: "pay_01KW21Q91VFWDXNMKNA0HRK0CQ",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "11.50",
    balance_credit_amount: "0.00",
    processor_amount: "11.50",
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.50",
    marketplace_checkout_fee_policy_version: "mcf_2026_04",
    marketplace_checkout_fee_quote_fingerprint: "fee_quote_1",
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "9.50",
    seller_payout_amount: "9.50",
    seller_payouts: [],
    currency_code: "USD",
    processor_name: "stripe",
    processor_payment_kind: "checkout-session",
    processor_payment_reference: "cs_live_123",
    processor_client_secret: "cs_live_123_secret_456",
    processor_redirect_url: null,
    processor_status: "requires_payment_method",
    source_context: "checkout",
    source_reference_id: "chk_1",
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-06-26T15:53:08.000Z",
    updated_at: "2026-06-26T15:53:08.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
    processor_publishable_key: "pk_test_123",
    provider_events: [],
    ...overrides,
  };
}

describe("marketplace payment layout hydration", () => {
  let paymentElement: StripePaymentElementMock;

  beforeEach(() => {
    paymentElement = {
      mount: vi.fn((target: HTMLElement | string) => {
        const element = typeof target === "string" ? document.querySelector(target) : target;
        element?.appendChild(document.createElement("iframe")).setAttribute("title", "Secure payment input frame");
      }),
      destroy: vi.fn(),
    };
    mockUseActionData.mockReturnValue(null);
    mockUseLoaderData.mockReturnValue({
      payment: buildPayment(),
      orders: [{ order_id: "ord_1", status: "pending-payment", total_amount: "11.00", seller_payout_amount: "9.50" }],
      isGuestCheckoutPayment: false,
      guestClaimContext: null,
      showSupportDetails: false,
      buyerEmail: "buyer@example.com",
    });
    mockUseLocation.mockReturnValue({
      pathname: "/account/payments/pay_01KW21Q91VFWDXNMKNA0HRK0CQ",
      search: "",
    });
    mockUseRouteLoaderData.mockReturnValue({
      actor,
      actorDisplay,
      cartCount: 0,
    });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    (window as StripeWindow).Stripe = vi.fn(() => ({
      initCheckoutElementsSdk: vi.fn(() => ({
        createPaymentElement: vi.fn(() => paymentElement),
        loadActions: vi.fn().mockResolvedValue({
          type: "success",
          actions: { confirm: vi.fn() },
        }),
      })),
      elements: vi.fn(),
      confirmPayment: vi.fn(),
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    delete (window as StripeWindow).Stripe;
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("keeps the account menu interactive after hydrating a mounted Stripe payment surface", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // DiscoveryShellLayout registers the DS RouterLinkAdapter, so both the SSR pass
    // and hydration need router context — exactly as they have in the production app.
    const route = (
      <MemoryRouter>
        <MarketplaceLayoutRoute />
      </MemoryRouter>
    );
    const container = document.createElement("div");
    let root: Root | undefined;

    container.innerHTML = renderToString(route);
    document.body.appendChild(container);

    try {
      await act(async () => {
        root = hydrateRoot(container, route);
      });

      await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
      expect(screen.getByTitle("Secure payment input frame")).toBeTruthy();

      const trigger = screen.getAllByRole("button", { name: "Account menu" }).find((button) => {
        const text = button.textContent ?? "";
        return text.includes("M47 Buyer m47psmqqjprwn");
      });
      expect(trigger).toBeTruthy();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(trigger!);

      expect(await screen.findByRole("group", { name: "Color theme" })).toBeTruthy();
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
      expect(
        consoleError.mock.calls.some((call) =>
          call.some((entry) => {
            const message = String(entry).toLowerCase();

            return message.includes("hydration") || message.includes("react error #418");
          }),
        ),
      ).toBe(false);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      consoleError.mockRestore();
    }
  });
});
