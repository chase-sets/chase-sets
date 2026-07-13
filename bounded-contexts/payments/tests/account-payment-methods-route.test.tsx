// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import type { ComponentProps } from "react";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockRequireActorFromAuthApi, mockUseActionData, mockUseLoaderData, mockUseRevalidator } = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseRevalidator: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Form: (props: ComponentProps<"form">) => <form {...props} />,
    useActionData: mockUseActionData,
    useLoaderData: mockUseLoaderData,
    useRevalidator: mockUseRevalidator,
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

// @stripe/stripe-js caches its script-load promise at module scope so a real
// browser only ever injects one <script> tag per page. That singleton
// survives across `it()` blocks in this file, which would pin every test to
// whichever `window.Stripe` mock happened to load first. Route the loader
// through the live `window.Stripe` stub instead so each test's mock takes
// effect immediately, matching how the component behaves in a real browser
// where `window.Stripe` is genuinely stable per page load.
vi.mock("@stripe/stripe-js", () => ({
  loadStripe: (publishableKey: string) => {
    const factory = (window as unknown as { Stripe?: (key: string) => unknown }).Stripe;
    return Promise.resolve(factory ? factory(publishableKey) : null);
  },
}));

import AccountPaymentMethodsRoute, { action, loader } from "../routes/marketplace/account-payment-methods";

const cardMethod = {
  instrument_id: "sci_card",
  account_id: "acc_buyer",
  payment_method_category: "card" as const,
  provider: "stripe",
  display_label: "Visa ending in 4242",
  confirmation_experience: "off-session-token" as const,
  readiness: "ready" as const,
  allow_redisplay: "always" as const,
  is_default: true,
  consent_id: "consent_card",
  removed_at: null,
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
};

const bankMethod = {
  instrument_id: "sci_bank",
  account_id: "acc_buyer",
  payment_method_category: "bank-account" as const,
  provider: "stripe",
  display_label: "Bank ending in 6789",
  confirmation_experience: "off-session-token" as const,
  readiness: "ready" as const,
  allow_redisplay: "always" as const,
  is_default: false,
  consent_id: "consent_bank",
  removed_at: null,
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
};

const embeddedSetup = {
  setup_reference_id: "scs_embedded",
  processor_setup_reference: "seti_embedded",
  processor_client_secret: "seti_embedded_secret",
  processor_redirect_url: null,
  processor_status: "requires_payment_method",
  processor_publishable_key: "pk_test_123",
};

