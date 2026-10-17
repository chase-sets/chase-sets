import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
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
import { definePolicy } from "./define-policy";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

const syntheticConsentPolicy = definePolicy({
  policyKey: "synthetic.consent-version",
  contextName: "synthetic",
  schemaSummary: "{ version: string }",
  defaultValue: { version: "v1" },
  decodeValue(raw) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      !("version" in raw) ||
      typeof raw.version !== "string"
    ) {
      throw new Error("Invalid synthetic version");
    }
    return { version: raw.version };
  },
});

describe("guarded consent document activation", () => {
  it("folds beyond one page without projection authority and guards an exact-repeat no-op", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db, queryLog } = createFakePolicyDb();
    const runtime = createPolicyRuntime({ eventStore, db });
    const { documentId } = await runtime.createPolicyDocument(
      syntheticConsentPolicy,
      {
        value: { version: "v1" },
        status: "active",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "synthetic-operator",
      },
      context,
    );
    const streamId = `platform-policy.document-${documentId}`;
    await eventStore.appendToStream({
      streamId,
      expectedVersion: 1,
      context,
      events: Array.from({ length: 500 }, () => ({
        eventType: "platform-policy.document.revised",
        payload: {
          documentId,
          policyKey: syntheticConsentPolicy.policyKey,
          value: { version: "v2" },
          status: "active",
          effectiveFrom: "2026-09-01T00:00:00.000Z",
          effectiveUntil: null,
          actorUserId: "synthetic-operator",
        },
      })),
    });
    const queryCount = queryLog.length;
    const params = { version: "v2", documentId, actorUserId: "synthetic-operator" };
    const first = await runtime.activateConsentPolicyVersion(syntheticConsentPolicy, params, context);
    expect(first).toMatchObject({ activeVersion: "v2", authorityVersion: 2 });
    expect(await runtime.activateConsentPolicyVersion(syntheticConsentPolicy, params, context)).toEqual(first);
    expect(queryLog).toHaveLength(queryCount);
    const guardedStore: EventStore = {
      ...eventStore,
      appendToStreams: async (inputs) => {
        expect(inputs).toHaveLength(2);
        expect(inputs[0]).toMatchObject({ streamId, expectedVersion: 501, events: [] });
        expect(inputs[1]).toMatchObject({ expectedVersion: 2, events: [] });
        await eventStore.appendToStream({
          streamId,
          expectedVersion: 501,
          context,
          events: [
            {
              eventType: "platform-policy.document.revised",
              payload: {
                documentId,
                policyKey: syntheticConsentPolicy.policyKey,
                value: { version: "v3" },
                status: "active",
                effectiveFrom: "2026-09-01T00:00:00.000Z",
                effectiveUntil: null,
                actorUserId: "synthetic-operator",
              },
            },
          ],
        });
        return eventStore.appendToStreams!(inputs);
      },
    };
    await expect(
      createPolicyRuntime({ eventStore: guardedStore, db }).activateConsentPolicyVersion(
        syntheticConsentPolicy,
        params,
        context,
      ),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect((await runtime.consentActivation.read(syntheticConsentPolicy.policyKey)).authorityVersion).toBe(2);
  });

  it("fails closed on an over-bound document before registration", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();
    const runtime = createPolicyRuntime({ eventStore, db });
    const streamId = "platform-policy.document-synthetic-long";
    await eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: Array.from({ length: 10_000 }, () => ({ eventType: "synthetic.unreadable", payload: {} })),
    });
    await expect(
      runtime.activateConsentPolicyVersion(
        syntheticConsentPolicy,
        {
          version: "v1",
          documentId: "synthetic-long",
          actorUserId: "synthetic-operator",
        },
        context,
      ),
    ).rejects.toMatchObject({ name: "EventStreamTooLongError", maxEvents: 9_999 });
    expect((await runtime.consentActivation.read(syntheticConsentPolicy.policyKey)).registered).toBe(false);
  });
});

/**
 * A minimal in-memory stand-in for the platform_policy_documents /
 * platform_policy_document_history tables, matched against the exact SQL
 * shapes this package's own queries.ts and projection.ts emit. It lets the
 * runtime test exercise the real command handler, the real projection
 * handlers, and the real resolver/cache together without a live Postgres.
 */
