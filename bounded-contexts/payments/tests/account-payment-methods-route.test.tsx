// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { jsonResponse, requestUrl } from "./test-support/http";

const { mockRequireActorFromAuthApi } = vi.hoisted(() => ({
  mockRequireActorFromAuthApi: vi.fn(),
}));

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
import { PaymentsApiError } from "../client";
import { classifySavedPaymentMethodAttemptFailure } from "../support/request-support/saved-payment-method-attempt";

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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requestMethod(input: string | URL | Request, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

type ApiCall = Readonly<{ method: string; path: string; body: Record<string, unknown> | null }>;
type Reply = Response | Promise<Response> | (() => Response | Promise<Response>);

/**
 * Stubs the Payments HTTP API behind the real client. `reply(call)` answers one mutation; GET
 * /payment-methods answers `list()`. Every call is recorded with its JSON body.
 */
function stubPaymentsApi(
  options: Readonly<{ list?: () => readonly unknown[]; reply?: (call: ApiCall) => Reply | undefined }>,
) {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = requestMethod(input, init);
      const path = new URL(requestUrl(input), "http://localhost").pathname.replace("/api/marketplace/account", "");
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const call = { method, path, body };
      calls.push(call);
      if (method === "GET" && path === "/payment-methods") {
        return jsonResponse({ items: options.list?.() ?? [cardMethod, bankMethod] });
      }
      const reply = options.reply?.(call);
      if (reply) return typeof reply === "function" ? reply() : reply;
      throw new Error(`Unexpected fetch request: ${method} ${path}`);
    }),
  );
  return {
    calls,
    commands: (path: string) => calls.filter((call) => call.method === "POST" && call.path === path),
  };
}

function renderMethodsPage(theme?: Parameters<typeof ChaseRoot>[0]["theme"]) {
  const router = createMemoryRouter(
    [{ path: "/account/payment-methods", Component: AccountPaymentMethodsRoute, loader, action }],
    { initialEntries: ["/account/payment-methods"] },
  );
  const view = render(
    <ChaseRoot theme={theme}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return {
    router,
    rerenderTheme: (nextTheme: Parameters<typeof ChaseRoot>[0]["theme"]) =>
      view.rerender(
        <ChaseRoot theme={nextTheme}>
          <RouterProvider router={router} />
        </ChaseRoot>,
      ),
  };
}

async function methodCard(label: string) {
  return (await screen.findByText(label)).closest<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg")!;
}

function formAttemptId(button: HTMLElement) {
  return (button.closest("form")!.querySelector('input[name="attemptId"]') as HTMLInputElement).value;
}

function actionRequest(fields: Record<string, string>) {
  return {
    request: new Request("http://localhost/account/payment-methods", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }),
    params: {},
    context: undefined,
  } as never;
}

// Reads the raised entity treatment back from the classes the design-system
// Surface owns for `elevation="elevated"`: the raised border and shadow.
function expectElevatedSurface(anchor: HTMLElement, glow: boolean) {
  const root = anchor.closest<HTMLElement>(".min-w-0.max-w-full.rounded-tokenLg");
  expect(root).toBeTruthy();
  const classes = root!.className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["surface-border", "shadow-tokenLg"]));
  expect(classes.includes("ds-glow")).toBe(glow);
}

function mockStripe(confirmSetup = vi.fn().mockResolvedValue({})) {
  const paymentElement = { mount: vi.fn(), destroy: vi.fn() };
  const update = vi.fn();
  (window as unknown as { Stripe?: unknown }).Stripe = vi.fn(() => ({
    elements: vi.fn(() => ({ create: vi.fn(() => paymentElement), update })),
    confirmSetup,
  }));
  return { paymentElement, update, confirmSetup };
}

async function startEmbeddedSetup() {
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
}

