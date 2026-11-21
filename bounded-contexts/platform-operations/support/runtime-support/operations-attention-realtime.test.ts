import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";

const wrapped = vi.hoisted(() => [] as Array<{ projectionName: string; source: string }>);

vi.mock("../../features/operations-attention-queue/api/realtime-invalidation", () => ({
  withOperationsAttentionRealtimeInvalidation: (
    handlers: Record<string, unknown>,
    _db: unknown,
    input: { projectionName: string; source: string },
  ) => {
    wrapped.push(input);
    return handlers;
  },
}));

const { createPlatformOperationsServices } = await import("./services");
const { module } = await import("../../index");

function stubPool(): PgTransactionalPool {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => {
      throw new Error("no database in this test");
    }),
  } as unknown as PgTransactionalPool;
}

describe("Operations Attention realtime composition", () => {
  it("publishes from each queue source's own projection, and no other", () => {
    wrapped.length = 0;
    const services = createPlatformOperationsServices(stubPool());

    expect(wrapped).toEqual([
      { projectionName: "experience-platform-feedback-projection", source: "platform-feedback-unreviewed" },
      {
        projectionName: "platform-operations-reported-content-action-projection",
        source: "reported-content-response",
      },
      { projectionName: "support-request-projection", source: "support-request-deadline" },
    ]);
    expect(services.projectors.map((set) => set.projectionName)).toEqual(
      expect.arrayContaining(wrapped.map((entry) => entry.projectionName)),
    );
  });

  it("publishes from the reported-content queue subscription of every source context, keyed by that context", () => {
    const services = createPlatformOperationsServices(stubPool());
    wrapped.length = 0;
    const subscriptions = module.buildSubscriptions?.(services) ?? [];

    expect(subscriptions.length).toBeGreaterThan(0);
    expect(wrapped).toEqual(
      expect.arrayContaining([
        { projectionName: "identity.reported-content-queue-projection", source: "reported-content-response" },
        { projectionName: "marketplace.reported-content-queue-projection", source: "reported-content-response" },
        {
          projectionName: "platform-operations.reported-content-queue-projection",
          source: "reported-content-response",
        },
      ]),
    );
    expect(wrapped).toHaveLength(3);
  });
});
