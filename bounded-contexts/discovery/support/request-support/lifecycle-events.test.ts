import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { discoveryItemSearchRoutes } from "../../features/search/api/route";
import type { DiscoveryItemSearchServices } from "../../features/search/api/runtime";
import { appendSearchSessionStarted } from "./lifecycle-events";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;

describe("discovery lifecycle events", () => {
  it("emits discovery.search-session.started from the production GET / search entrypoint", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = {
      searchItems: vi.fn(async () => ({
        items: [],
        facets: [],
        category_counts: [],
        total: 0,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 0,
        queryHash: "hash",
        resultSetKey: "result",
      })),
      suggestItems: vi.fn(async () => []),
      previewBulkAdd: vi.fn(async () => ({ items: [], count: 0 })),
      rebuildSearchIndex: vi.fn(),
      projectors: [],
      publishSearchOutcome: ({
        accountId,
        sessionId,
        context: eventContext,
      }: {
        accountId: string;
        sessionId: string;
        context: EventStoreContext;
      }) =>
        appendSearchSessionStarted(eventStore, eventContext, {
          accountId: accountId as never,
          sessionId: sessionId as never,
        }),
    } as unknown as DiscoveryItemSearchServices;
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_1", sessionId: "ses_1", agentGrant: null } as never);
      c.set("context", context);
      await next();
    });
    app.route("/", discoveryItemSearchRoutes(services));

    const response = await app.request("/?search=pokemon");
    expect(response.status).toBe(200);
    const event = (await eventStore.readAll())[0];
    expect(event).toMatchObject({
      eventType: "discovery.search-session.started",
      eventId: expect.stringMatching(/^evt_search_[0-9a-f]{64}$/),
      streamId: expect.stringMatching(/^discovery\.search-session-[0-9a-f]{64}$/),
      payload: { accountId: "acc_1", sessionId: "ses_1" },
      tenantId: "tnt_test",
      performedByUserId: "usr_system",
      forAccountId: "acc_system",
    });
    expect(event.recordedAt).toBeTruthy();
  });

  it("returns search success when outcome publication is isolated", async () => {
    const services = {
      searchItems: vi.fn(async () => ({
        items: [],
        facets: [],
        category_counts: [],
        total: 0,
        nextCursor: null,
        retrievalMode: "lexical",
        lexicalCount: 0,
        queryHash: "hash",
        resultSetKey: "result",
      })),
      suggestItems: vi.fn(async () => []),
      previewBulkAdd: vi.fn(async () => ({ items: [], count: 0 })),
      rebuildSearchIndex: vi.fn(),
      projectors: [],
      publishSearchOutcome: vi.fn(async () => {
        throw new Error("projection append failed");
      }),
    } as unknown as DiscoveryItemSearchServices;
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_2", sessionId: "ses_2", agentGrant: null } as never);
      c.set("context", context);
      await next();
    });
    app.route("/", discoveryItemSearchRoutes(services));
    const response = await app.request("/?search=pokemon");
    expect(response.status).toBe(200);
  });
});
