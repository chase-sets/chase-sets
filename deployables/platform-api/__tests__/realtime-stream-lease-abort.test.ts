import { createInMemoryRealtimeStreamLimiter, createRealtimeRoutes } from "@chase-sets/platform-runtime/realtime";
import { serve } from "@hono/node-server";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";

it("releases all 20 leases when real HTTP clients abort before the headers", async () => {
  const limiter = createInMemoryRealtimeStreamLimiter();
  const leases: Awaited<ReturnType<typeof limiter.acquire>>[] = [];
  const acquisitions: Promise<void>[] = [];
  let entered!: () => void;
  let randomState = 10524;
  let port = 0;
  let lastAbortAt = 0;
  const app = createRealtimeRoutes({
    resourceLimits: { maxActiveStreamsPerConnectionKey: 20 },
    stores: [{ contextName: "discovery", db: { query: async () => ({ rows: [] }) } }],
    resolveActor: async () => ({
      sessionId: "sess_abort", tenantId: "tenant_abort", userId: "user_abort",
      accountId: "account_abort", membershipId: "member_abort", roleKey: "manager", permissions: [],
    }),
    streamLimiter: {
      ...limiter,
      acquire: async (request) => {
        entered();
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
  let server!: ReturnType<typeof serve>;
  try {
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
        port = address.port;
        resolve();
      });
    });
    for (let index = 0; index < 20; index += 1) {
      const arrived = new Promise<void>((resolve) => { entered = resolve; });
      const abort = new AbortController();
      const response = fetch(`http://127.0.0.1:${port}/public/events?topic=public:market`, { signal: abort.signal });
      const outcome = response.then((value) => value.status, (error: unknown) => error);
      // Synchronize arrival so even the seeded 0 ms abort exercises the server, not just fetch startup.
      await Promise.race([arrived, outcome.then((result) => {
        throw new Error(`Request completed before lease acquisition: ${String(result)}`);
      })]);
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      await delay(randomState % 101);
      abort.abort();
      lastAbortAt = performance.now();
      expect(await outcome).toMatchObject({ name: "AbortError" });
      await acquisitions[index];
    }
    expect(leases).toHaveLength(20);
    expect(leases.every((lease) => lease !== null)).toBe(true);
    await expect.poll(() => limiter.activeConnectionCount?.(), {
      timeout: Math.max(1, 5_000 - (performance.now() - lastAbortAt)),
    }).toBe(0);
  } finally {
    await Promise.all(acquisitions);
    for (const lease of leases) await lease?.release();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
