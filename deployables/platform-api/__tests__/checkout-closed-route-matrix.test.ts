import { describe, expect, it, vi } from "vitest";
import type { module as paymentsModule } from "@chase-sets/payments";
import { buildPlatformApiApp, type BuildPlatformApiOptions } from "../src/app";
import { createRouteInventoryRuntime } from "./route-inventory-test-support";

type CreateAccountPayment = ReturnType<typeof paymentsModule.createServices>["payments"]["createAccountPayment"];

function paymentApps(accountId: string, permissions = ["orders.manage"]) {
  const inventory = createRouteInventoryRuntime();
  const createAccountPayment = vi.fn<CreateAccountPayment>(async () => {
    throw new Error("Synthetic payment input rejected; no payment created.");
  });
  const paymentServices = { payments: { createAccountPayment } };
  const mountedContexts = inventory.mountedContexts
    .filter((entry) => entry.contextName === "payments")
    .map((entry) => ({ ...entry, services: paymentServices }));
  const runtime = {
    ...inventory,
    mountedContexts,
    mountedModules: [],
    services: { auth: {}, identity: {}, payments: paymentServices },
  };
  const options: BuildPlatformApiOptions = {
    resolveActor: async () => ({
      sessionId: "ses_synthetic_closed",
      tenantId: "tnt_synthetic_closed",
      userId: "usr_synthetic_closed",
      accountId,
      membershipId: "mbr_synthetic_closed",
      roleKey: "owner",
      permissions,
    }),
  };
  // Use the existing mount-inventory fixture with the real Payments routers and host.
  const open: ReturnType<typeof buildPlatformApiApp> = Reflect.apply(buildPlatformApiApp, undefined, [runtime, options]);
  const closed: ReturnType<typeof buildPlatformApiApp> = Reflect.apply(buildPlatformApiApp, undefined, [
    runtime,
    { ...options, checkoutClosed: true },
  ]);
  return { open, closed, createAccountPayment };
}

function paymentRequest(app: ReturnType<typeof buildPlatformApiApp>) {
  return app.request("/api/marketplace/account/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderIds: ["ord_synthetic_closed"], currencyCode: "usd" }),
  });
}

describe("checkout-closed-route-matrix: unchanged payment preconditions", () => {
  it("keeps authorized closed payment starts away from the service", async () => {
    const { closed, createAccountPayment } = paymentApps("acc_synthetic_closed_control");
    const response = await paymentRequest(closed);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "checkout_closed" } });
    expect(createAccountPayment).not.toHaveBeenCalled();
  });

  it("preserves the existing authorization refusal when checkout closes", async () => {
    const { open, closed, createAccountPayment } = paymentApps("acc_synthetic_closed_forbidden", []);
    const baseline = await paymentRequest(open);
    expect(baseline.status).toBe(403);
    expect(await baseline.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
    const response = await paymentRequest(closed);
    expect(response.status).toBe(403);
    expect(createAccountPayment).not.toHaveBeenCalled();
  });

  it("preserves an exhausted owner rate-limit bucket across open to closed", async () => {
    const { open, closed, createAccountPayment } = paymentApps("acc_synthetic_closed_rate_limit");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await paymentRequest(open)).status).toBe(400);
    }
    const baseline = await paymentRequest(open);
    expect(baseline.status).toBe(429);
    expect(await baseline.json()).toMatchObject({ error: { code: "rate_limited", surface: "payments.payment.create.account" } });
    expect(createAccountPayment).toHaveBeenCalledTimes(10);
    createAccountPayment.mockClear();
    const response = await paymentRequest(closed);
    expect(response.status).toBe(429);
    expect(createAccountPayment).not.toHaveBeenCalled();
  });
});