function requestMethod(input: string | URL | Request, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

describe("account payment methods route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "orders.manage"],
    });
    mockUseActionData.mockReturnValue(undefined);
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reconciles a returned setup session before loading the method list", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);
        calls.push(`${method} ${url}`);

        if (url.includes("/api/marketplace/account/payment-methods/setup-sessions/cs_setup_1/reconcile")) {
          return Promise.resolve(jsonResponse({ instrument: bankMethod }));
        }

        if (url.includes("/api/marketplace/account/payment-methods") && method === "GET") {
          return Promise.resolve(jsonResponse({ items: [cardMethod, { ...bankMethod, is_default: true }] }));
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${method} ${url}`));
      }),
    );

    const result = await loader({
      request: new Request("http://localhost/account/payment-methods?setupReferenceId=cs_setup_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.setupResult).toBe("saved");
    expect(result.paymentMethods).toContainEqual(expect.objectContaining({ instrument_id: "sci_bank" }));
    expect(calls[0]).toContain("/setup-sessions/cs_setup_1/reconcile");
    expect(calls[1]).toContain("/payment-methods");
  });

  it("returns a fresh method-list snapshot after setting a default method", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);

        if (url.includes("/api/marketplace/account/payment-methods/sci_bank/default") && method === "POST") {
          return Promise.resolve(jsonResponse({ ...bankMethod, is_default: true }));
        }

        if (url.includes("/api/marketplace/account/payment-methods") && method === "GET") {
          return Promise.resolve(
            jsonResponse({
              items: [
                { ...cardMethod, is_default: false },
                { ...bankMethod, is_default: true, updated_at: "2026-04-02T00:00:00.000Z" },
              ],
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${method} ${url}`));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "default");
    form.set("instrumentId", "sci_bank");

    const result = await action({
      request: new Request("http://localhost/account/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      paymentMethods: [
        expect.objectContaining({ instrument_id: "sci_card", is_default: false }),
        expect.objectContaining({ instrument_id: "sci_bank", is_default: true }),
      ],
    });
  });

  it("uses action snapshot data instead of stale loader methods after a mutation", () => {
    mockUseLoaderData.mockReturnValue({
      accountId: "acc_buyer",
      setupResult: null,
      paymentMethods: [cardMethod],
    });
    mockUseActionData.mockReturnValue({
      paymentMethods: [{ ...bankMethod, is_default: true }],
    });

    render(
      <ChaseRoot>
        <AccountPaymentMethodsRoute />
      </ChaseRoot>,
    );

    expect(screen.getByText("Bank ending in 6789")).toBeTruthy();
    expect(screen.queryByText("Visa ending in 4242")).toBeNull();
  });

  it("starts the embedded SetupIntent flow without redirecting", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);
        calls.push(`${method} ${url}`);

        if (url.endsWith("/account/payment-methods/setup-sessions") && method === "POST") {
          return Promise.resolve(jsonResponse(embeddedSetup, 201));
        }
        if (url.endsWith("/account/payment-methods") && method === "GET") {
          return Promise.resolve(jsonResponse({ items: [cardMethod] }));
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${method} ${url}`));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "add");
    const result = await action({
      request: new Request("http://localhost/account/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({ setup: embeddedSetup, paymentMethods: [cardMethod] });
    expect(calls).toEqual([
      "POST http://localhost/api/marketplace/account/payment-methods/setup-sessions",
      "GET http://localhost/api/marketplace/account/payment-methods",
    ]);
  });

  it("preserves the mounted setup element when the theme changes", async () => {
    const paymentElement = { mount: vi.fn(), destroy: vi.fn() };
    const update = vi.fn();
    const elements = { create: vi.fn(() => paymentElement), update };
    (window as unknown as { Stripe?: unknown }).Stripe = vi.fn(() => ({
      elements: vi.fn(() => elements),
      confirmSetup: vi.fn(),
    }));
    mockUseLoaderData.mockReturnValue({ accountId: "acc_buyer", setupResult: null, paymentMethods: [cardMethod] });
    mockUseActionData.mockReturnValue({ setup: embeddedSetup, paymentMethods: [cardMethod] });

    const { rerender } = render(
      <ChaseRoot theme={{ colors: { foreground: "#111111" } }}>
        <AccountPaymentMethodsRoute />
      </ChaseRoot>,
    );

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    rerender(
      <ChaseRoot theme={{ colors: { foreground: "#eeeeee" } }}>
        <AccountPaymentMethodsRoute />
      </ChaseRoot>,
    );

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ appearance: expect.objectContaining({ variables: expect.any(Object) }) }),
      ),
    );
    expect(paymentElement.destroy).not.toHaveBeenCalled();
  });

  it("guards setup confirmation against double-submit and wires a saved instrument", async () => {
    const paymentElement = { mount: vi.fn(), destroy: vi.fn() };
    const confirmSetup = vi.fn().mockResolvedValue({});
    const revalidate = vi.fn();
    mockUseRevalidator.mockReturnValue({ revalidate });
    (window as unknown as { Stripe?: unknown }).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({ create: vi.fn(() => paymentElement), update: vi.fn() })),
      confirmSetup,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);
        if (url.includes("/setup-sessions/scs_embedded/reconcile") && method === "POST") {
          return Promise.resolve(jsonResponse({ instrument: bankMethod }));
        }
        return Promise.reject(new Error(`Unexpected fetch request: ${method} ${url}`));
      }),
    );
    mockUseLoaderData.mockReturnValue({ accountId: "acc_buyer", setupResult: null, paymentMethods: [cardMethod] });
    mockUseActionData.mockReturnValue({ setup: embeddedSetup, paymentMethods: [cardMethod] });

    render(
      <ChaseRoot>
        <AccountPaymentMethodsRoute />
      </ChaseRoot>,
    );

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    const button = await screen.findByRole("button", { name: "Save payment method" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(confirmSetup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Payment method saved")).toBeTruthy());
    expect(revalidate).toHaveBeenCalled();
  });

  it("renders SetupIntent errors in the design-system danger banner and re-enables retry", async () => {
    const paymentElement = { mount: vi.fn(), destroy: vi.fn() };
    const confirmSetup = vi.fn().mockResolvedValue({ error: { message: "Your card was declined." } });
    (window as unknown as { Stripe?: unknown }).Stripe = vi.fn(() => ({
      elements: vi.fn(() => ({ create: vi.fn(() => paymentElement), update: vi.fn() })),
      confirmSetup,
    }));
    mockUseLoaderData.mockReturnValue({ accountId: "acc_buyer", setupResult: null, paymentMethods: [cardMethod] });
    mockUseActionData.mockReturnValue({ setup: embeddedSetup, paymentMethods: [cardMethod] });

    render(
      <ChaseRoot>
        <AccountPaymentMethodsRoute />
      </ChaseRoot>,
    );

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    const button = await screen.findByRole("button", { name: "Save payment method" });
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Payment issue");
    expect(alert.textContent).toContain("Your card was declined.");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });

  it("renders the reconciliation snapshot returned by the Payments API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const method = requestMethod(input, init);

        if (url.includes("/api/marketplace/account/payment-methods/reconcile") && method === "POST") {
          return Promise.resolve(
            jsonResponse({
              checked: 2,
              updated: 1,
              removed: 1,
              items: [
                cardMethod,
                { ...bankMethod, readiness: "removed" as const, removed_at: "2026-04-03T00:00:00.000Z" },
              ],
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${method} ${url}`));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "reconcile");

    const result = await action({
      request: new Request("http://localhost/account/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      paymentMethods: [
        expect.objectContaining({ instrument_id: "sci_card", readiness: "ready" }),
        expect.objectContaining({ instrument_id: "sci_bank", readiness: "removed" }),
      ],
    });
  });
});
