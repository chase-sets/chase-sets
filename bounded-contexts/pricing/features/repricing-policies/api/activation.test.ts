import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { attachWriteConsistencyMiddleware } from "@chase-sets/bounded-context-runtime";
import { getEventCommitMetadata, recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { parseGlobalPosition, type StoredEvent } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, decodeCommitReceipt } from "@chase-sets/http/responses";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { dryRunBody, dryRunContext } from "../../repricing-engine/tests/dry-run-fixture";
import { createRepricingPolicyActivationServices, DryRunRequiredError } from "./activation";

const emptyMetadata = { eventIds: [], sources: [], committedEvents: [], maxGlobalPosition: undefined };
const input = { accountId: "acc_7910", dryRunId: "synthetic_receipt_run", name: "Synthetic receipt test" };

type Failure = "absent" | "rejected" | "append" | "abort" | "commit";

// Only the pool/store are synthetic: activation, transaction handling and HTTP receipt middleware are real.
async function exercise(options: { failure?: Failure; existing?: boolean; prematureRegistration?: boolean } = {}) {
  const statements: string[] = [];
  let appended: readonly StoredEvent[] = [];
  let beforeCommit = getEventCommitMetadata();
  const failure = new Error(`synthetic ${options.failure} failure`);
  const pool: PgTransactionalPool = {
    query: async () => {
      throw new Error("unexpected pool query");
    },
    connect: async () => ({
      release: () => undefined,
      query: async <Row>(sql: string) => {
        statements.push(sql);
        let rows: unknown[] = [];
        if (sql.includes("SELECT run.body"))
          rows =
            options.failure === "absent"
              ? []
              : [
                  {
                    body: dryRunBody,
                    body_hash: hashRepricingDryRunBody(dryRunBody),
                    status: options.failure === "rejected" ? "queued" : "completed",
                    consumed_at: null,
                    job_status: "completed",
                  },
                ];
        else if (sql.includes("UPDATE pricing_repricing_dry_runs")) rows = [{ dry_run_id: input.dryRunId }];
        else if (sql === "COMMIT") {
          beforeCommit = getEventCommitMetadata();
          if (options.failure === "commit") throw failure;
        } else if (sql !== "BEGIN" && sql !== "ROLLBACK") throw new Error(`unexpected query: ${sql}`);
        return { rows: rows as Row[] };
      },
    }),
  };
  const eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction"> = {
    appendToStreamInTransaction: async (_client, request) => {
      expect(request.expectedVersion).toBe("no_stream");
      expect(request.context).toBe(dryRunContext);
      expect(request.wakeSourceContextName).toBe("pricing");
      if (options.failure === "append") throw failure;
      appended = request.events.map((event, index) => ({
        ...event,
        eventId: `evt_synthetic_activation_${index}`,
        streamId: request.streamId,
        streamVersion: index + 1,
        globalPosition: parseGlobalPosition(String(index + 41)),
        tenantId: dryRunContext.tenantId,
        performedByUserId: dryRunContext.audit.performedByUserId,
        forAccountId: dryRunContext.audit.forAccountId,
        metadata: event.metadata ?? {},
        occurredAt: "2026-09-27T00:00:00.000Z" as StoredEvent["occurredAt"],
        recordedAt: "2026-09-27T00:00:00.000Z" as StoredEvent["recordedAt"],
      }));
      if (options.prematureRegistration) recordCommittedEvents(appended, "pricing");
      if (options.failure === "abort") throw failure;
      return appended;
    },
  };
  const services = createRepricingPolicyActivationServices({ pool, eventStore });
  const app = new Hono();
  attachWriteConsistencyMiddleware(app, [{ mountPath: "/activation" }], [], { enabled: false });
  let baseline = getEventCommitMetadata();
  let metadata = baseline;
  let error: unknown;
  app.post("/activation", async (c) => {
    if (options.existing)
      recordCommittedEvents([
        {
          eventId: "evt_synthetic_unrelated",
          streamId: "synthetic-unrelated.event",
          streamVersion: 1,
          globalPosition: parseGlobalPosition("99"),
          tenantId: dryRunContext.tenantId,
          performedByUserId: dryRunContext.audit.performedByUserId,
          forAccountId: dryRunContext.audit.forAccountId,
          eventType: "synthetic.unrelated-committed",
          payload: {},
          metadata: {},
          occurredAt: "2026-09-27T00:00:00.000Z" as StoredEvent["occurredAt"],
          recordedAt: "2026-09-27T00:00:00.000Z" as StoredEvent["recordedAt"],
        },
      ]);
    baseline = getEventCommitMetadata();
    try {
      const state = await services.activateRepricingPolicy(input, dryRunContext);
      return c.json(state, state ? 201 : 404);
    } catch (caught) {
      error = caught;
      return c.json({ error: "activation_rejected" }, 409);
    } finally {
      metadata = getEventCommitMetadata();
    }
  });
  const response = await app.request("/activation", { method: "POST" });
  return { response, metadata, baseline, beforeCommit, appended, statements, error, failure };
}

