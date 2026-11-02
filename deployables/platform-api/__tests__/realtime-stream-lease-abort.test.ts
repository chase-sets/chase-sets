import { createInMemoryRealtimeStreamLimiter, createRealtimeRoutes } from "@chase-sets/platform-runtime/realtime";
import { serve } from "@hono/node-server";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

it("releases all leases after 20 real HTTP clients abort before the headers", async () => {
  const limiter = createInMemoryRealtimeStreamLimiter();
  const leases: Awaited<ReturnType<typeof limiter.acquire>>[] = [];
  const acquisitions: Promise<void>[] = [];
  const requests: Request[] = [];
  let randomState = 10524;
  let port = 0;
  let lastAbortAt = 0;
  const app = createRealtimeRoutes({
    resourceLimits: { maxActiveStreamsPerConnectionKey: 20 },
    stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
    resolveActor: async (request) => {
      requests.push(request);
      return {
        sessionId: "sess_abort",
        tenantId: "tenant_abort",
        userId: "user_abort",
        accountId: "account_abort",
        membershipId: "member_abort",
        roleKey: "manager",
        permissions: [],
      };
    },
    streamLimiter: {
      ...limiter,
      acquire: async (request) => {
        const acquisition = delay(250).then(async () => {
          const lease = await limiter.acquire(request);
          leases.push(lease);
          return lease;
        });
        acquisitions.push(acquisition.then(() => undefined));
        return acquisition;
      },
    },
  });
  let server: ReturnType<typeof serve> | undefined;
  try {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
        port = address.port;
        resolve();
      });
    });
    for (let index = 0; index < 20; index += 1) {
      const abort = new AbortController();
      const response = fetch(`http://127.0.0.1:${port}/public/events?topic=public:market`, { signal: abort.signal });
      const outcome = response.then(
        (value) => value.status,
        (error: unknown) => error,
      );
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      await delay(randomState % 101);
      abort.abort();
      lastAbortAt = performance.now();
      const result = await outcome;
      expect(result).toMatchObject({ name: "AbortError" });
      await delay(275);
      await Promise.all(acquisitions);
    }
    expect(leases.length).toBeGreaterThan(0);
    expect(leases.length).toBeLessThanOrEqual(20);
    expect(leases.every((lease) => lease !== null)).toBe(true);
    await expect
      .poll(() => limiter.activeConnectionCount?.(), {
        timeout: Math.max(1, Math.floor(5_000 - (performance.now() - lastAbortAt))),
      })
      .toBe(0);
  } finally {
    await Promise.all(acquisitions);
    // Negative controls leave callbacks alive; abort them only after checking leases.
    for (const request of requests) request.signal.dispatchEvent(new Event("abort"));
    for (const lease of leases) await lease?.release();
    if (server) {
      const active = server;
      if ("closeAllConnections" in active) active.closeAllConnections();
      await new Promise<void>((resolve, reject) => active.close((error) => (error ? reject(error) : resolve())));
    }
  }
});
