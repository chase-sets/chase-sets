// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { Hono } from "hono";
import { attachReadConsistencyMiddleware } from "@chase-sets/bounded-context-runtime";
import manifest from "../context.json";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import MarketplaceAccountPaymentNewRoute, { action, loader } from "../routes/marketplace/account-payment-new";
import { jsonResponse, requestUrl } from "./test-support/http";

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: vi.fn(async () => ({ accountId: "acc_buyer" })),
}));

const reason = "Accept the current Terms of Service to use wallet balance as payment.";
const secret = "SECRET_DO_NOT_EXPOSE_10820";
const identityPosition = { sourceContextName: "identity", maxGlobalPosition: "42", eventIds: ["evt_terms"] };
type State = "withheld" | "full" | "partial" | "zero";
function status(state: State = "withheld", requested = "26.83") {
  const usingWallet = requested !== "0.00";
  const applied = usingWallet && state === "full" ? "20.00" : usingWallet && state === "partial" ? "10.00" : "0.00";
  const external = applied === "20.00" ? "0.00" : applied === "10.00" ? "10.00" : "20.00";
  const fee = external === "0.00" ? "0.00" : "0.60";
  const quote = {
    payment_method_category: "card",
    external_basis_amount: external,
    marketplace_checkout_fee_amount: fee,
    marketplace_checkout_fee_reduction_amount: "0.00",
    total_amount: fee === "0.00" ? "20.00" : "20.60",
    processor_amount: external === "0.00" ? "0.00" : external === "10.00" ? "10.60" : "20.60",
    policy_version: "v1",
    quote_fingerprint: `fresh_${state}_${requested}`,
    quoted_at: "2026-04-01T00:00:00.000Z",
  };
  const withheld = state === "withheld" && requested !== "0.00";
  return {
    order_ids: ["ord_1"],
    currency_code: "usd",
    amount: "20.00",
    marketplace_checkout_fee: quote,
    payment_method_quotes: [quote],
    wallet_credit: { requested_amount: requested, applied_amount: applied, external_amount: external },
    can_start_payment: true,
    unavailable_reasons: withheld ? ["wallet-terms-not-accepted"] : [],
    unavailable_reason_details: withheld ? [{ code: "wallet-terms-not-accepted", message: reason }] : [],
  };
}

function harness(initial: State = "withheld") {
  let state = initial;
  let acceptReply: () => Response | Promise<Response> = () =>
    jsonResponse({ accepted: true }, 201, {
      "Chase-Sets-Consistency": "eventual",
      "Chase-Sets-Commit-Receipt": encodeCommitReceipt([identityPosition]),
    });
  let freshReply: (() => Response | Promise<Response>) | undefined;
  const calls: { path: string; method: string; body: unknown; headers: Headers; url: URL }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(requestUrl(input), "http://localhost");
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ path: url.pathname, method, body, headers, url });
      if (url.pathname.endsWith("/order-inputs"))
        return jsonResponse({
          orders: [
            {
              order_id: "ord_1",
              total_amount: "20.00",
              marketplace_sales_fee_amount: "1.00",
              seller_payout_amount: "19.00",
              status: "pending-payment",
              currency_code: "usd",
              listing_evidence: [],
            },
          ],
        });
      if (url.pathname === "/api/settlement/wallet")
        return jsonResponse({ available_balance_amount: state === "zero" ? "0.00" : "26.83", currency_code: "usd" });
      if (url.pathname.endsWith("/checkout/status")) {
        if (headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER) && freshReply) return freshReply();
        return jsonResponse(status(state, url.searchParams.get("requestedBalanceCreditAmount") ?? "0.00"));
      }
      if (url.pathname === "/api/identity/consents/terms-of-service/accept") return acceptReply();
      if (url.pathname.endsWith("/payments") && method === "POST")
        return jsonResponse({
          payment_id: "pay_1",
          buyer_account_id: "acc_buyer",
          order_ids: ["ord_1"],
          amount: "20.00",
          balance_credit_amount: "0.00",
          processor_amount: "20.60",
          marketplace_sales_fee_amount: "1.00",
          marketplace_checkout_fee_amount: "0.60",
          marketplace_checkout_fee_policy_version: "v1",
          marketplace_checkout_fee_quote_fingerprint: "fresh_withheld_0.00",
          payment_method_category: "card",
          saved_checkout_instrument_id: null,
          seller_net_amount: "19.00",
          seller_payout_amount: "19.00",
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
        });
      throw new Error(`Unexpected request ${method} ${url.pathname}`);
    }),
  );
  return {
    calls,
    setState: (next: State) => {
      state = next;
    },
    setAccept: (reply: typeof acceptReply) => {
      acceptReply = reply;
    },
    setFresh: (reply: typeof freshReply) => {
      freshReply = reply;
    },
    accepts: () => calls.filter((c) => c.path.endsWith("/terms-of-service/accept")),
    creates: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/payments")),
  };
}

