import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { HealthProjectionReplaySummary } from "@chase-sets/platform-runtime/health";
import { buildPlatformApiApp } from "../src/app";

describe("platform api app", () => {
  it("mounts the health route", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        getProjectionReplay: vi.fn(
          async () =>
            ({
              status: "ok",
              totalGroups: 0,
              requiredGroups: 0,
              initializedGroups: 0,
              caughtUpGroups: 0,
              behindGroups: 0,
              runningGroups: 0,
              errorGroups: 0,
              contexts: [],
            }) satisfies HealthProjectionReplaySummary,
        ),
      },
    );

    const response = await app.request("/health");

    expect(response.status).toBe(200);
  });

  it("mounts the internal realtime status route", async () => {
    const module = {
      contextName: "discovery",
      apiMounts: [],
      buildApis: () => [],
      projectors: () => [],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "discovery",
            module,
            services: {},
            pool: {
              query: async (sql: string) => {
                if (sql.includes("MAX(outbox_id)")) {
                  return { rows: [{ head: "5" }] };
                }

                throw new Error(`Unexpected query: ${sql}`);
              },
            },
            projectors: [],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        realtimeActiveConnectionCount: () => 3,
        realtimeRouteTuning: {
          batchSize: 25,
        },
      },
    );

    const response = await app.request("/internal/realtime/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      activeConnectionCount: 3,
      routeTuning: { batchSize: 25 },
      stores: [{ contextName: "discovery", head: "5" }],
    });
  });

  it("mounts the MCP JSON-RPC bridge with platform actor resolution", async () => {
    const app = buildPlatformApiApp(
      {
        mountedContexts: [],
        mountedModules: [],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      },
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "manager",
          permissions: ["inventory.view"],
        })),
        mcp: {
          toolHandlers: {
            "inventory.list-items": vi.fn(async ({ actor }) => ({
              accountId: actor?.accountId,
              items: [],
            })),
          },
        },
      },
    );

    const response = await app.request("/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request_1",
        method: "tools/call",
        params: {
          name: "inventory.list-items",
          arguments: {
            accountId: "account_1",
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "request_1",
      result: {
        content: [
          {
            type: "json",
            json: {
              accountId: "account_1",
              items: [],
            },
          },
        ],
      },
    });
  });

  it("keeps provider webhook mounts unauthenticated and preserves raw request bodies", async () => {
    const resolveActor = vi.fn(async () => {
      throw new Error("Provider webhooks must not require marketplace auth.");
    });
    const rawBody = '{\n  "type": "payout.failed"\n}';
    let observedActor: unknown = "unset";
    let observedRawBody = "";

    const providerRouter = new Hono();
    providerRouter.post("/money-movement/webhooks", async (c) => {
      observedActor = (c as unknown as { get(key: "actor"): unknown }).get(
        "actor",
      );
      observedRawBody = await c.req.raw.text();

      return c.json({ received: true });
    });

    const module = {
      contextName: "settlement",
      apiMounts: [
        {
          mountPath: "/api/settlement/provider",
          kind: "additional",
          requiresAuth: false,
          drainProjectorsOnWrite: false,
        },
      ],
      buildApis: () => [providerRouter],
      projectors: () => [],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "settlement",
            module,
            services: {},
            pool: {},
            projectors: [],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor,
      },
    );

    const response = await app.request(
      "/api/settlement/provider/money-movement/webhooks",
      {
        method: "POST",
        body: rawBody,
        headers: {
          Authorization: "Bearer not-used-for-provider-webhooks",
          "Content-Type": "application/json",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(resolveActor).not.toHaveBeenCalled();
    expect(observedActor).toBeUndefined();
    expect(observedRawBody).toBe(rawBody);
  });

  it("drains projectors after writes for mounts that request write consistency", async () => {
    const writeRouter = new Hono();
    writeRouter.post("/cart", async (c) => c.json({ status: "added" }, 201));

    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({ processed: 1 })
      .mockResolvedValueOnce({ processed: 0 });
    const module = {
      contextName: "checkout",
      apiMounts: [
        {
          mountPath: "/api/marketplace",
          kind: "primary",
          requiresAuth: true,
          drainProjectorsOnWrite: true,
        },
      ],
      buildApis: () => [writeRouter],
      projectors: () => [{ runOnce }],
    };
    const app = buildPlatformApiApp(
      {
        mountedContexts: [
          {
            contextName: "checkout",
            module,
            services: {},
            pool: {},
            projectors: [{ runOnce }],
          },
        ],
        mountedModules: [{ module, services: {} }],
        services: {
          auth: {},
          identity: {},
        },
        projectors: [{ runOnce }],
        projectionGroups: [],
        subscriptionRunners: [],
      } as never,
      {
        resolveActor: vi.fn(async () => ({
          sessionId: "sess_1",
          tenantId: "tenant_1",
          userId: "user_1",
          accountId: "account_1",
          membershipId: "member_1",
          roleKey: "buyer",
          permissions: ["orders.manage"],
        })),
      },
    );

    const response = await app.request("/api/marketplace/cart", {
      method: "POST",
      body: JSON.stringify({ productId: "prod_1" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });
});
