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
        getProjectionReplay: vi.fn(async () => ({
          status: "ok",
          totalGroups: 0,
          requiredGroups: 0,
          initializedGroups: 0,
          caughtUpGroups: 0,
          behindGroups: 0,
          runningGroups: 0,
          errorGroups: 0,
          contexts: [],
        } satisfies HealthProjectionReplaySummary)),
      },
    );

    const response = await app.request("/health");

    expect(response.status).toBe(200);
  });

  it("keeps provider webhook mounts unauthenticated and preserves raw request bodies", async () => {
    const resolveActor = vi.fn(async () => {
      throw new Error("Provider webhooks must not require marketplace auth.");
    });
    const rawBody = "{\n  \"type\": \"payout.failed\"\n}";
    let observedActor: unknown = "unset";
    let observedRawBody = "";

    const providerRouter = new Hono();
    providerRouter.post("/money-movement/webhooks", async (c) => {
      observedActor = (c as unknown as { get(key: "actor"): unknown }).get("actor");
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

    const response = await app.request("/api/settlement/provider/money-movement/webhooks", {
      method: "POST",
      body: rawBody,
      headers: {
        Authorization: "Bearer not-used-for-provider-webhooks",
        "Content-Type": "application/json",
      },
    });

    expect(response.status).toBe(200);
    expect(resolveActor).not.toHaveBeenCalled();
    expect(observedActor).toBeUndefined();
    expect(observedRawBody).toBe(rawBody);
  });
});
