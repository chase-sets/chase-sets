// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import type { ComponentProps } from "react";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockRequireActorFromAuthApi, mockUseActionData, mockUseLoaderData } = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
  mockUseActionData: vi.fn(),
  mockUseLoaderData: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");

  return {
    ...actual,
    Form: (props: ComponentProps<"form">) => <form {...props} />,
    useActionData: mockUseActionData,
    useLoaderData: mockUseLoaderData,
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
