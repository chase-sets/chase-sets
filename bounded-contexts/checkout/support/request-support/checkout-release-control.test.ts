import { describe, expect, it, vi } from "vitest";
import {
  checkoutShopifySimpleUnavailableTelemetryEvent,
  evaluateCheckoutShopifySimpleDecision,
  isCheckoutShopifySimpleDeploymentKillSwitchActive,
  resolveCheckoutShopifySimpleUnavailableState,
} from "./checkout-release-control";

const signedInActor = {
  accountId: "acc_1",
  roleKey: "owner",
  permissions: ["checkout.manage"],
};

describe("checkout Shopify-simple release control", () => {
  it("uses a deployment kill switch to block all checkout entry before Platform Operations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const request = new Request("https://market.example.com/checkout/buy/readiness");

    const state = await resolveCheckoutShopifySimpleUnavailableState(request, null, "buy", {
      env: { CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE: "true" },
      fetch,
    });

    expect(
      isCheckoutShopifySimpleDeploymentKillSwitchActive({ CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE: "1" }),
    ).toBe(true);
    expect(state?.redirectPath).toBe("/account/cart?checkout=disabled");
    expect(state?.decision).toEqual({
      enabled: false,
      reason: "deployment-kill-switch",
      source: "deployment",
    });
    expect(state?.telemetryEvent).toEqual(
      expect.objectContaining({
        eventName: "checkout.capability.kill_switch_unavailable",
        entrySource: "buy-cart-readiness",
        actorMode: "anonymous",
        scenarioState: "kill-switch",
        sideEffectStatus: "not-attempted",
        capabilityDecision: "blocked",
        freshStateScanResult: "blocked-before-checkout",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requests the Platform Operations rollout decision for signed-in production actors", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return Response.json({
        enabled: true,
        reason: "subject-allowlist",
      });
    };

    const decision = await evaluateCheckoutShopifySimpleDecision(
      new Request("https://market.example.com/checkout/buy/readiness"),
      signedInActor,
      {
        fetch,
        environment: "production",
      },
    );

    expect(decision).toEqual({
      enabled: true,
      reason: "not-required",
      source: "platform-operations",
    });
    expect(calls[0]).toContain("/api/platform/release-controls/rollouts/checkout.shopify-simple/decision");
    expect(calls[0]).toContain("environment=production");
    expect(calls[0]).toContain("subjectType=account");
    expect(calls[0]).toContain("subjectId=acc_1");
  });

  it("fails closed when Platform Operations disables or cannot answer the rollout decision", async () => {
    const disabled = await resolveCheckoutShopifySimpleUnavailableState(
      new Request("https://market.example.com/checkout/sell/session/chk_1"),
      signedInActor,
      "sell",
      {
        fetch: async () => Response.json({ enabled: false, reason: "kill-switch" }),
        environment: "production",
      },
    );

    const unavailable = await resolveCheckoutShopifySimpleUnavailableState(
      new Request("https://market.example.com/checkout/sell/session/chk_1"),
      signedInActor,
      "sell",
      {
        fetch: async () => new Response("outage", { status: 503 }),
        environment: "production",
      },
    );

    expect(disabled?.redirectPath).toBe("/account/sell-list?checkout=disabled");
    expect(disabled?.decision.reason).toBe("platform-operations-kill-switch");
    expect(unavailable?.redirectPath).toBe("/account/sell-list?checkout=disabled");
    expect(unavailable?.decision.reason).toBe("platform-operations-unavailable");
  });

  it("does not require Platform Operations for local, test, or anonymous requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      evaluateCheckoutShopifySimpleDecision(new Request("https://market.example.com/checkout/buy/readiness"), null, {
        fetch,
        environment: "production",
      }),
    ).resolves.toEqual({
      enabled: true,
      reason: "not-required",
      source: "local-default",
    });
    await expect(
      evaluateCheckoutShopifySimpleDecision(
        new Request("https://market.example.com/checkout/buy/readiness"),
        signedInActor,
        {
          fetch,
          environment: "test",
        },
      ),
    ).resolves.toEqual({
      enabled: true,
      reason: "not-required",
      source: "local-default",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives bounded sell checkout unavailable telemetry without customer identifiers", () => {
    const event = checkoutShopifySimpleUnavailableTelemetryEvent("sell", signedInActor, {
      enabled: false,
      reason: "platform-operations-disabled",
      source: "platform-operations",
    });

    expect(event).toEqual(
      expect.objectContaining({
        eventName: "checkout.capability.kill_switch_unavailable",
        entrySource: "sell-list-readiness",
        actorMode: "signed-in",
        operatorSignalRequired: true,
        downstreamStatus: "not-started",
        providerCategory: "platform-operations",
      }),
    );
    expect(JSON.stringify(event)).not.toContain("acc_1");
  });
});
