import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPolicyCache } from "./cache";
import { gracePeriodPolicy } from "./examples/grace-period-policy";
import { buildPolicyDocumentProjectionHandlers } from "./projection";
import { createPolicyRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { allEvents, eventStore };
}

/**
 * A minimal in-memory stand-in for the platform_policy_documents /
 * platform_policy_document_history tables, matched against the exact SQL
 * shapes this package's own queries.ts and projection.ts emit. It lets the
 * runtime test exercise the real command handler, the real projection
 * handlers, and the real resolver/cache together without a live Postgres.
 */
function createFakePolicyDb() {
  const documents = new Map<string, Record<string, unknown>>();
  const history: Record<string, unknown>[] = [];
  const queryLog: string[] = [];

  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      queryLog.push(sql);

      if (sql.includes("INSERT INTO platform_policy_document_history")) {
        const [
          documentId,
          policyKey,
          eventId,
          eventType,
          actorUserId,
          status,
          value,
          effectiveFrom,
          effectiveUntil,
          recordedAt,
        ] = params;
        history.push({
          history_id: String(history.length + 1),
          event_id: eventId,
          document_id: documentId,
          policy_key: policyKey,
          event_type: eventType,
          actor_user_id: actorUserId,
          status,
          value: JSON.parse(value as string),
          effective_from: effectiveFrom,
          effective_until: effectiveUntil,
          recorded_at: recordedAt,
        });
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO platform_policy_documents")) {
        const [
          documentId,
          policyKey,
          contextName,
          schemaSummary,
          status,
          value,
          effectiveFrom,
          effectiveUntil,
          recordedAt,
        ] = params;
        documents.set(documentId as string, {
          document_id: documentId,
          policy_key: policyKey,
          context_name: contextName,
          schema_summary: schemaSummary,
          status,
          value: JSON.parse(value as string),
          effective_from: effectiveFrom,
          effective_until: effectiveUntil,
          created_at: recordedAt,
          updated_at: recordedAt,
        });
        return { rows: [] };
      }

      if (sql.includes("UPDATE platform_policy_documents")) {
        const [documentId, status, value, effectiveFrom, effectiveUntil, recordedAt] = params;
        const existing = documents.get(documentId as string);
        if (existing) {
          documents.set(documentId as string, {
            ...existing,
            status,
            value: JSON.parse(value as string),
            effective_from: effectiveFrom,
            effective_until: effectiveUntil,
            updated_at: recordedAt,
          });
        }
        return { rows: [] };
      }

      if (sql.includes("tstzrange")) {
        // Overlap guard is unit-tested directly in queries.test.ts; this
        // fake stays permissive so the runtime test can focus on the
        // create -> revise -> resolve -> invalidate flow.
        return { rows: [] };
      }

      if (sql.includes("DISTINCT ON (policy_key)")) {
        return { rows: [...documents.values()] };
      }

      if (sql.includes("FROM platform_policy_documents") && sql.includes("WHERE policy_key = $1")) {
        const [policyKey] = params;
        const rows = [...documents.values()]
          .filter((row) => row.policy_key === policyKey && row.status === "active")
          .sort((left, right) => String(right.effective_from).localeCompare(String(left.effective_from)));
        return { rows };
      }

      if (sql.includes("FROM platform_policy_documents") && sql.includes("WHERE document_id = $1")) {
        const [documentId] = params;
        const row = documents.get(documentId as string);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes("FROM platform_policy_document_history")) {
        const [documentId] = params;
        return { rows: history.filter((row) => row.document_id === documentId) };
      }

      throw new Error(`fakePolicyDb: unrecognized query: ${sql}`);
    },
  };

  return { db: db as never, documents, history, queryLog };
}

