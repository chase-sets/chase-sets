// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../support/request-support/api-client";

vi.mock("@chase-sets/platform-runtime/realtime-web", () => ({
  subscribeRealtimePatches: vi.fn(() => ({ close: vi.fn() })),
}));

import CheckoutSessionRoute from "./checkout-session";

const SESSION_PATH = "/checkout/buy/session/chk_guest?paymentMethodCategory=card";

const session: CheckoutSessionRow = {
  session_id: "chk_guest",
  buyer_account_id: "acc_guest",
  source_type: "cart",
  optimization_goal: "lowest-total",
  fulfillment_preview_revision: "rev_1",
  fulfillment_preview_snapshot: null,
  shipping_option: "standard",
  shipping_address_id: null,
  shipping_address: null,
  lines: [
    {
      listingId: null,
      cartLineId: "cli_1",
      catalogItemId: "cat_charizard",
      productId: "prod_charizard_nm",
      itemTitle: "Charizard",
      itemSubtitle: "Base Set",
      selectedOptions: [],
      productSummary: "Form: Raw | Condition: Near Mint",
      quantity: 1,
      fulfillmentMode: "optimize",
      lockedListingId: null,
      sellerPreferenceId: null,
      availabilityState: "available",
    },
  ],
  order_ids: [],
  order_write_commit_positions: [],
  checkout_reservations: [],
  payment_id: null,
  submitted_offer_id: null,
  handoff_expires_at: null,
  created_at: "2026-05-06T00:00:00.000Z",
  updated_at: "2026-05-06T00:00:00.000Z",
};

const fulfillmentPreview: CheckoutFulfillmentPreview = {
  revision: "rev_1",
  optimizationGoal: "lowest-total",
  readyLineKeys: ["cli_1"],
  unavailableLineKeys: [],
  sellerGroups: [],
  totals: {
    itemSubtotalAmount: "389.00",
    shippingAmount: "0.00",
    salesTaxAmount: "0.00",
    totalAmount: "389.00",
    packageCount: 1,
  },
  unavailableLines: [],
  materialChangeReasons: [],
};

const paymentPreview = {
  currency_code: "usd",
  amount: "389.00",
  marketplace_checkout_fee: {
    marketplace_checkout_fee_amount: "11.67",
    marketplace_checkout_fee_reduction_amount: "0.00",
    total_amount: "400.67",
    processor_amount: "400.67",
    quote_fingerprint: "quote_1",
  },
  payment_method_quotes: [
    { payment_method_category: "card" as const, marketplace_checkout_fee_amount: "11.67", total_amount: "400.67" },
  ],
  wallet_credit: { requested_amount: "0.00", applied_amount: "0.00", external_amount: "400.67" },
};

type GuestContact =
  | { state: "bound"; contactEmail: string; contactName: string }
  | { state: "unbound" }
  | { state: "indeterminate"; reason: "rate-limited" | "unreadable" };

const BOUND: GuestContact = { state: "bound", contactName: "Jane Smith", contactEmail: "jane@example.com" };

function loaderData(guestContact: GuestContact) {
  return {
    session,
    wallet: null,
    walletUnavailable: false,
    paymentPreview,
    selectedPaymentMethodCategory: "card",
    savedShippingAddresses: [],
    savedCheckoutInstruments: [],
    guestContact,
    canManageShippingAddresses: false,
    canSavePaymentMethods: false,
    isSignedInBuyer: false,
    fulfillmentPreview,
    reservationUnavailableLines: [],
    previewError: null,
    reviewRefreshed: false,
    paymentQuoteRequired: false,
    initialEditSection: null,
    preparedPayment: null,
    paymentElementDefaultValues: null,
    deferredCardKey: null,
    paymentStartAmbiguous: false,
    expiredCheckout: false,
    paymentVerifyEmailHref: null,
  };
}

