// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import { CHASE_SETS_READ_AFTER_WRITE_HEADER, decodeFreshWriteReceipt, encodeCommitReceipt } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
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
  const applied = state === "full" ? "20.00" : state === "partial" ? "10.00" : "0.00";
  const external = state === "full" ? "0.00" : state === "partial" ? "10.00" : "20.00";
  const quote = {
    payment_method_category: "card", external_basis_amount: external,
    marketplace_checkout_fee_amount: "0.60", marketplace_checkout_fee_reduction_amount: "0.00",
    total_amount: "20.60", processor_amount: state === "full" ? "0.60" : state === "partial" ? "10.60" : "20.60",
    policy_version: "v1", quote_fingerprint: `fresh_${state}_${requested}`, quoted_at: "2026-04-01T00:00:00.000Z",
  };
  const withheld = state === "withheld" && requested !== "0.00";
  return {
    order_ids: ["ord_1"], currency_code: "usd", amount: "20.00", marketplace_checkout_fee: quote,
    payment_method_quotes: [quote], wallet_credit: { requested_amount: requested, applied_amount: applied, external_amount: external },
    can_start_payment: true, unavailable_reasons: withheld ? ["wallet-terms-not-accepted"] : [],
    unavailable_reason_details: withheld ? [{ code: "wallet-terms-not-accepted", message: reason }] : [],
  };
}

function harness(initial: State = "withheld") {
  let state = initial;
  let acceptReply: () => Response | Promise<Response> = () => jsonResponse({ accepted: true }, 201, {
    "X-ChaseSets-Commit-Receipt": encodeCommitReceipt({ commitPositions: [identityPosition] }),
  });
  let freshReply: (() => Response | Promise<Response>) | undefined;
  const calls: { path: string; method: string; body: unknown; headers: Headers; url: URL }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(requestUrl(input), "http://localhost");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, method, body, headers, url });
    if (url.pathname.endsWith("/order-inputs")) return jsonResponse({ orders: [{
      order_id: "ord_1", total_amount: "20.00", marketplace_sales_fee_amount: "1.00", seller_payout_amount: "19.00",
      status: "pending-payment", currency_code: "usd", listing_evidence: [],
    }] });
    if (url.pathname === "/api/settlement/wallet") return jsonResponse({ available_balance_amount: state === "zero" ? "0.00" : "26.83", currency_code: "usd" });
    if (url.pathname.endsWith("/checkout/status")) {
      if (headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER) && freshReply) return freshReply();
      return jsonResponse(status(state, url.searchParams.get("requestedBalanceCreditAmount") ?? "0.00"));
    }
    if (url.pathname === "/api/identity/consents/terms-of-service/accept") return acceptReply();
    if (url.pathname.endsWith("/payments") && method === "POST") return jsonResponse({
      payment_id: "pay_1", buyer_account_id: "acc_buyer", order_ids: ["ord_1"], amount: "20.00",
      balance_credit_amount: "0.00", processor_amount: "20.60", marketplace_sales_fee_amount: "1.00",
      marketplace_checkout_fee_amount: "0.60", marketplace_checkout_fee_policy_version: "v1",
      marketplace_checkout_fee_quote_fingerprint: "fresh_withheld_0.00", payment_method_category: "card",
      saved_checkout_instrument_id: null, seller_net_amount: "19.00", seller_payout_amount: "19.00", seller_payouts: [],
      currency_code: "usd", processor_name: "stripe", processor_payment_kind: "payment-intent",
      processor_payment_reference: "pi_1", processor_client_secret: null, processor_redirect_url: null,
      processor_status: "requires_payment_method", source_context: null, source_reference_id: null,
      status: "pending-confirmation", failure_code: null, failure_message: null, created_at: "2026-04-01T00:00:00.000Z",
      updated_at: "2026-04-01T00:00:00.000Z", captured_at: null, failed_at: null, cancelled_at: null,
      processor_publishable_key: null, provider_events: [],
    });
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  }));
  return {
    calls, setState: (next: State) => { state = next; },
    setAccept: (reply: typeof acceptReply) => { acceptReply = reply; },
    setFresh: (reply: typeof freshReply) => { freshReply = reply; },
    accepts: () => calls.filter(c => c.path.endsWith("/terms-of-service/accept")),
    creates: () => calls.filter(c => c.method === "POST" && c.path.endsWith("/payments")),
  };
}

function mount(autostart = false) {
  const router = createMemoryRouter([
    { path: "/account/payments/new", Component: MarketplaceAccountPaymentNewRoute, action,
      loader: async args => loader({ ...args, request: await resolvePlatformPostWriteRequest(args.request) }) },
    { path: "/account/payments/:id", element: <div>Payment destination</div> },
  ], { initialEntries: [`/account/payments/new?orderIds=ord_1${autostart ? "&autostart=1" : ""}`] });
  render(<ChaseRoot><RouterProvider router={router} /></ChaseRoot>);
  return router;
}