describe("platform policy runtime (define -> create -> revise -> resolve -> invalidate)", () => {
  it("declares its own stream prefix on the projector (not the mounting context's default)", async () => {
    // Policy document streams are always `platform-policy.document-<id>`,
    // regardless of which bounded context mounts this runtime. The generic
    // bounded-context-runtime auto-wires any projector that doesn't declare
    // `streamPrefixes` to default to `${mountingContextName}.` -- for a
    // context whose own stream prefix isn't "platform-policy.", that default
    // would never match these streams, so the projection would silently
    // never catch up and every context-owned read model built on this
    // machinery would stay empty forever. This regression-guards the fix.
    const { eventStore } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();
    const runtime = createPolicyRuntime({ eventStore, db });

    expect(runtime.projectors).toHaveLength(1);
    expect(runtime.projectors[0]?.streamPrefixes).toEqual(["platform-policy.document-"]);
  });

  it("resolves the compiled default before any document exists", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();
    const runtime = createPolicyRuntime({ eventStore, db });

    const resolved = await runtime.resolvePolicy(gracePeriodPolicy, { at: "2026-01-01T00:00:00.000Z" });

    expect(resolved).toMatchObject({ source: "fallback", value: { graceDays: 3 } });
  });

  it("creates a document, resolves it, revises it, and reflects the revision without a stale cache read", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db, documents } = createFakePolicyDb();
    const cache = createPolicyCache();
    const runtime = createPolicyRuntime({ eventStore, db, cache });
    // Wire the same projection handlers the runtime exposes, mirroring how a
    // host process would apply projected events after appendToStream.
    const handlers = buildPolicyDocumentProjectionHandlers(db, { onPolicyRevised: cache.invalidate });

    const { documentId } = await runtime.createPolicyDocument(
      gracePeriodPolicy,
      {
        value: { graceDays: 5 },
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      },
      context,
    );

    // Apply the created event to the read model, as a projector would.
    expect(documents.size).toBe(0);
    const [createdStoredEvent] = await eventStore.readStream({ streamId: `platform-policy.document-${documentId}` });
    await handlers[createdStoredEvent!.eventType]?.({
      id: createdStoredEvent!.eventId,
      data: createdStoredEvent!.payload,
      timing: { recordedAt: createdStoredEvent!.recordedAt },
      audit: { performedByUserId: createdStoredEvent!.performedByUserId },
    } as never);

    const resolvedAfterCreate = await runtime.resolvePolicy(gracePeriodPolicy, { at: "2026-05-01T00:00:00.000Z" });
    expect(resolvedAfterCreate).toMatchObject({
      source: "policy",
      documentId,
      value: { graceDays: 5 },
    });

    // Resolving again must not re-read Postgres: the candidate set is cached.
    expect(cache.get(gracePeriodPolicy.policyKey)).toBeDefined();

    await runtime.revisePolicyDocument(
      gracePeriodPolicy,
      documentId,
      {
        value: { graceDays: 10 },
        status: "active",
        effectiveFrom: "2026-04-30T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin_2",
      },
      context,
    );

    const streamEvents = await eventStore.readStream({ streamId: `platform-policy.document-${documentId}` });
    const revisedStoredEvent = streamEvents[streamEvents.length - 1]!;
    // The cache still holds the pre-revision candidate until the projection
    // (the push-based invalidation trigger) actually applies the event.
    expect(cache.get(gracePeriodPolicy.policyKey)).toBeDefined();
    await handlers[revisedStoredEvent.eventType]?.({
      id: revisedStoredEvent.eventId,
      data: revisedStoredEvent.payload,
      timing: { recordedAt: revisedStoredEvent.recordedAt },
      audit: { performedByUserId: revisedStoredEvent.performedByUserId },
    } as never);

    // The projection handler invalidated the cache as part of applying the
    // revised event -- push-based, no TTL.
    expect(cache.get(gracePeriodPolicy.policyKey)).toBeUndefined();

    const resolvedAfterRevise = await runtime.resolvePolicy(gracePeriodPolicy, { at: "2026-05-01T00:00:00.000Z" });
    expect(resolvedAfterRevise).toMatchObject({
      source: "policy",
      documentId,
      value: { graceDays: 10 },
    });
  });

  it("rejects a value that fails the policy's own decodeValue before any event is appended", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();
    const runtime = createPolicyRuntime({ eventStore, db });

    await expect(
      runtime.createPolicyDocument(
        gracePeriodPolicy,
        {
          value: { graceDays: 999 } as never,
          status: "active",
          effectiveFrom: "2026-04-30T00:00:00.000Z",
          effectiveUntil: null,
          actorUserId: "usr_admin",
        },
        context,
      ),
    ).rejects.toThrow("graceDays must be an integer between 0 and 90.");
    expect(allEvents).toHaveLength(0);
  });
});