describe("account payment methods route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "orders.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reconciles a returned setup session before loading the method list", async () => {
    const api = stubPaymentsApi({
      list: () => [cardMethod, { ...bankMethod, is_default: true }],
      reply: (call) =>
        call.path === "/payment-methods/setup-sessions/cs_setup_1/reconcile"
          ? jsonResponse({ instrument: bankMethod })
          : undefined,
    });

    const result = await loader({
      request: new Request("http://localhost/account/payment-methods?setupReferenceId=cs_setup_1"),
      params: {},
      context: undefined,
    } as never);

    expect(result.setupResult).toBe("saved");
    expect(result.paymentMethods).toContainEqual(expect.objectContaining({ instrument_id: "sci_bank" }));
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /payment-methods/setup-sessions/cs_setup_1/reconcile",
      "GET /payment-methods",
    ]);
    // One fresh canonical id per form, minted before any dispatch.
    expect(Object.keys(result.attemptIds).sort()).toEqual([
      "add",
      "default:sci_bank",
      "default:sci_card",
      "remove:sci_bank",
      "remove:sci_card",
    ]);
    expect(Object.values(result.attemptIds).every((id) => UUID_V4.test(id))).toBe(true);
    expect(new Set(Object.values(result.attemptIds)).size).toBe(5);
  });

  it("returns a fresh method-list snapshot after setting a default method", async () => {
    const attemptId = "2f6c1b8e-9a4d-4c3b-8e7f-6a5b4c3d2e11";
    const api = stubPaymentsApi({
      list: () => [
        { ...cardMethod, is_default: false },
        { ...bankMethod, is_default: true, updated_at: "2026-04-02T00:00:00.000Z" },
      ],
      reply: (call) =>
        call.path === "/payment-methods/sci_bank/default"
          ? jsonResponse({ ...bankMethod, is_default: true })
          : undefined,
    });

    const result = await action(
      actionRequest({ intent: "default", instrumentId: "sci_bank", accountId: "acc_buyer", attemptId }),
    );

    expect(result).toEqual({
      attempt: { formKey: "default:sci_bank", attemptId, state: "succeeded", code: null },
      paymentMethods: [
        expect.objectContaining({ instrument_id: "sci_card", is_default: false }),
        expect.objectContaining({ instrument_id: "sci_bank", is_default: true }),
      ],
    });
    expect(api.commands("/payment-methods/sci_bank/default").map((call) => call.body)).toEqual([
      { accountId: "acc_buyer", attemptId },
    ]);
  });

  it("refuses a malformed attempt or a changed account in the action before any command", async () => {
    const api = stubPaymentsApi({});
    for (const fields of [
      { intent: "remove", instrumentId: "sci_card", accountId: "acc_buyer", attemptId: "not-a-uuid" },
      { intent: "remove", instrumentId: "sci_card", accountId: "acc_buyer", attemptId: "" },
      {
        intent: "default",
        instrumentId: "",
        accountId: "acc_buyer",
        attemptId: "2f6c1b8e-9a4d-4c3b-8e7f-6a5b4c3d2e12",
      },
    ]) {
      await expect(action(actionRequest(fields))).resolves.toEqual({
        attempt: expect.objectContaining({ state: "refused" }),
      });
    }
    await expect(
      action(
        actionRequest({
          intent: "add",
          accountId: "acc_previous",
          attemptId: "2f6c1b8e-9a4d-4c3b-8e7f-6a5b4c3d2e13",
        }),
      ),
    ).resolves.toEqual({ attempt: expect.objectContaining({ formKey: "add", state: "account-changed" }) });
    expect(api.calls).toEqual([]);
  });

  it("starts the embedded SetupIntent flow without redirecting", async () => {
    const attemptId = "2f6c1b8e-9a4d-4c3b-8e7f-6a5b4c3d2e14";
    const api = stubPaymentsApi({
      list: () => [cardMethod],
      reply: (call) => (call.path === "/payment-methods/setup-sessions" ? jsonResponse(embeddedSetup, 201) : undefined),
    });

    const result = await action(actionRequest({ intent: "add", accountId: "acc_buyer", attemptId }));

    expect(result).toEqual({
      attempt: { formKey: "add", attemptId, state: "succeeded", code: null },
      setup: embeddedSetup,
      paymentMethods: [cardMethod],
    });
    expect(api.calls).toEqual([
      {
        method: "POST",
        path: "/payment-methods/setup-sessions",
        body: { accountId: "acc_buyer", attemptId, returnUrlPath: "/account/payment-methods" },
      },
      { method: "GET", path: "/payment-methods", body: null },
    ]);
  });

  it("renders the reconciliation snapshot returned by the Payments API", async () => {
    stubPaymentsApi({
      reply: (call) =>
        call.path === "/payment-methods/reconcile"
          ? jsonResponse({
              checked: 2,
              updated: 1,
              removed: 1,
              items: [
                cardMethod,
                { ...bankMethod, readiness: "removed" as const, removed_at: "2026-04-03T00:00:00.000Z" },
              ],
            })
          : undefined,
    });

    const result = await action(actionRequest({ intent: "reconcile" }));

    expect(result).toEqual({
      paymentMethods: [
        expect.objectContaining({ instrument_id: "sci_card", readiness: "ready" }),
        expect.objectContaining({ instrument_id: "sci_bank", readiness: "removed" }),
      ],
    });
  });

  it("uses action snapshot data instead of stale loader methods after a mutation", async () => {
    let gets = 0;
    stubPaymentsApi({
      // Initial load, then the action's snapshot, then a stale revalidation.
      list: () => (++gets === 2 ? [{ ...bankMethod, is_default: true }] : [cardMethod, bankMethod]),
      reply: (call) =>
        call.path === "/payment-methods/sci_bank/default"
          ? jsonResponse({ ...bankMethod, is_default: true })
          : undefined,
    });
    renderMethodsPage();

    fireEvent.click(within(await methodCard("Bank ending in 6789")).getByRole("button", { name: "Set default" }));

    await waitFor(() => expect(screen.queryByText("Visa ending in 4242")).toBeNull());
    expect(screen.getByText("Bank ending in 6789")).toBeTruthy();
  });

  it("raises each saved payment method and the embedded Stripe setup host", async () => {
    const { paymentElement } = mockStripe();
    stubPaymentsApi({
      list: () => [cardMethod],
      reply: (call) => (call.path === "/payment-methods/setup-sessions" ? jsonResponse(embeddedSetup, 201) : undefined),
    });
    renderMethodsPage();

    await startEmbeddedSetup();

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    expectElevatedSurface(screen.getByText("Visa ending in 4242"), false);
    expectElevatedSurface(screen.getByRole("button", { name: "Save payment method" }), true);
  });

  it("preserves the mounted setup element when the theme changes", async () => {
    const { paymentElement, update } = mockStripe();
    stubPaymentsApi({
      list: () => [cardMethod],
      reply: (call) => (call.path === "/payment-methods/setup-sessions" ? jsonResponse(embeddedSetup, 201) : undefined),
    });
    const page = renderMethodsPage({ colors: { foreground: "#111111" } });
    await startEmbeddedSetup();

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    page.rerenderTheme({ colors: { foreground: "#eeeeee" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ appearance: expect.objectContaining({ variables: expect.any(Object) }) }),
      ),
    );
    expect(paymentElement.destroy).not.toHaveBeenCalled();
    page.rerenderTheme({ colors: { foreground: "var(--missing)" } });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          appearance: expect.objectContaining({ variables: expect.objectContaining({ colorText: "#211d33" }) }),
        }),
      ),
    );
    expect(paymentElement.destroy).not.toHaveBeenCalled();
  });

  it("guards setup confirmation against double-submit and wires a saved instrument", async () => {
    const { paymentElement, confirmSetup } = mockStripe();
    const api = stubPaymentsApi({
      list: () => [cardMethod],
      reply: (call) =>
        call.path === "/payment-methods/setup-sessions"
          ? jsonResponse(embeddedSetup, 201)
          : call.path === "/payment-methods/setup-sessions/scs_embedded/reconcile"
            ? jsonResponse({ instrument: bankMethod })
            : undefined,
    });
    renderMethodsPage();
    await startEmbeddedSetup();

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    const gets = () => api.calls.filter((call) => call.method === "GET").length;
    const getsBeforeSave = gets();
    const button = await screen.findByRole("button", { name: "Save payment method" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(confirmSetup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Payment method saved")).toBeTruthy());
    await waitFor(() => expect(gets()).toBeGreaterThan(getsBeforeSave));
  });

  it("renders SetupIntent errors in the design-system danger banner and re-enables retry", async () => {
    const { paymentElement } = mockStripe(vi.fn().mockResolvedValue({ error: { message: "Your card was declined." } }));
    stubPaymentsApi({
      list: () => [cardMethod],
      reply: (call) => (call.path === "/payment-methods/setup-sessions" ? jsonResponse(embeddedSetup, 201) : undefined),
    });
    renderMethodsPage();
    await startEmbeddedSetup();

    await waitFor(() => expect(paymentElement.mount).toHaveBeenCalled());
    const button = await screen.findByRole("button", { name: "Save payment method" });
    fireEvent.click(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Payment issue");
    expect(alert.textContent).toContain("Your card was declined.");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  });
});

describe("issue-10014 AC6 methods-page attempt states on the real data router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_buyer",
      permissions: ["orders.view", "orders.manage"],
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps one id across repeated Check again after a lost response, and never echoes raw error text", async () => {
    const replies: Reply[] = [
      () => Promise.reject(new TypeError("SYNTHETIC_PRIVATE_TRANSPORT_DETAIL")),
      jsonResponse({ error: { code: "attempt_unconfirmed", message: "SYNTHETIC_PRIVATE_SERVER_DETAIL" } }, 503),
      jsonResponse({ ...cardMethod, readiness: "removed", removed_at: "2026-04-03T00:00:00.000Z" }),
    ];
    const api = stubPaymentsApi({
      reply: (call) => (call.path === "/payment-methods/sci_card/remove" ? replies.shift() : undefined),
    });
    renderMethodsPage();
    const card = await methodCard("Visa ending in 4242");
    const loadedId = formAttemptId(within(card).getByRole("button", { name: "Remove" }));

    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    const checkAgain = await within(card).findByRole("button", { name: "Check again" });
    expect(within(card).getByRole("status").textContent).toBe(
      "We could not confirm that change yet. Check again before trying anything else.",
    );
    expect(formAttemptId(checkAgain)).toBe(loadedId);

    fireEvent.click(checkAgain);
    await waitFor(() => expect(api.commands("/payment-methods/sci_card/remove")).toHaveLength(2));
    fireEvent.click(await within(card).findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.commands("/payment-methods/sci_card/remove")).toHaveLength(3));

    await waitFor(() =>
      expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain("Payment method change saved."),
    );
    expect(new Set(api.commands("/payment-methods/sci_card/remove").map((call) => call.body?.attemptId))).toEqual(
      new Set([loadedId]),
    );
    expect(document.body.textContent).not.toContain("SYNTHETIC_PRIVATE");
  });

  it("leaves an unconfirmed remove on A in place while a default on B proceeds with its own id", async () => {
    const api = stubPaymentsApi({
      reply: (call) =>
        call.path === "/payment-methods/sci_card/remove"
          ? () => Promise.reject(new TypeError("lost"))
          : call.path === "/payment-methods/sci_bank/default"
            ? jsonResponse({ ...bankMethod, is_default: true })
            : undefined,
    });
    renderMethodsPage();
    const cardRemove = within(await methodCard("Visa ending in 4242")).getByRole("button", { name: "Remove" });
    const removeId = formAttemptId(cardRemove);

    fireEvent.click(cardRemove);
    await within(await methodCard("Visa ending in 4242")).findByRole("button", { name: "Check again" });
    const setDefault = within(await methodCard("Bank ending in 6789")).getByRole("button", { name: "Set default" });
    const defaultId = formAttemptId(setDefault);
    fireEvent.click(setDefault);

    await waitFor(() => expect(api.commands("/payment-methods/sci_bank/default")).toHaveLength(1));
    const checkAgain = await within(await methodCard("Visa ending in 4242")).findByRole("button", {
      name: "Check again",
    });
    expect(formAttemptId(checkAgain)).toBe(removeId);
    expect(api.commands("/payment-methods/sci_bank/default")[0]!.body).toEqual({
      accountId: "acc_buyer",
      attemptId: defaultId,
    });
    expect(defaultId).not.toBe(removeId);
  });

  it("mints a fresh id only after succeeded or refused, and reloads (zero commands) after a conflict", async () => {
    mockStripe();
    const replies: Reply[] = [
      jsonResponse(embeddedSetup, 201),
      jsonResponse({ error: { code: "validation_failed", message: "SYNTHETIC_REFUSAL" } }, 400),
      jsonResponse({ error: { code: "attempt_conflict", message: "SYNTHETIC_CONFLICT" } }, 409),
    ];
    const api = stubPaymentsApi({
      list: () => [cardMethod],
      reply: (call) => (call.path === "/payment-methods/setup-sessions" ? replies.shift() : undefined),
    });
    renderMethodsPage();
    const ids = () => api.commands("/payment-methods/setup-sessions").map((call) => call.body?.attemptId);

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    await screen.findByText("Payment method change saved.");
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    await screen.findByText("That payment method change was not made. Review it and try again.");
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    await screen.findByText("This page is out of date for that change. Reload to start again.");
    expect(new Set(ids()).size).toBe(3);
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();

    const commandsBeforeReload = api.commands("/payment-methods/setup-sessions").length;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const add = await screen.findByRole("button", { name: "Add" });
    expect(api.commands("/payment-methods/setup-sessions")).toHaveLength(commandsBeforeReload);
    expect(ids()).not.toContain(formAttemptId(add));
    expect(document.body.textContent).not.toContain("SYNTHETIC_");
  });

  it("disables every attempt control while submitting and announces the result", async () => {
    let release!: (response: Response) => void;
    stubPaymentsApi({
      reply: (call) =>
        call.path === "/payment-methods/sci_bank/default"
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    renderMethodsPage();

    fireEvent.click(within(await methodCard("Bank ending in 6789")).getByRole("button", { name: "Set default" }));

    await screen.findByText("Saving your payment method change.");
    for (const name of ["Add", "Remove", "Set default", "Refresh"]) {
      for (const button of screen.getAllByRole("button", { name })) expect(button.hasAttribute("disabled")).toBe(true);
    }
    await act(async () => release(jsonResponse({ ...bankMethod, is_default: true })));
    await screen.findByText("Payment method change saved.");
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(false);
  });

  it("refuses a changed account first, with zero commands, and offers only Reload", async () => {
    const api = stubPaymentsApi({});
    renderMethodsPage();
    const card = await methodCard("Visa ending in 4242");
    mockRequireActorFromAuthApi.mockResolvedValue({
      accountId: "acc_other",
      permissions: ["orders.view", "orders.manage"],
    });

    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));

    await within(card).findByText("The signed-in account changed. Reload to manage this account's payment methods.");
    expect(within(card).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("issue-10014 saved payment method attempt failure classifier", () => {
  const apiError = (status: number, code?: string) =>
    new PaymentsApiError(status, { error: { ...(code ? { code } : {}), message: "SYNTHETIC_PRIVATE_DETAIL" } });

  it.each([
    ["a transport failure", new TypeError("SYNTHETIC_PRIVATE_DETAIL"), "unconfirmed", null],
    ["attempt_unconfirmed", apiError(503, "attempt_unconfirmed"), "unconfirmed", "attempt_unconfirmed"],
    ["attempt_conflict", apiError(409, "attempt_conflict"), "conflict", "attempt_conflict"],
    ["account_changed over its 409", apiError(409, "account_changed"), "account-changed", "account_changed"],
    ["authentication_required", apiError(401, "authentication_required"), "reauth-required", "authentication_required"],
    ["a bare 401", apiError(401), "reauth-required", null],
    ["authorization_forbidden", apiError(403, "authorization_forbidden"), "refused", "authorization_forbidden"],
    ["not_found", apiError(404, "not_found"), "refused", "not_found"],
    ["validation_failed", apiError(400, "validation_failed"), "refused", "validation_failed"],
    ["a known refusal code over a 5xx", apiError(503, "validation_failed"), "refused", "validation_failed"],
    ["a known unconfirmed code over a 4xx", apiError(400, "attempt_unconfirmed"), "unconfirmed", "attempt_unconfirmed"],
    ["an unknown code on a 409", apiError(409, "SYNTHETIC_UNKNOWN"), "conflict", null],
    ["an inherited property name as a code", apiError(400, "toString"), "refused", null],
    ["an unknown 4xx", apiError(422), "refused", null],
    ["an unknown 5xx", apiError(500), "unconfirmed", null],
  ] as const)("classifies %s by code, then status, then transport", (_label, error, state, code) => {
    const result = classifySavedPaymentMethodAttemptFailure(error);

    expect(result).toEqual({ state, code });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });
});
