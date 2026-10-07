import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { deriveDisplayReference } from "@chase-sets/primitives/display-reference";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { module as platformOperationsModule } from "../../../index";
import { listSupportOperationsQueue } from "./queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["platform-operations"] as const;
const now = "2026-06-01T00:00:00.000Z";
const future = "2026-06-02T00:00:00.000Z";
const past = "2026-05-31T00:00:00.000Z";
const unresolvedStatuses = ["open", "waiting-on-buyer", "waiting-on-seller", "ready-for-support"] as const;
const terminalStatuses = ["resolved", "closed", "cancelled"] as const;

describeDb("support operations queue real-schema filtering", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "support_queue_filters");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools["platform-operations"];
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(platformOperationsModule.schemaSql);
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function insertCase(
    status: string,
    options: Readonly<{
      priority?: string;
      deadline?: string | null;
      conditionDeadline?: string | null;
      reviewDeadline?: string | null;
      gate?: string;
      presentation?: string;
      contested?: boolean;
      flowType?: string;
      buyer?: string;
    }> = {},
  ) {
    const id = createId("sup");
    const reference = deriveDisplayReference(id);
    const buyer = options.buyer ?? createId("acc");
    await pool.query(
      `INSERT INTO support_request_pages (
        support_request_id, display_reference, order_id, buyer_account_id, seller_account_id,
        flow_type, status, priority, opened_by_account_id, opened_by_role, opened_at, updated_at,
        seller_response_due_at, support_review_due_at, seller_condition_attestation_due_at,
        return_refund_gate_status, case_presentation, responses, resolution
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $4, 'buyer', $9, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        reference,
        createId("ord"),
        buyer,
        createId("acc"),
        options.flowType ?? "return-request",
        status,
        options.priority ?? "normal",
        now,
        options.deadline === undefined ? future : options.deadline,
        options.reviewDeadline ?? future,
        options.conditionDeadline ?? null,
        options.gate ?? null,
        options.presentation ?? "decision-pending",
        JSON.stringify(options.contested ? [{ responseType: "challenge-with-evidence" }] : []),
        options.gate ? JSON.stringify({ resolutionType: "return-for-refund" }) : null,
      ],
    );
    return { id, reference };
  }

  function ids(result: Awaited<ReturnType<typeof listSupportOperationsQueue>>) {
    return result.items.map((item) => item.support_request_id).sort();
  }

  it("AC1 includes every unresolved status at normal, urgent and overdue priority/deadline states once", async () => {
    const expected: string[] = [];
    for (const status of unresolvedStatuses) {
      for (const options of [{}, { priority: "urgent" }, { deadline: past }]) {
        expected.push((await insertCase(status, options)).id);
      }
    }
    for (const status of terminalStatuses) {
      await insertCase(status, { priority: "urgent", deadline: past, presentation: "action-required" });
    }
    const result = await listSupportOperationsQueue(pool, { now, status: "unresolved" });
    expect(result.total).toBe(expected.length);
    expect(ids(result)).toEqual(expected.sort());
  });

  it.each(terminalStatuses)("AC2 finds ordinary %s cases by explicit status", async (status) => {
    const target = await insertCase(status);
    await insertCase("open");
    const result = await listSupportOperationsQueue(pool, { now, status });
    expect(result.total).toBe(1);
    expect(ids(result)).toEqual([target.id]);
  });

  it("AC2 finds a resolved case by id and SUP reference from the default view", async () => {
    const target = await insertCase("resolved");
    await insertCase("open", { priority: "urgent" });
    for (const search of [target.id, target.reference]) {
      const result = await listSupportOperationsQueue(pool, { now, search });
      expect(result.total).toBe(1);
      expect(ids(result)).toEqual([target.id]);
    }
    expect((await listSupportOperationsQueue(pool, { now, status: "closed", search: target.id })).total).toBe(0);
  });

  it("AC3 preserves the prior default admission including terminal disputed and action-required cases", async () => {
    const excluded = await insertCase("open");
    for (const status of terminalStatuses) await insertCase(status, { priority: "urgent", deadline: past });
    await insertCase("waiting-on-seller", { deadline: null });
    const expected = [
      await insertCase("open", { priority: "urgent" }),
      await insertCase("waiting-on-seller", { deadline: past }),
      await insertCase("waiting-on-buyer", { reviewDeadline: now }),
      await insertCase("open", { conditionDeadline: past }),
      await insertCase("ready-for-support"),
      await insertCase("resolved", { gate: "return-condition-disputed" }),
      await insertCase("closed", { presentation: "action-required" }),
    ]
      .map((item) => item.id)
      .sort();
    const before = await pool.query<{ support_request_id: string }>(
      `SELECT support_request_id FROM support_request_pages WHERE (
        (status NOT IN ('resolved', 'closed', 'cancelled') AND (
          priority = 'urgent' OR seller_response_due_at <= $1::timestamptz
          OR support_review_due_at <= $1::timestamptz OR seller_condition_attestation_due_at <= $1::timestamptz
          OR status = 'ready-for-support'))
        OR return_refund_gate_status = 'return-condition-disputed' OR case_presentation = 'action-required')`,
      [now],
    );
    expect(before.rows.map((row) => row.support_request_id).sort()).toEqual(expected);
    for (const params of [{}, { status: "all" }, { status: "unknown-status", search: "  " }]) {
      const result = await listSupportOperationsQueue(pool, { now, ...params });
      expect(result.total).toBe(expected.length);
      expect(ids(result)).toEqual(expected);
      expect(ids(result)).not.toContain(excluded.id);
    }
  });

  it.each(["unresolved", "resolved"])(
    "AC4 keeps %s totals and disjoint rows consistent across pages",
    async (status) => {
      const expected: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        expected.push((await insertCase(status === "unresolved" ? unresolvedStatuses[index % 4]! : status)).id);
      }
      await insertCase("cancelled");
      const pages = await Promise.all(
        [0, 2, 4, 6].map((offset) => listSupportOperationsQueue(pool, { now, status, limit: 2, offset })),
      );
      expect(pages.map((page) => page.total)).toEqual([5, 5, 5, 5]);
      expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1, 0]);
      expect(pages.flatMap(ids).sort()).toEqual(expected.sort());
    },
  );

  it("keeps account, search, priority, flow, contested and overdue constraints in explicit views", async () => {
    const buyer = createId("acc");
    const matching = { buyer, priority: "normal", deadline: past, contested: true, flowType: "return-request" };
    const target = await insertCase("open", matching);
    await insertCase("resolved", matching);
    await insertCase("open", { ...matching, buyer: createId("acc") });
    await insertCase("open", { ...matching, priority: "urgent" });
    await insertCase("open", { ...matching, flowType: "refund-status" });
    await insertCase("open", { ...matching, contested: false });
    await insertCase("open", { ...matching, deadline: future });
    const params = {
      now,
      status: "unresolved",
      accountId: buyer,
      priority: "normal",
      flowType: "return-request",
      contested: true,
      overdue: true,
    };
    expect(ids(await listSupportOperationsQueue(pool, params))).toEqual([target.id]);
    expect(ids(await listSupportOperationsQueue(pool, { ...params, search: target.reference }))).toEqual([target.id]);
  });
});
