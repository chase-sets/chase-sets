import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { discoveryItemSearchRoutes } from "../../features/search/api/route";
import { createDiscoveryItemSearchRuntime } from "../../features/search/api/runtime";
import {
  expectHelperParity,
  expectProjectionFailure,
  expectSourceEvent,
} from "../../../customer-feedback/tests/outcome-fact-test-support";

const context = {
  tenantId: "tnt_test",
  audit: { performedByUserId: "usr_system", forAccountId: "acc_system" },
} as EventStoreContext;

async function searchApp(
  actor: { accountId: string; sessionId: string; agentGrant: unknown } | null = {
    accountId: "acc_1",
    sessionId: "ses_1",
    agentGrant: null,
  },
) {
  const { eventStore } = createInMemoryEventStore();
  const services = {
    ...createDiscoveryItemSearchRuntime({
      eventStore,
      db: { query: async () => ({ rows: [] }) },
      checkpointStore: {
        loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
        saveCheckpoint: async () => undefined,
      },
    }),
    searchItems: vi.fn(async () => ({
      items: [],
      facets: [],
      category_counts: [],
      total: 0,
      nextCursor: null,
      retrievalMode: "lexical" as const,
      lexicalCount: 0,
      queryHash: "hash",
      resultSetKey: "result",
    })),
  };
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor as never);
    c.set("context", context);
    await next();
  });
  app.route("/", discoveryItemSearchRoutes(services));

  return { app, eventStore };
}

describe("discovery lifecycle events", () => {
  it("emits discovery.search-session.started event with exact payload and envelope identity", async () => {
    const { app, eventStore } = await searchApp();
    const response = await app.request("/?search=pokemon");
    expect(response.status).toBe(200);
    const event = (await eventStore.readAll())[0];
    expectSourceEvent(event, {
      eventType: "discovery.search-session.started",
      payload: { accountId: "acc_1", sessionId: "ses_1" },
      tenantId: context.tenantId,
      performedByUserId: context.audit.performedByUserId,
      forAccountId: context.audit.forAccountId,
    });
    const digest = createHash("sha256").update("discovery:search-session:ses_1").digest("hex");
    expect(event.eventId).toBe(`evt_search_${digest}`);
    expect(event.streamId).toBe(`discovery.search-session-${digest}`);
    await app.request("/?search=another");
    expect(await eventStore.readAll()).toHaveLength(1);
  });

  it("projects discovery.search-session.started with helper-parity row", async () => {
    const { app, eventStore } = await searchApp();
    expect((await app.request("/?search=pokemon")).status).toBe(200);
    await expectHelperParity((await eventStore.readAll())[0]!, {
      idempotencyKey: "discovery:search-session:ses_1",
      outcomeCode: "discovery.search-completed",
      sourceContext: "discovery",
      subjectAccountId: "acc_1",
      subjectKind: "account",
      subjectEntityType: "session",
      subjectEntityId: "ses_1",
      authenticationMethod: null,
    });
  });

  it("returns search success when outcome projection fails", async () => {
    const { app, eventStore } = await searchApp();
    const response = await app.request("/?search=pokemon");
    await expectProjectionFailure((await eventStore.readAll())[0]!);
    expect(response.status).toBe(200);
    expect((await app.request("/?search=another")).status).toBe(200);
  });

  it.each([null, { accountId: "acc_1", sessionId: "ses_agent", agentGrant: {} }])(
    "does not emit a search-session event for an anonymous or agent-grant actor (%j)",
    async (actor) => {
      const { app, eventStore } = await searchApp(actor);
      expect((await app.request("/?search=pokemon")).status).toBe(200);
      expect(await eventStore.readAll()).toEqual([]);
    },
  );
});