async function ready() { await screen.findByRole("heading", { name: "Start payment" }); }
function option(value: string) { return document.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!; }
function controls(withheld: boolean) {
  expect(option("max").disabled).toBe(withheld);
  expect(option("custom").disabled).toBe(withheld);
  expect((screen.getByRole("textbox", { name: "Custom wallet amount" }) as HTMLInputElement).disabled).toBe(withheld);
}
function form(amount = "26.83", mode = "custom") {
  const data = new FormData();
  Object.entries({ orderIds: "ord_1", totalAmount: "20.00", availableBalance: "26.83", balanceCreditMode: mode,
    requestedBalanceCreditAmount: amount, paymentMethodCategory: "card" }).forEach(([key, value]) => data.set(key, value));
  return data;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Start payment authoritative wallet status", () => {
  it("shows withheld wallet credit and the authoritative charge before payment", async () => {
    const api = harness(); mount(); await ready();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Terms of Service" }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("button", { name: "Accept Terms of Service" })).toBeTruthy();
    controls(true); expect(option("platform-credit").disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Wallet balance" }) as HTMLSelectElement).value).toBe("none");
    expect(screen.queryByText(/Using the maximum leaves/)).toBeNull();
    expect(screen.getByText("Wallet credit applied").parentElement?.textContent).toContain("$0.00");
    expect(screen.getByText("Card charge").parentElement?.textContent).toContain("$20.60");
    expect(screen.getAllByRole("button", { name: "Continue to payment" })).toHaveLength(2);
    for (const amount of ["26.83", "10.00", "99999.00"]) {
      const result = await action({ request: new Request("http://localhost/account/payments/new", { method: "POST", body: form(amount) }), params: {}, context: {} });
      expect(result).not.toBeInstanceOf(Response);
    }
    expect(api.creates()).toHaveLength(0);
  });

  it("requires explicit external continuation when wallet credit is withheld", async () => {
    const api = harness(); const router = mount(true); await ready();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(api.accepts()).toHaveLength(0); expect(api.creates()).toHaveLength(0);
    for (const trigger of [0, 1]) {
      api.setState("full"); await act(async () => { await router.revalidate(); });
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
    expect(api.creates()[0]!.body).toMatchObject({ requestedBalanceCreditAmount: "0.00", marketplaceCheckoutFeeQuoteFingerprint: "fresh_withheld_0.00" });
  });

  it("accepts terms explicitly then reloads wallet eligibility", async () => {
    const api = harness(); const router = mount(); await ready();
    expect(api.accepts()).toHaveLength(0); expect(api.creates()).toHaveLength(0);
    let finish!: (response: Response) => void;
    api.setAccept(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Accept Terms of Service" }));
    await waitFor(() => expect(router.state.navigation.state).toBe("submitting"));
    expect((screen.getByRole("button", { name: "Accepting Terms..." }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.accepts()).toHaveLength(1); expect(api.creates()).toHaveLength(0);
    const call = api.accepts()[0]!;
    expect(call.method).toBe("POST"); expect(call.body).toBeNull();
    api.setState("full");
    await act(async () => { finish(jsonResponse({ accepted: true }, 201, { "X-ChaseSets-Commit-Receipt": encodeCommitReceipt({ commitPositions: [identityPosition] }) })); });
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    controls(false); expect(option("platform-credit").disabled).toBe(false);
    expect(screen.queryByText(reason)).toBeNull(); expect(api.creates()).toHaveLength(0);
    expect(router.state.location.search).toContain("orderIds=ord_1");
    const fresh = api.calls.find(c => c.path.endsWith("/checkout/status") && c.headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER));
    expect(fresh).toBeTruthy();
    expect(decodeFreshWriteReceipt(fresh!.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toMatchObject({ sources: [identityPosition] });
    expect(fresh!.url.searchParams.get("orderIds")).toBe("ord_1");
  });

  it("keeps withheld credit honest when terms recovery does not complete", async () => {
    for (const failure of ["inactive", "refused", "transport", "still-withheld", "timeout"] as const) {
      const api = harness(); const router = mount(); await ready();
      if (failure === "inactive" || failure === "refused") api.setAccept(() => jsonResponse({ error: { code: failure, message: secret } }, failure === "inactive" ? 409 : 403));
      if (failure === "transport") api.setAccept(() => { throw new Error(secret); });
      if (failure === "timeout") api.setFresh(() => jsonResponse({ error: { code: "projection_freshness_timeout", message: secret } }, 503));
      fireEvent.click(screen.getByRole("button", { name: "Accept Terms of Service" }));
      await waitFor(() => expect(api.accepts()).toHaveLength(1));
      await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
      expect(screen.getByText(reason)).toBeTruthy(); controls(true);
      expect(screen.getByRole("link", { name: "Review Terms of Service" })).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Continue to payment" })).toHaveLength(2);
      expect(document.body.textContent).not.toContain(secret);
      expect(JSON.stringify({ loader: router.state.loaderData, action: router.state.actionData })).not.toContain(secret);
      expect(screen.queryByText(/Terms accepted|Wallet restored/i)).toBeNull();
      if (failure === "timeout") {
        expect(screen.getByText("Wallet status is catching up. Refresh before using wallet balance.")).toBeTruthy();
        api.setFresh(undefined);
        fireEvent.click(screen.getByRole("link", { name: "Refresh wallet status" }));
        await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
        expect(api.accepts()).toHaveLength(1);
      }
      expect(api.creates()).toHaveLength(0); expect(router.state.location.search).toContain("orderIds=ord_1");
      cleanup();
    }
  });

  it("preserves eligible and no-wallet payment paths", async () => {
    for (const state of ["full", "partial", "withheld", "zero"] as const) {
      harness(state); const router = mount(); await ready();
      expect(option("platform-credit").disabled).toBe(state !== "full");
      if (state === "full" || state === "partial") controls(false);
      if (state === "zero") expect(screen.queryByText(reason)).toBeNull();
      if (state === "withheld") {
        // Keep the wallet balance fixed while a real revalidation removes stale withholding.
        const freshApi = harness("partial");
        await act(async () => { await router.revalidate(); });
        await waitFor(() => expect(screen.queryByText(reason)).toBeNull()); controls(false);
        expect(freshApi.accepts()).toHaveLength(0);
      }
      cleanup();
    }
  });
});