function createFakePolicyDb(options: Readonly<{ overlappingDocumentId?: string }> = {}) {
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
        // Overlap guard SQL is unit-tested directly in queries.test.ts; this
        // fake stays permissive unless a test names an overlapping document.
        return { rows: options.overlappingDocumentId ? [{ document_id: options.overlappingDocumentId }] : [] };
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

const activeWindow = {
  status: "active",
  effectiveFrom: "2026-04-30T00:00:00.000Z",
  effectiveUntil: null,
} as const;

const createParams = { value: { graceDays: 5 }, ...activeWindow, actorUserId: "usr_admin" };

function revisedEvent(documentId: string, graceDays: number) {
  return {
    eventType: "platform-policy.document.revised",
    payload: {
      documentId,
      policyKey: gracePeriodPolicy.policyKey,
      value: { graceDays },
      ...activeWindow,
      actorUserId: "usr_admin",
    },
  };
}

/** Records every single-stream append's identity and expected version, then forwards it unchanged. */
function recordAppends(eventStore: EventStore) {
  const appends: { streamId: string; expectedVersion: unknown; eventCount: number }[] = [];
  const recorded: EventStore = {
    ...eventStore,
    appendToStream: async (input) => {
      appends.push({
        streamId: input.streamId,
        expectedVersion: input.expectedVersion,
        eventCount: input.events.length,
      });
      return eventStore.appendToStream(input);
    },
  };
  return { eventStore: recorded, appends };
}

/** Creates `documentId`, then appends `revisions` revised events carrying `graceDays: 7`. */
async function seedDocumentStream(eventStore: EventStore, documentId: string, revisions: number) {
  await createPolicyRuntime({ eventStore, db: createFakePolicyDb().db }).createPolicyDocumentWithId(
    gracePeriodPolicy,
    documentId,
    createParams,
    context,
  );
  if (revisions === 0) {
    return;
  }
  await eventStore.appendToStream({
    streamId: `platform-policy.document-${documentId}`,
    expectedVersion: 1,
    context,
    events: Array.from({ length: revisions }, () => revisedEvent(documentId, 7)),
  });
}

describe("authoritative policy document state read", () => {
  it("returns exactly state and version from a complete replay whose decisive event is 501", async () => {
    const { eventStore } = createInMemoryEventStore();
    const documentId = "pol_replay_tail";
    const streamId = `platform-policy.document-${documentId}`;
    await seedDocumentStream(eventStore, documentId, 499);
    await eventStore.appendToStream({
      streamId,
      expectedVersion: 500,
      context,
      events: [revisedEvent(documentId, 42)],
    });
    const pageReads: number[] = [];
    const pagedStore: EventStore = {
      ...eventStore,
      readStream: async (input) => {
        pageReads.push(input.fromVersion ?? 1);
        return eventStore.readStream(input);
      },
    };
    const { db, queryLog } = createFakePolicyDb();

    const read = await createPolicyRuntime({ eventStore: pagedStore, db }).readPolicyDocumentState(documentId);

    expect(Object.keys(read).sort()).toEqual(["state", "version"]);
    expect(read).toEqual({
      state: { documentId, policyKey: gracePeriodPolicy.policyKey, value: { graceDays: 42 }, ...activeWindow },
      version: 501,
    });
    expect(pageReads).toEqual([1, 501]);
    expect(queryLog).toHaveLength(0);

    // Negative control: one page stops at event 500 and misses the decisive tail.
    const firstPage = await eventStore.readStream({ streamId });
    expect(firstPage).toHaveLength(500);
    expect(firstPage.at(-1)).toMatchObject({ streamVersion: 500, payload: { value: { graceDays: 7 } } });
  });

  it("reads an absent document as the initial state at version 0", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();

    await expect(createPolicyRuntime({ eventStore, db }).readPolicyDocumentState("pol_absent")).resolves.toEqual({
      state: {
        documentId: null,
        policyKey: null,
        status: null,
        value: null,
        effectiveFrom: null,
        effectiveUntil: null,
      },
      version: 0,
    });
  });

  it("propagates a failed continuation read and an unreplayable tail instead of returning a prefix", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();
    const documentId = "pol_replay_failure";
    await seedDocumentStream(eventStore, documentId, 499);
    const failingStore: EventStore = {
      ...eventStore,
      readStream: async (input) => {
        if ((input.fromVersion ?? 1) > 1) {
          throw new Error("synthetic continuation read failure");
        }
        return eventStore.readStream(input);
      },
    };
    await expect(
      createPolicyRuntime({ eventStore: failingStore, db }).readPolicyDocumentState(documentId),
    ).rejects.toThrow("synthetic continuation read failure");

    await eventStore.appendToStream({
      streamId: `platform-policy.document-${documentId}`,
      expectedVersion: 500,
      context,
      events: [{ eventType: "platform-policy.document.unknown", payload: {} }],
    });
    await expect(createPolicyRuntime({ eventStore, db }).readPolicyDocumentState(documentId)).rejects.toThrow(
      "Unhandled variant",
    );
  });
});

