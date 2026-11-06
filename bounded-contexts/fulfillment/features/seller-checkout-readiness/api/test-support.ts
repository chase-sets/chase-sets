import { Hono } from "hono";
import { vi } from "vitest";
import type { AuthenticatedApiEnv, OperatorAuthority, ResolvedActor } from "@chase-sets/auth-context";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryFunction, PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { createSellerShippingSetupServices } from "./runtime";
import { createSellerShippingSetupRoutes } from "./route";

export const accountOwner = { kind: "account", accountId: "acc_seller" } as const;
export const anonymousOwner = { kind: "anonymous", anonymousSellListId: "anon_sell_list" } as const;
export const setup = { origin: { name: "Seller", line1: "1 Main St", line2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US" }, labelPreference: "prepaid-label" } as const;
export const actor: ResolvedActor = { sessionId: "ses_admin", tenantId: "tnt_identity", userId: "usr_admin", accountId: "acc_admin", membershipId: "mem_admin", roleKey: "platform-admin", permissions: [] };
export const context: EventStoreContext = { tenantId: "tnt_identity" as TenantId, audit: { performedByUserId: "usr_admin" as UserId, forAccountId: "acc_admin" as AccountId } };
export const grantedAuthority: OperatorAuthority = async (requester) => ({ kind: "granted", membershipId: requester.membershipId, roleKey: "platform-admin", rolePermissions: [] });
export const initialize = { owner: accountOwner, action: "initialize", reason: "Explicit launch initialization", operationId: "initialize_account" } as const;

// The non-DB seam tests command/boundary behavior only. Real transaction,
// restart and concurrent-writer proof lives in production-source.db.test.ts.
export function createShippingTestHarness(authority: OperatorAuthority | undefined = grantedAuthority) {
  const memory = createInMemoryEventStore();
  function row(event: StoredEvent) {
    return { current_version: String(event.streamVersion), stream_version: String(event.streamVersion), recorded_at: new Date(event.recordedAt), event_type: event.eventType, payload: event.payload, stream_id: event.streamId };
  }
  const query: PgQueryFunction = async <Row>(sql: string, values?: readonly unknown[]) => {
    let rows: unknown[] = [];
    if (sql.includes("WHERE s.stream_id")) {
      const events = memory.allEvents.filter((event) => event.streamId === values?.[0]);
      if (events.length) rows = [row(events[events.length - 1]!)];
    } else if (sql.includes("WHERE event_id")) {
      rows = memory.allEvents.filter((event) => event.eventId === values?.[0]).map(row);
    } else if (!/^(BEGIN|COMMIT|ROLLBACK|SELECT pg_advisory_xact_lock)/.test(sql)) {
      throw new Error(`Unexpected fake SQL: ${sql}`);
    }
    return { rows: rows as Row[] };
  };
  const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: () => {} }) };
  const eventStore: PostgresEventStore = {
    ...memory.eventStore,
    appendToStreamInTransaction: async (_client, input) => memory.eventStore.appendToStream(input),
    appendToStreamsInTransaction: async (_client, inputs) => memory.eventStore.appendToStreams(inputs),
    readStreamInTransaction: async (_client, input) => memory.eventStore.readStream(input),
  };
  const makeServices = () => createSellerShippingSetupServices({ pool, eventStore, operatorAuthority: authority });
  const services = makeServices();
  const app = new Hono<AuthenticatedApiEnv>();
  let currentActor: ResolvedActor | null = actor;
  app.use("*", async (c, next) => { c.set("actor", currentActor); c.set("context", currentActor ? context : null); await next(); });
  app.route("/api/marketplace", createSellerShippingSetupRoutes(services));
  return { services, makeServices, pool, events: memory.allEvents, app, setActor: (value: ResolvedActor | null) => { currentActor = value; }, query: vi.spyOn(pool, "query") };
}

export function jsonRequest(app: ReturnType<typeof createShippingTestHarness>["app"], path: string, body: unknown, method = "PUT", headers: Record<string, string> = {}) {
  return app.request(`/api/marketplace${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