/** Renders the real route component with loader data and action data as the router holds them. */
function renderRoute(guestContact: GuestContact, actionData?: unknown, load?: () => GuestContact) {
  const router = createMemoryRouter(
    [
      {
        id: "checkout-session",
        path: "/checkout/buy/session/:sessionId",
        Component: CheckoutSessionRoute,
        loader: () => loaderData(load ? load() : guestContact),
        action: () => actionData ?? null,
      },
    ],
    {
      initialEntries: [SESSION_PATH],
      hydrationData: {
        loaderData: { "checkout-session": loaderData(guestContact) },
        ...(actionData ? { actionData: { "checkout-session": actionData } } : {}),
      },
    },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function input(name: string) {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]:not([type="hidden"])`);
}

function payButtons() {
  return screen.getAllByRole("button", { name: new RegExp(t("checkout.features.sessions.ui.checkoutPage.pay.now")) });
}

afterEach(() => {
  cleanup();
});

describe("checkout session route: guest contact", () => {
  it("renders the collision state with editable fields, an invalid email marker, and the exact return-path sign-in href", () => {
    renderRoute(
      { state: "unbound" },
      {
        guestContactAttempt: {
          contactName: "Jane Smith",
          contactEmail: "member@example.com",
          problem: "sign-in-required",
        },
      },
    );

    expect(input("contactName")?.value).toBe("Jane Smith");
    expect(input("contactName")?.readOnly).toBe(false);
    expect(input("shippingEmail")?.value).toBe("member@example.com");
    expect(input("shippingEmail")?.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.contact.sign.in.required"))).toBeTruthy();
    const signIn = screen.getByRole("link", { name: t("checkout.features.sessions.ui.checkoutPage.contact.sign.in") });
    expect(signIn.getAttribute("href")).toBe(`/sign-in?returnTo=${encodeURIComponent(SESSION_PATH)}`);
  });

  it("keeps both attempted contact values editable after a bind limiter 429", () => {
    renderRoute(
      { state: "unbound" },
      { guestContactAttempt: { contactName: "Jane Smith", contactEmail: "jane@example.com", problem: "retry-later" } },
    );

    expect(input("contactName")?.value).toBe("Jane Smith");
    expect(input("shippingEmail")?.value).toBe("jane@example.com");
    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.contact.retry.later"))).toBeTruthy();
    expect(screen.queryByText(t("checkout.features.sessions.ui.checkoutPage.contact.unavailable.title"))).toBeNull();
    for (const button of payButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("renders the immutable bound contact row with both authoritative values", () => {
    renderRoute(BOUND);

    expect(screen.getByText("Jane Smith")).toBeTruthy();
    expect(screen.getByText("jane@example.com")).toBeTruthy();
    expect(input("contactName")).toBeNull();
    expect(input("shippingEmail")).toBeNull();
    expect(
      screen.queryByRole("button", { name: t("checkout.features.sessions.ui.checkoutPage.edit.contact") }),
    ).toBeNull();
  });

  it("shows the locked guidance beside the retained bound contact", () => {
    renderRoute({ state: "unbound" }, { guestContact: BOUND, guestContactLocked: true });

    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.contact.locked"))).toBeTruthy();
    expect(screen.getByText("jane@example.com")).toBeTruthy();
    expect(input("contactName")).toBeNull();
  });

  it("renders the non-editable unavailable state with no contact inputs and no confirmation", () => {
    renderRoute({ state: "indeterminate", reason: "unreadable" });

    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.contact.unavailable.title"))).toBeTruthy();
    expect(input("contactName")).toBeNull();
    expect(document.querySelector('input[name="shippingEmail"]')).toBeNull();
    expect(screen.queryByText("jane@example.com")).toBeNull();
    for (const button of payButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("restores the immutable bound row after a later successful read", async () => {
    let current: GuestContact = { state: "indeterminate", reason: "rate-limited" };
    const router = renderRoute(current, undefined, () => current);
    expect(screen.getByText(t("checkout.features.sessions.ui.checkoutPage.contact.unavailable.title"))).toBeTruthy();

    current = BOUND;
    await router.revalidate();

    await waitFor(() => expect(screen.getByText("jane@example.com")).toBeTruthy(), { timeout: 5_000 });
    expect(screen.queryByText(t("checkout.features.sessions.ui.checkoutPage.contact.unavailable.title"))).toBeNull();
    for (const button of payButtons()) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("renders every contact state without a missing-translation marker", () => {
    const states: ReadonlyArray<readonly [GuestContact, unknown]> = [
      [
        { state: "unbound" },
        { guestContactAttempt: { contactName: "J", contactEmail: "m@example.com", problem: "sign-in-required" } },
      ],
      [
        { state: "unbound" },
        { guestContactAttempt: { contactName: "J", contactEmail: "m@example.com", problem: "retry-later" } },
      ],
      [{ state: "unbound" }, { guestContactAttempt: { contactName: "", contactEmail: "", problem: "invalid" } }],
      [{ state: "unbound" }, { guestContact: BOUND, guestContactLocked: true }],
      [BOUND, undefined],
      [{ state: "unbound" }, undefined],
      [{ state: "indeterminate", reason: "rate-limited" }, undefined],
    ];
    for (const [guestContact, actionData] of states) {
      renderRoute(guestContact, actionData);
      const text = document.body.textContent ?? "";
      expect(text).not.toContain("[missing:");
      expect(text).not.toContain("checkout.features.sessions.ui.checkoutPage.contact");
      cleanup();
    }
  });
});