function expectNoActivationReceipt(result: Awaited<ReturnType<typeof exercise>>) {
  expect(result.metadata).toEqual(result.baseline);
  if (!result.baseline.eventIds.length) {
    for (const name of [
      CHASE_SETS_COMMIT_RECEIPT_HEADER,
      "Chase-Sets-Commit-Position",
      "Chase-Sets-Commit-Event-Ids",
      "Chase-Sets-Consistency",
    ])
      expect(result.response.headers.get(name)).toBeNull();
  } else {
    expect(decodeCommitReceipt(result.response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual(
      result.baseline.sources,
    );
    expect(result.response.headers.get("Chase-Sets-Commit-Position")).toBe(result.baseline.maxGlobalPosition);
    expect(result.response.headers.get("Chase-Sets-Commit-Event-Ids")).toBe(result.baseline.eventIds.join(","));
  }
}

describe("activation transaction receipt boundary", () => {
  it.each([false, true])(
    "registers exact returned StoredEvents only after COMMIT, preserving existing=%s",
    async (existing) => {
      const result = await exercise({ existing });
      expect(result.error).toBeUndefined();
      expect(result.response.status).toBe(201);
      expect(await result.response.json()).toMatchObject({
        ...dryRunBody,
        status: "active",
        name: input.name,
        accountId: input.accountId,
      });
      expect(result.beforeCommit).toEqual(result.baseline);
      expect(result.statements.at(-1)).toBe("COMMIT");
      expect(result.appended).toHaveLength(1);
      const eventIds = [...result.baseline.eventIds, ...result.appended.map((event) => event.eventId)];
      expect(result.metadata.eventIds).toEqual(eventIds);
      expect(result.metadata.committedEvents).toEqual([...result.baseline.committedEvents, ...result.appended]);
      expect(result.metadata.committedEvents.at(-1)).toBe(result.appended[0]);
      expect(result.metadata.sources).toEqual([
        { sourceContextName: "pricing", eventIds: [result.appended[0]!.eventId], maxGlobalPosition: "41" },
        ...result.baseline.sources,
      ]);
      expect(result.metadata.maxGlobalPosition).toBe(existing ? "99" : "41");
      expect(result.response.headers.get("Chase-Sets-Commit-Position")).toBe(result.metadata.maxGlobalPosition);
      expect(result.response.headers.get("Chase-Sets-Commit-Event-Ids")).toBe(eventIds.join(","));
      expect(result.response.headers.get("Chase-Sets-Consistency")).toBe("eventual");
      expect(decodeCommitReceipt(result.response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual(
        result.metadata.sources,
      );
    },
  );

  for (const existing of [false, true]) {
    it.each<Failure>(["absent", "rejected", "append", "abort", "commit"])(
      `emits no activation metadata for %s, preserving existing=${existing}`,
      async (failure) => {
        const result = await exercise({ failure, existing });
        if (failure === "absent") {
          expect(result.response.status).toBe(404);
          expect(result.error).toBeUndefined();
        } else {
          expect(result.response.status).toBe(409);
          if (failure === "rejected") expect(result.error).toBeInstanceOf(DryRunRequiredError);
          else expect(result.error).toBe(result.failure);
          expect(result.statements.at(-1)).toBe("ROLLBACK");
        }
        if (failure === "commit") {
          expect(result.appended).toHaveLength(1);
          expect(result.beforeCommit).toEqual(result.baseline);
        }
        expectNoActivationReceipt(result);
      },
    );
  }

  it("negative control rejects registration in the pre-COMMIT callback after successful append", async () => {
    const result = await exercise({ failure: "commit", prematureRegistration: true });
    expect(result.baseline).toEqual(emptyMetadata);
    expect(result.error).toBe(result.failure);
    expect(result.statements.at(-1)).toBe("ROLLBACK");
    expect(result.beforeCommit.committedEvents).toEqual(result.appended);
    expect(() => expectNoActivationReceipt(result)).toThrow();
    expect(decodeCommitReceipt(result.response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual([
      { sourceContextName: "pricing", eventIds: [result.appended[0]!.eventId], maxGlobalPosition: "41" },
    ]);
  });
});
