import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ChannelConnectionNotFoundError } from "../domain/source-resolution";
import { initialEconomicsOverridesState } from "../domain/overrides";
import { createEconomicsRoutes } from "./route";

function app(resolver = { resolve: vi.fn(async () => ({ kind: "unavailable" })) }, execute = vi.fn()) {
  const host = new Hono<AuthenticatedApiEnv>();
  host.use("*", async (c, next) => {
    c.set("actor", { accountId: "synthetic-owner-account" } as never);
    c.set("context", {
      tenantId: "synthetic-tenant",
      audit: { performedByUserId: "synthetic-user", forAccountId: "synthetic-owner-account" },
    } as never);
    await next();
  });
  host.route("/economics", createEconomicsRoutes(resolver as never, { execute } as never));
  return host;
}

const resolveBody = {
  connectionId: "synthetic-connection-1",
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00", currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T06:00:00Z",
};

describe("Economics API routes", () => {
  it("rejects resolve and mutation requests without authenticated actor context", async () => {
    const resolve = vi.fn();
    const execute = vi.fn();
    const host = new Hono<AuthenticatedApiEnv>();
    host.route("/economics", createEconomicsRoutes({ resolve } as never, { execute } as never));

    const resolveResponse = await host.request("/economics/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolveBody),
    });
    const overrideResponse = await host.request("/economics/overrides/clear-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connectionId: "synthetic-connection-1",
        currency: "usd",
        expectedVersion: 0,
        clearedAt: "2026-09-07T06:03:00Z",
      }),
    });

    expect(resolveResponse.status).toBe(401);
    expect(overrideResponse.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("injects authenticated account identity before resolution", async () => {
    const resolve = vi.fn(async () => ({ kind: "unavailable" as const }));
    const response = await app({ resolve }).request("/economics/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolveBody),
    });
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ accountId: "synthetic-owner-account", ...resolveBody });
  });

  it("rejects forged coordinates before the resolver and bounds missing connections", async () => {
    const forgedResolver = { resolve: vi.fn() };
    const forged = await app(forgedResolver).request("/economics/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...resolveBody, providerKey: "synthetic-forged" }),
    });
    expect(forged.status).toBe(400);
    expect(forgedResolver.resolve).not.toHaveBeenCalled();

    const absent = await app({
      resolve: vi.fn(async () => {
        throw new ChannelConnectionNotFoundError();
      }),
    }).request("/economics/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolveBody),
    });
    expect(absent.status).toBe(404);
    await expect(absent.json()).resolves.toEqual({ error: { code: "channel-connection-not-found" } });
  });

  it("executes set/clear/clear-all with actor context and explicit versions", async () => {
    const execute = vi.fn(async ({ key }) => initialEconomicsOverridesState(key));
    const target = app(undefined, execute);
    const common = { connectionId: "synthetic-connection-1", currency: "usd", expectedVersion: 0 };
    for (const [path, body] of [
      ["set", { ...common, factName: "turnaroundDays", value: 14, setAt: "2026-09-07T06:01:00Z" }],
      ["clear", { ...common, factName: "turnaroundDays", clearedAt: "2026-09-07T06:02:00Z" }],
      ["clear-all", { ...common, clearedAt: "2026-09-07T06:03:00Z" }],
    ] as const) {
      const response = await target.request(`/economics/overrides/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      key: { accountId: "synthetic-owner-account", connectionId: common.connectionId, currency: "usd" },
      command: { type: "SetEconomicsFactOverride", expectedVersion: 0 },
    });
  });
});