function mount(autostart = false, entry = "/account/payments/new?orderIds=ord_1") {
  const authenticated = (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set("cookie", "session=synthetic-payment-test");
    headers.set("authorization", "Bearer synthetic-payment-test");
    return new Request(request, { headers });
  };
  const router = createMemoryRouter(
    [
      {
        path: "/account/payments/new",
        Component: MarketplaceAccountPaymentNewRoute,
        action: async (args) => {
          const request = authenticated(args.request);
          expect(request.headers.get("content-type")).toBe(args.request.headers.get("content-type"));
          return action({ ...args, request });
        },
        loader: async (args) => loader({ ...args, request: authenticated(args.request) }),
      },
      { path: "/account/payments/:id", element: <div>Payment destination</div> },
    ],
    { initialEntries: [`${entry}${autostart ? "&autostart=1" : ""}`] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return router;
}

async function ready() {
  await screen.findByRole("heading", { name: "Start payment" });
}
function option(value: string) {
  return document.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!;
}
function controls(withheld: boolean) {
  expect(option("max").disabled).toBe(withheld);
  expect(option("custom").disabled).toBe(withheld);
  expect((screen.getByRole("textbox", { name: "Custom wallet amount" }) as HTMLInputElement).disabled).toBe(withheld);
}
function form(amount = "26.83", mode = "custom") {
  const data = new FormData();
  Object.entries({
    orderIds: "ord_1",
    totalAmount: "20.00",
    availableBalance: "26.83",
    balanceCreditMode: mode,
    requestedBalanceCreditAmount: amount,
    paymentMethodCategory: "card",
  }).forEach(([key, value]) => data.set(key, value));
  return data;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Start payment authoritative wallet status", () => {
  it("shows withheld wallet credit and the authoritative charge before payment", async () => {
    const api = harness();
    mount();
    await ready();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Terms of Service" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("button", { name: "Accept Terms of Service" })).toBeTruthy();
    controls(true);
    expect(option("platform-credit").disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Wallet balance" }) as HTMLSelectElement).value).toBe("none");
    expect(screen.queryByText(/Using the maximum leaves/)).toBeNull();
    expect(screen.getByText("Wallet credit applied").parentElement?.textContent).toContain("$0.00");
    expect(screen.getByText("Card charge").parentElement?.textContent).toContain("$20.60");
    expect(screen.getAllByRole("button", { name: "Continue to payment" })).toHaveLength(2);
    for (const amount of ["26.83", "10.00", "99999.00"]) {
      const result = await action({
        request: new Request("http://localhost/account/payments/new", { method: "POST", body: form(amount) }),
        params: {},
        context: {},
      });
      expect(result).not.toBeInstanceOf(Response);
    }
    expect(api.creates()).toHaveLength(0);
  });

  it("requires explicit external continuation when wallet credit is withheld", async () => {
    const api = harness();
    const router = mount(true);
    await ready();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.accepts()).toHaveLength(0);
    expect(api.creates()).toHaveLength(0);
    for (const trigger of [0, 1]) {
      api.setState("full");
      await act(async () => {
        await router.revalidate();
      });
      await waitFor(() => expect(option("max").disabled).toBe(false));
      api.setState("withheld");
      fireEvent.click(screen.getAllByRole("button", { name: "Continue to payment" })[trigger]!);
      await screen.findByText(reason);
      await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
      expect(api.creates()).toHaveLength(0);
      expect(api.accepts()).toHaveLength(0);
    }
    fireEvent.click(screen.getAllByRole("button", { name: "Continue to payment" })[1]!);
    await screen.findByText("Payment destination");
    expect(api.creates()).toHaveLength(1);
    expect(api.creates()[0]!.body).toMatchObject({
      requestedBalanceCreditAmount: null,
      marketplaceCheckoutFeeQuoteFingerprint: "fresh_withheld_0.00",
    });
  });

  it("accepts terms explicitly then reloads wallet eligibility", async () => {
    const apiRoute = manifest.apiMounts.find((api) => api.mountPath === "/api/marketplace")!;
    expect(apiRoute.readFreshnessRoutes).toContainEqual({
      routePath: "/account/checkout/status",
      methods: ["GET", "HEAD"],
      dependencies: [
        { readModelTable: "payments_order_inputs" },
        { targetContextName: "identity", readModelTable: "identity_consent_current_states" },
      ],
    });
    const inventory = manifest.readAfterWriteRouteInventory.find(
      (entry) => entry.id === "payments.terms-accept-to-wallet-status",
    )!;
    expect(inventory.source).toMatchObject({
      routeId: "account-payment-new",
      helperUses: ["navigateAfterWriteWithPlatformPostWriteToken"],
    });
    expect(inventory.destination).toMatchObject({
      routeId: "account-payment-new",
      apiContextName: "payments",
      apiRoutePath: "/account/checkout/status",
      readModelTables: ["payments_order_inputs"],
      helperUses: ["loadAfterWrite"],
      transientRecovery: { kinds: "refreshable-catching-up" },
    });
    const mutation = manifest.mutationConsistencyInventory.find(
      (entry) => entry.id === "payments.terms-accept-to-wallet-status-fresh-read",
    )!;
    expect(mutation).toMatchObject({ owner: "payments", risk: "critical", strategy: "fresh-read" });
    expect(mutation.surfaces).toEqual([
      "post-form:bounded-contexts/payments/routes/marketplace/account-payment-new.tsx:Hb08a81ecfd73#1",
    ]);
    const { helperUses: _helpers, ...destination } = inventory.destination;
    expect(mutation.visibleDestination).toEqual(destination);
    expect(mutation.proof.tests).toContain(
      "bounded-contexts/payments/tests/account-payment-new-wallet-status.test.tsx",
    );
    const api = harness();
    const router = mount();
    await ready();
    expect(api.accepts()).toHaveLength(0);
    expect(api.creates()).toHaveLength(0);
    let finish!: (response: Response) => void;
    api.setAccept(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept Terms of Service" }));
    await waitFor(() => expect(router.state.navigation.state).toBe("submitting"));
    expect((screen.getByRole("button", { name: "Accepting Terms..." }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.accepts()).toHaveLength(1);
    expect(api.creates()).toHaveLength(0);
    const call = api.accepts()[0]!;
    expect(call.method).toBe("POST");
    expect(call.body).toBeNull();
    expect(call.headers.get("cookie")).toBe("session=synthetic-payment-test");
    expect(call.headers.get("authorization")).toBe("Bearer synthetic-payment-test");
    expect(call.url.search).toBe("");
    let finishFresh!: (response: Response) => void;
    api.setFresh(
      () =>
        new Promise((resolve) => {
          finishFresh = resolve;
        }),
    );
    api.setState("full");
    await act(async () => {
      finish(
        jsonResponse({ accepted: true }, 201, {
          "Chase-Sets-Consistency": "eventual",
          "Chase-Sets-Commit-Receipt": encodeCommitReceipt([identityPosition]),
        }),
      );
    });
    await waitFor(() =>
      expect(
        api.calls.find((c) => c.path.endsWith("/checkout/status") && c.headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)),
      ).toBeTruthy(),
    );
    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));
    controls(true);
    expect(api.creates()).toHaveLength(0);
    await act(async () => {
      finishFresh(jsonResponse(status("full")));
    });
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    controls(false);
    expect(option("platform-credit").disabled).toBe(false);
    expect(screen.queryByText(reason)).toBeNull();
    expect(api.creates()).toHaveLength(0);
    expect(router.state.location.search).toContain("orderIds=ord_1");
    const fresh = api.calls.find(
      (c) => c.path.endsWith("/checkout/status") && c.headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER),
    );
    expect(fresh).toBeTruthy();
    expect(decodeFreshWriteReceipt(fresh!.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toMatchObject({
      sources: [identityPosition],
    });
    expect(fresh!.url.searchParams.get("orderIds")).toBe("ord_1");
    expect(fresh!.headers.get("Chase-Sets-Read-Target-Context")).toBe("payments");
  });

  it.each(["form", "sticky", "autostart"] as const)(
    "carries the Identity receipt through a post-accept %s payment preflight",
    async (trigger) => {
      const api = harness();
      const router = mount();
      await ready();
      api.setState("full");
      fireEvent.click(screen.getByRole("button", { name: "Accept Terms of Service" }));
      await waitFor(() => expect(option("max").disabled).toBe(false));
      expect(api.creates()).toHaveLength(0);
      const beforeSubmit = api.calls.length;
      if (trigger === "autostart") {
        const entry = `${router.state.location.pathname}${router.state.location.search}`;
        expect(entry).toContain("postWriteToken=");
        cleanup();
        mount(true, entry);
      } else {
        fireEvent.click(screen.getAllByRole("button", { name: "Continue to payment" })[trigger === "form" ? 0 : 1]!);
      }
      await screen.findByText("Payment destination");
      expect(api.accepts()).toHaveLength(1);
      expect(api.creates()).toHaveLength(1);
      const preflight = api.calls
        .slice(beforeSubmit)
        .filter((call) => call.path.endsWith("/checkout/status"))
        .at(-1)!;
      expect(decodeFreshWriteReceipt(preflight.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toMatchObject({
        sources: [identityPosition],
      });
      expect(preflight.headers.get("Chase-Sets-Read-Target-Context")).toBe("payments");
      expect(preflight.headers.get("cookie")).toBe("session=synthetic-payment-test");
      expect(preflight.headers.get("authorization")).toBe("Bearer synthetic-payment-test");
      expect(preflight.url.searchParams.get("orderIds")).toBe("ord_1");
    },
  );

  it("keeps withheld credit honest when terms recovery does not complete", async () => {
    for (const failure of [
      "inactive",
      "refused",
      "transport",
      "unconfirmed",
      "missing-receipt",
      "malformed-receipt",
      "wrong-source",
      "still-withheld",
      "timeout",
    ] as const) {
      const api = harness();
      const router = mount();
      await ready();
      if (failure === "inactive" || failure === "refused")
        api.setAccept(() =>
          jsonResponse({ error: { code: failure, message: secret } }, failure === "inactive" ? 409 : 403),
        );
      if (failure === "transport")
        api.setAccept(() => {
          throw new Error(secret);
        });
      if (failure === "unconfirmed") api.setAccept(() => jsonResponse({ accepted: false, message: secret }));
      if (failure === "missing-receipt") api.setAccept(() => jsonResponse({ accepted: true }, 201));
      if (failure === "malformed-receipt" || failure === "wrong-source")
        api.setAccept(() =>
          jsonResponse({ accepted: true }, 201, {
            "Chase-Sets-Consistency": "eventual",
            "Chase-Sets-Commit-Receipt":
              failure === "malformed-receipt"
                ? secret
                : encodeCommitReceipt([{ ...identityPosition, sourceContextName: "payments" }]),
          }),
        );
      if (failure === "timeout")
        api.setFresh(() => jsonResponse({ error: { code: "projection_freshness_timeout", message: secret } }, 503));
      fireEvent.click(screen.getByRole("button", { name: "Accept Terms of Service" }));
      await waitFor(() => expect(api.accepts()).toHaveLength(1));
      await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
      expect(screen.getByText(reason)).toBeTruthy();
      controls(true);
      expect(screen.getByRole("link", { name: "Review Terms of Service" })).toBeTruthy();
      expect(await screen.findAllByRole("button", { name: "Continue to payment" })).toHaveLength(2);
      expect(document.body.textContent).not.toContain(secret);
      expect(JSON.stringify({ loader: router.state.loaderData, action: router.state.actionData })).not.toContain(
        secret,
      );
      expect(screen.queryByText(/Terms accepted|Wallet restored/i)).toBeNull();
      if (failure !== "still-withheld" && failure !== "timeout") {
        expect(
          screen.getByText(
            "Terms acceptance could not be confirmed. Review the Terms or continue without wallet balance.",
          ),
        ).toBeTruthy();
      }
      if (failure === "timeout") {
        expect(screen.getByText("Wallet status is catching up. Refresh before using wallet balance.")).toBeTruthy();
        const refresh = screen.getByRole("link", { name: "Refresh wallet status" });
        expect(refresh.getAttribute("href")).toContain("orderIds=ord_1");
        expect(refresh.getAttribute("href")).toContain("afterWrite=");
        fireEvent.click(screen.getAllByRole("button", { name: "Continue to payment" })[1]!);
        await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
        await screen.findAllByRole("button", { name: "Continue to payment" });
        expect(api.creates()).toHaveLength(0);
        expect(document.body.textContent).not.toContain(secret);
        expect(JSON.stringify(router.state.actionData)).not.toContain(secret);
        api.setFresh(undefined);
        fireEvent.click(screen.getByRole("link", { name: "Refresh wallet status" }));
        await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
        expect(api.accepts()).toHaveLength(1);
      }
      expect(api.creates()).toHaveLength(0);
      expect(router.state.location.search).toContain("orderIds=ord_1");
      expect((screen.getAllByRole("button", { name: "Continue to payment" })[1] as HTMLButtonElement).disabled).toBe(
        false,
      );
      fireEvent.click(screen.getAllByRole("button", { name: "Continue to payment" })[1]!);
      await screen.findByText("Payment destination");
      expect(api.creates()).toHaveLength(1);
      expect(api.accepts()).toHaveLength(1);
      cleanup();
    }
  });

  it("preserves eligible and no-wallet payment paths", async () => {
    for (const state of ["full", "partial", "withheld", "zero"] as const) {
      const api = harness(state);
      const router = mount();
      await ready();
      expect(option("platform-credit").disabled).toBe(state !== "full");
      if (state === "full" || state === "partial") controls(false);
      if (state === "zero") expect(screen.queryByText(reason)).toBeNull();
      if (state === "full" || state === "partial" || state === "zero") {
        if (state === "partial")
          fireEvent.change(screen.getByRole("combobox", { name: "Wallet balance" }), { target: { value: "none" } });
        fireEvent.click(screen.getAllByRole("button", { name: "Continue to payment" })[0]!);
        await screen.findByText("Payment destination");
        expect(api.creates()).toHaveLength(1);
        expect(api.accepts()).toHaveLength(0);
        expect(api.creates()[0]!.body).toMatchObject({
          requestedBalanceCreditAmount: state === "full" ? "20.00" : null,
          marketplaceCheckoutFeeQuoteFingerprint: `fresh_${state}_${state === "full" ? "20.00" : "0.00"}`,
        });
      }
      if (state === "withheld") {
        // Keep the wallet balance fixed while a real revalidation removes stale withholding.
        const freshApi = harness("partial");
        await act(async () => {
          await router.revalidate();
        });
        await waitFor(() => expect(screen.queryByText(reason)).toBeNull());
        controls(false);
        expect(freshApi.accepts()).toHaveLength(0);
      }
      cleanup();
    }
  });

  it("rejects malformed or missing wallet credit instead of falling back to raw balance", async () => {
    for (const walletCredit of [
      undefined,
      { requested_amount: "26.83", applied_amount: "20.00junk", external_amount: "0.00" },
    ]) {
      const api = harness();
      api.setFresh(() => jsonResponse({ ...status("full"), wallet_credit: walletCredit }));
      const receipt = encodeFreshWriteReceipt({ observedAtMs: Date.now(), sources: [identityPosition] });
      await expect(
        loader({
          request: new Request(
            `http://localhost/account/payments/new?orderIds=ord_1&afterWrite=${encodeURIComponent(receipt)}`,
          ),
          params: {},
          context: {},
        }),
      ).rejects.toThrow();
      expect(api.creates()).toHaveLength(0);
    }
  });

  it("waits for the Identity consent runner while serving Payments status", async () => {
    const apiRoute = manifest.apiMounts.find((api) => api.mountPath === "/api/marketplace")!;
    let caughtUp = false;
    let observedLag!: () => void;
    const lagObserved = new Promise<void>((resolve) => {
      observedLag = resolve;
    });
    const handler = vi.fn();
    const app = new Hono();
    attachReadConsistencyMiddleware(
      app,
      [
        {
          contextName: "payments",
          mountPath: apiRoute.mountPath,
          readFreshnessRoutes: apiRoute.readFreshnessRoutes!.map((route) => ({
            ...route,
            methods: ["GET", "HEAD"] as const,
          })),
        },
      ],
      [
        {
          targetContextName: "payments",
          projectionName: "payments-payment-projection",
          ownedTables: ["payments_payment_pages"],
          subscriptionRunners: [],
        },
        {
          targetContextName: "payments",
          projectionName: "payments-order-input-projection",
          ownedTables: ["payments_order_inputs"],
          subscriptionRunners: [],
        },
        {
          targetContextName: "identity",
          projectionName: "identity-consent-current-state-projection",
          ownedTables: ["identity_consent_current_states"],
          subscriptionRunners: [
            {
              sourceContextName: "identity",
              refreshStatus: async () => {
                observedLag();
                return {
                  lastGlobalPosition: caughtUp ? "42" : "41",
                  state: caughtUp ? "caught-up" : "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      { exactDependencyMode: "enabled", timeoutMs: 1000, pollIntervalMs: 1 },
    );
    app.get("/api/marketplace/account/checkout/status", (c) => {
      handler();
      return c.json(status("full"));
    });
    const headers = {
      "Chase-Sets-Read-Target-Context": "payments",
      [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodeFreshWriteReceipt({
        observedAtMs: Date.now(),
        sources: [identityPosition],
      }),
    };
    const pending = app.request("/api/marketplace/account/checkout/status", { headers });
    await Promise.race([
      lagObserved,
      pending.then(() => {
        throw new Error("Identity dependency was bypassed");
      }),
    ]);
    expect(handler).not.toHaveBeenCalled();
    caughtUp = true;
    expect((await pending).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    caughtUp = false;
    const timeout = await app.request("/api/marketplace/account/checkout/status", { headers });
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toMatchObject({
      error: {
        code: "projection_freshness_timeout",
        pending: [
          expect.objectContaining({
            targetContextName: "identity",
            projectionName: "identity-consent-current-state-projection",
          }),
        ],
      },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
