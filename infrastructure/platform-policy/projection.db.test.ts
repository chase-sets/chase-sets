import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import {
  createIsolatedPostgresTestSchema,
  type IsolatedPostgresTestSchema,
} from "@chase-sets/event-core-postgres/postgres-db-test-support";
import { definePolicy } from "./define-policy";
import { buildPolicyDocumentProjectionHandlers } from "./projection";
import { listActivePolicyDocuments } from "./queries";
import { createPolicyRuntime, type PolicyRuntime } from "./runtime";
import { platformPolicySchemaSql } from "./schema";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const context = {
  tenantId: "tnt_policy_projection" as never,
  audit: { performedByUserId: "usr_policy_projection" as never, forAccountId: "acc_policy_projection" as never },
};
const policy = definePolicy({
  policyKey: "pricing.shipping-window",
  contextName: "pricing",
  schemaSummary: "{ days: number }",
  defaultValue: { days: 1 },
  decodeValue(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid policy value");
    return raw as { days: number };
  },
});
const actorUserId = "usr_policy_projection";
const currentWindow = { effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-06-01T00:00:00.000Z" };
const scheduledWindow = { effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveUntil: null };

describeDb("policy document projection over kept rows", () => {
  let schema: IsolatedPostgresTestSchema;
  let eventStore: EventStore;
  let runtime: PolicyRuntime;
  let handlers: ReturnType<typeof buildPolicyDocumentProjectionHandlers>;
  /** The appending process's clock: every event is stamped with its value at the time of the write. */
  let recordedAt: string;

  beforeEach(async () => {
    schema ??= await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "policy_projection");
    await schema.reset();
    await schema.pool.query(platformPolicySchemaSql);
    recordedAt = "2026-03-01T00:00:00.000Z";
    eventStore = createPostgresEventStore({ pool: schema.pool, now: () => recordedAt as never });
    runtime = createPolicyRuntime({ eventStore, db: schema.pool });
    handlers = buildPolicyDocumentProjectionHandlers(schema.pool);
  });

  afterAll(async () => {
    await schema?.close();
  });

  const streamOf = (documentId: string) =>
    eventStore.readStream({ streamId: `platform-policy.document-${documentId}` });

  async function project(event: StoredEvent) {
    const handler = handlers[event.eventType];
    if (!handler) throw new Error(`No policy projection handler for '${event.eventType}'.`);
    await handler(toTransportEvent(event));
  }

  /** Applies a document's newest event, as the projection does once a write commits. */
  async function projectLatest(documentId: string) {
    await project((await streamOf(documentId)).at(-1)!);
  }

  /** Creates and projects the document in force and the one scheduled to follow it. */
  async function createCurrentAndScheduled() {
    const current = await runtime.createPolicyDocument(
      policy,
      { value: { days: 2 }, status: "active", ...currentWindow, actorUserId },
      context,
    );
    await projectLatest(current.documentId);
    const scheduled = await runtime.createPolicyDocument(
      policy,
      { value: { days: 30 }, status: "active", ...scheduledWindow, actorUserId },
      context,
    );
    await projectLatest(scheduled.documentId);
    return { current: current.documentId, scheduled: scheduled.documentId };
  }

  async function revise(
    documentId: string,
    params: Readonly<{
      days: number;
      status?: "active" | "inactive";
      effectiveFrom: string;
      effectiveUntil: string | null;
    }>,
  ) {
    await runtime.revisePolicyDocument(
      policy,
      documentId,
      {
        value: { days: params.days },
        status: params.status ?? "active",
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
        actorUserId,
      },
      context,
    );
    await projectLatest(documentId);
  }

  /** Every column of the document row, so a comparison misses none of them. */
  async function documentRow(documentId: string) {
    const result = await schema.pool.query<Record<string, unknown>>(
      "SELECT * FROM platform_policy_documents WHERE document_id = $1",
      [documentId],
    );
    return result.rows[0] ?? null;
  }

  /** History in the order it was written; `history_id` is a sequence value, so it differs after a truncate. */
  async function historyRows() {
    const result = await schema.pool.query<Record<string, unknown>>(
      `SELECT event_id, document_id, policy_key, event_type, actor_user_id, status, value,
              effective_from, effective_until, recorded_at
       FROM platform_policy_document_history
       ORDER BY history_id ASC`,
    );
    return result.rows;
  }

  const activeSet = () => listActivePolicyDocuments(schema.pool, policy.policyKey);

  it("keeps every column at the latest revision, and the active set unchanged, after each replayed event", async () => {
    const { current, scheduled } = await createCurrentAndScheduled();
    recordedAt = "2026-03-02T00:00:00.000Z";
    await revise(current, { days: 3, status: "inactive", ...currentWindow });
    recordedAt = "2026-03-03T00:00:00.000Z";
    await revise(current, { days: 9, ...currentWindow });
    recordedAt = "2026-03-04T00:00:00.000Z";
    await revise(current, { days: 9, ...currentWindow, effectiveUntil: "2026-05-01T00:00:00.000Z" });
    recordedAt = "2026-03-05T00:00:00.000Z";
    await revise(scheduled, { days: 45, ...scheduledWindow });

    const latestCurrent = await documentRow(current);
    const latestScheduled = await documentRow(scheduled);
    const latestActiveSet = await activeSet();
    const history = await historyRows();
    expect(latestCurrent).toMatchObject({
      status: "active",
      value: { days: 9 },
      effective_until: new Date("2026-05-01T00:00:00.000Z"),
      created_at: new Date("2026-03-01T00:00:00.000Z"),
      updated_at: new Date("2026-03-04T00:00:00.000Z"),
      stream_version: "4",
    });
    expect(latestScheduled).toMatchObject({ value: { days: 45 }, stream_version: "2" });
    expect(latestActiveSet.map((document) => document.document_id)).toEqual([scheduled, current]);
    expect(history).toHaveLength(6);

    const replayed = [...(await streamOf(current)), ...(await streamOf(scheduled))];
    expect(replayed.map((event) => event.streamVersion)).toEqual([1, 2, 3, 4, 1, 2]);
    for (const event of replayed) {
      await project(event);

      expect(await documentRow(current)).toEqual(latestCurrent);
      expect(await documentRow(scheduled)).toEqual(latestScheduled);
      expect(await activeSet()).toEqual(latestActiveSet);
    }
    expect(await historyRows()).toEqual(history);
  });

  it("applies revisions with a tied and an earlier timestamp in stream order, and a replay undoes neither", async () => {
    const { current } = await createCurrentAndScheduled();
    recordedAt = "2026-03-02T00:00:00.000Z";
    await revise(current, { days: 3, ...currentWindow });

    // The same millisecond as the revision before it.
    await revise(current, { days: 4, ...currentWindow });
    expect(await documentRow(current)).toMatchObject({
      value: { days: 4 },
      updated_at: new Date("2026-03-02T00:00:00.000Z"),
      stream_version: "3",
    });

    // A later version stamped by a process whose clock runs behind.
    recordedAt = "2026-03-01T23:59:55.000Z";
    await revise(current, { days: 5, ...currentWindow });
    const latest = await documentRow(current);
    expect(latest).toMatchObject({
      value: { days: 5 },
      updated_at: new Date("2026-03-01T23:59:55.000Z"),
      stream_version: "4",
    });

    const stream = await streamOf(current);
    expect(stream.map((event) => event.recordedAt)).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-02T00:00:00.000Z",
      "2026-03-01T23:59:55.000Z",
    ]);
    const latestActiveSet = await activeSet();
    const history = await historyRows();
    for (const event of stream) {
      await project(event);

      expect(await documentRow(current)).toEqual(latest);
      expect(await activeSet()).toEqual(latestActiveSet);
    }
    expect(await historyRows()).toEqual(history);
  });

  it("rebuilds each row and its history to the latest revision after both tables are truncated", async () => {
    const { current, scheduled } = await createCurrentAndScheduled();
    recordedAt = "2026-03-02T00:00:00.000Z";
    await revise(current, { days: 3, ...currentWindow });
    await revise(current, { days: 4, ...currentWindow });
    recordedAt = "2026-03-01T23:59:55.000Z";
    await revise(current, { days: 5, ...currentWindow });
    await revise(scheduled, { days: 45, ...scheduledWindow });

    const latestCurrent = await documentRow(current);
    const latestScheduled = await documentRow(scheduled);
    const latestActiveSet = await activeSet();
    const history = await historyRows();
    expect(latestCurrent).toMatchObject({ value: { days: 5 }, stream_version: "4" });
    expect(latestScheduled).toMatchObject({ value: { days: 45 }, stream_version: "2" });
    expect(history).toHaveLength(6);

    await schema.pool.query("TRUNCATE TABLE platform_policy_documents, platform_policy_document_history");
    expect(await activeSet()).toEqual([]);

    // The order the events were appended in, which is the order a rebuild replays them in.
    const currentStream = await streamOf(current);
    const scheduledStream = await streamOf(scheduled);
    const replayed = [currentStream[0]!, scheduledStream[0]!, ...currentStream.slice(1), ...scheduledStream.slice(1)];
    await project(replayed[0]!);
    expect(await documentRow(current)).toMatchObject({ value: { days: 2 }, stream_version: "1" });
    for (const event of replayed.slice(1)) {
      await project(event);
    }

    expect(await documentRow(current)).toEqual(latestCurrent);
    expect(await documentRow(scheduled)).toEqual(latestScheduled);
    expect(await activeSet()).toEqual(latestActiveSet);
    expect(await historyRows()).toEqual(history);
  });
});