describe("caller-chosen policy document creation", () => {
  it("appends one create on the private stream with no_stream and no projection read", async () => {
    const { eventStore: store } = createInMemoryEventStore();
    const { eventStore, appends } = recordAppends(store);
    // A projected overlap would reject the random-id create; this seam must not consult it.
    const { db, queryLog } = createFakePolicyDb({ overlappingDocumentId: "pol_projected_overlap" });
    const runtime = createPolicyRuntime({ eventStore, db });

    await expect(
      runtime.createPolicyDocumentWithId(gracePeriodPolicy, "pol_chosen", createParams, context),
    ).resolves.toEqual({ documentId: "pol_chosen", version: 1 });
    await expect(
      runtime.createPolicyDocumentWithId(gracePeriodPolicy, "pol_chosen", createParams, context),
    ).rejects.toThrow("Policy document has already been created.");

    expect(appends).toEqual([
      { streamId: "platform-policy.document-pol_chosen", expectedVersion: "no_stream", eventCount: 1 },
    ]);
    expect(await store.readStream({ streamId: "platform-policy.document-pol_chosen" })).toMatchObject([
      { streamVersion: 1, eventType: "platform-policy.document.created", payload: { documentId: "pol_chosen" } },
    ]);
    expect(queryLog).toHaveLength(0);
  });

  it("rejects a create that loses the race to a concurrent create of the same id", async () => {
    const { eventStore } = createInMemoryEventStore();
    const { db, documents } = createFakePolicyDb();
    const streamId = "platform-policy.document-pol_raced";
    const racingStore: EventStore = {
      ...eventStore,
      appendToStream: async (input) => {
        // The competing create commits after this command loaded an empty stream.
        await eventStore.appendToStream({ streamId, expectedVersion: "no_stream", context, events: input.events });
        return eventStore.appendToStream(input);
      },
    };

    await expect(
      createPolicyRuntime({ eventStore: racingStore, db }).createPolicyDocumentWithId(
        gracePeriodPolicy,
        "pol_raced",
        createParams,
        context,
      ),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await eventStore.readStream({ streamId })).toHaveLength(1);
    expect(documents.size).toBe(0);
  });

  it("rejects an id whose recorded form would differ from its stream identity", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const { db } = createFakePolicyDb();

    await expect(
      createPolicyRuntime({ eventStore, db }).createPolicyDocumentWithId(
        gracePeriodPolicy,
        " pol_padded",
        createParams,
        context,
      ),
    ).rejects.toThrow("Policy document id must not have surrounding whitespace.");
    expect(allEvents).toHaveLength(0);
  });

  it("keeps the random-id create's projection overlap rejection unchanged", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const { db } = createFakePolicyDb({ overlappingDocumentId: "pol_existing" });

    await expect(
      createPolicyRuntime({ eventStore, db }).createPolicyDocument(gracePeriodPolicy, createParams, context),
    ).rejects.toThrow(
      `Active policy document pol_existing already covers policy '${gracePeriodPolicy.policyKey}' for that effective window.`,
    );
    expect(allEvents).toHaveLength(0);
  });
});

describe("conditional policy document revision", () => {
  const reviseParams = { value: { graceDays: 9 }, ...activeWindow, actorUserId: "usr_admin" };

  it("forwards the expected version to the append boundary", async () => {
    const { eventStore: store } = createInMemoryEventStore();
    await seedDocumentStream(store, "pol_revised", 0);
    const { eventStore, appends } = recordAppends(store);
    const runtime = createPolicyRuntime({ eventStore, db: createFakePolicyDb().db });

    await expect(
      runtime.revisePolicyDocument(gracePeriodPolicy, "pol_revised", reviseParams, context, { expectedVersion: 1 }),
    ).resolves.toEqual({ documentId: "pol_revised", version: 2 });
    expect(appends).toEqual([{ streamId: "platform-policy.document-pol_revised", expectedVersion: 1, eventCount: 1 }]);
  });

  it("appends nothing when the stream moved past the version the caller read", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedDocumentStream(eventStore, "pol_revised", 0);
    const runtime = createPolicyRuntime({ eventStore, db: createFakePolicyDb().db });
    const { version: readVersion } = await runtime.readPolicyDocumentState("pol_revised");
    await runtime.revisePolicyDocument(
      gracePeriodPolicy,
      "pol_revised",
      { ...reviseParams, value: { graceDays: 8 }, actorUserId: "usr_other" },
      context,
    );

    await expect(
      runtime.revisePolicyDocument(gracePeriodPolicy, "pol_revised", reviseParams, context, {
        expectedVersion: readVersion,
      }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(await runtime.readPolicyDocumentState("pol_revised")).toMatchObject({
      version: 2,
      state: { value: { graceDays: 8 } },
    });
  });

  it("keeps four-argument revisions on the loaded version and the overlap rejection", async () => {
    const { eventStore: store } = createInMemoryEventStore();
    await seedDocumentStream(store, "pol_revised", 0);
    const { eventStore, appends } = recordAppends(store);

    await createPolicyRuntime({ eventStore, db: createFakePolicyDb().db }).revisePolicyDocument(
      gracePeriodPolicy,
      "pol_revised",
      reviseParams,
      context,
    );
    await expect(
      createPolicyRuntime({
        eventStore,
        db: createFakePolicyDb({ overlappingDocumentId: "pol_other" }).db,
      }).revisePolicyDocument(gracePeriodPolicy, "pol_revised", reviseParams, context),
    ).rejects.toThrow("Active policy document pol_other already covers");
    expect(appends).toEqual([{ streamId: "platform-policy.document-pol_revised", expectedVersion: 1, eventCount: 1 }]);
  });
});
