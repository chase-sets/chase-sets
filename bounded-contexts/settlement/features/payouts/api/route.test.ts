import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMoneyMovementWebhookRoutes } from "./route";
import type { PayoutServices } from "./runtime";

describe("settlement money movement webhook route", () => {
  it("accepts provider webhooks without marketplace auth context and preserves the raw body", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => ({
      received: true,
      ignored: false,
    }));
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({
        processMoneyMovementWebhook,
      } as unknown as PayoutServices),
    );

    const rawBody = "{\"type\":\"payout.failed\",\"data\":{\"object\":{\"id\":\"po_123\"}}}";
    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: rawBody,
      headers: { "Stripe-Signature": "t=1,v1=abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: false,
    });
    expect(processMoneyMovementWebhook).toHaveBeenCalledWith(
      {
        rawBody,
        signatureHeader: "t=1,v1=abc",
      },
      expect.objectContaining({
        tenantId: "tnt_identity",
      }),
    );
  });

  it("returns a bad request when provider signature verification fails", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => {
      throw new Error("Stripe webhook signature verification failed.");
    });
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({
        processMoneyMovementWebhook,
      } as unknown as PayoutServices),
    );

    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe webhook signature verification failed.",
    });
  });

  it("returns ignored responses for unsupported provider events", async () => {
    const processMoneyMovementWebhook = vi.fn(async () => ({
      received: true,
      ignored: true,
    }));
    const app = new Hono().route(
      "/provider",
      createMoneyMovementWebhookRoutes({
        processMoneyMovementWebhook,
      } as unknown as PayoutServices),
    );

    const response = await app.request("/provider/money-movement/webhooks", {
      method: "POST",
      body: "{\"type\":\"unsupported\"}",
      headers: { "Stripe-Signature": "t=1,v1=abc" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      ignored: true,
    });
  });
});
