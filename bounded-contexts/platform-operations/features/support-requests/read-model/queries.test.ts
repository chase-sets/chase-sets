import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { describe, expect, it } from "vitest";
import {
  findOpenSupportRequestForOrder,
  getSupportOperationsRequest,
  getSupportRequestByDisplayReference,
  listSupportRequestsReadyForAutoClose,
  listSupportOperationsQueue,
} from "./queries";

type QueryCall = Readonly<{ sql: string; params: readonly unknown[] }>;

function buildDb(calls: QueryCall[], countValue = "0", rows: unknown[] = []): PgQueryable {
  return {
    async query<Row = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: countValue } as Row] };
      }
      return { rows: rows as Row[] };
    },
  };
}

describe("support operations queue read-model query", () => {
  it("guards duplicate intake across every open flow for an order", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls, "0", [
      {
        support_request_id: "sup_existing",
        display_reference: "SUP-EXISTING",
        flow_type: "product-damaged",
        status: "waiting-on-seller",
      },
    ]);

    const existing = await findOpenSupportRequestForOrder(db, { orderId: "ord_1" });

    expect(existing).toMatchObject({ support_request_id: "sup_existing", flow_type: "product-damaged" });
    expect(calls[0]?.sql).toContain("WHERE order_id = $1");
    expect(calls[0]?.sql).not.toContain("flow_type =");
    expect(calls[0]?.params).toEqual(["ord_1"]);
  });

  it("exposes the display reference in queue DTOs and supports indexed reference lookup", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls, "1", [
      { support_request_id: "sup_01", display_reference: "SUP-E6K7M8N9", status: "open", flow_type: "missing-item" },
    ]);

    const result = await getSupportRequestByDisplayReference(db, "SUP-E6K7M8N9");

    expect(result).toEqual({
      support_request_id: "sup_01",
      display_reference: "SUP-E6K7M8N9",
      status: "open",
      flow_type: "missing-item",
    });
    expect(calls[0]?.sql).toContain("WHERE display_reference = $1");
    expect(calls[0]?.params).toEqual(["SUP-E6K7M8N9"]);
  });

  it("applies only the now-timestamp filter when no status, priority, or search is supplied", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z" });

    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
    expect(calls[0]?.sql).not.toContain("status = $2");
    expect(calls[0]?.sql).not.toContain("priority = $2");
    expect(calls[0]?.sql).not.toContain("ILIKE");
  });

  it("filters by status and priority when both are recognized values", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      status: "ready-for-support",
      priority: "urgent",
    });

    expect(calls[0]?.sql).toContain("status = $2");
    expect(calls[0]?.sql).toContain("priority = $3");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z", "ready-for-support", "urgent"]);
  });

  it("ignores unrecognized status and priority filter values", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      status: "not-a-real-status",
      priority: "not-a-real-priority",
    });

    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
    expect(calls[0]?.sql).not.toContain("status = $2");
    expect(calls[0]?.sql).not.toContain("priority = $2");
  });

  it("escapes the search term and searches request, order, and account identifiers", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z", search: "ord_100%_test" });

    expect(calls[0]?.sql).toContain("support_request_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.sql).toContain("order_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.sql).toContain("buyer_account_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.sql).toContain("seller_account_id ILIKE $2 ESCAPE '\\'");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z", "%ord\\_100\\%\\_test%"]);
  });

  it("combines account scoping with status, priority, and search filters using stable parameter ordering", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls, "1", [{ support_request_id: "sup_1" }]);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      accountId: "acc_seller",
      status: "waiting-on-seller",
      priority: "normal",
      search: "sup1",
      limit: 10,
      offset: 20,
    });

    expect(calls[0]?.params).toEqual([
      "2026-06-01T00:00:00.000Z",
      "acc_seller",
      "waiting-on-seller",
      "normal",
      "%sup1%",
    ]);
    expect(calls[1]?.params).toEqual([
      "2026-06-01T00:00:00.000Z",
      "acc_seller",
      "waiting-on-seller",
      "normal",
      "%sup1%",
      10,
      20,
    ]);
    expect(calls[1]?.sql).toContain("LIMIT $6 OFFSET $7");
  });

  it("orders the attention queue by the earliest deadline before using urgency as a tie-breaker", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z" });

    const itemQuery = calls[1]?.sql ?? "";
    expect(itemQuery.indexOf("LEAST(")).toBeGreaterThan(-1);
    expect(itemQuery.indexOf("CASE WHEN priority = 'urgent'")).toBeGreaterThan(itemQuery.indexOf("LEAST("));
  });

  it("sorts contested cases first, ahead of the deadline ordering", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z" });

    const itemQuery = calls[1]?.sql ?? "";
    const contestedOrderIndex = itemQuery.indexOf("CASE WHEN (");
    expect(contestedOrderIndex).toBeGreaterThan(-1);
    expect(contestedOrderIndex).toBeLessThan(itemQuery.indexOf("LEAST("));
    expect(itemQuery).toContain(`responses @> '[{"responseType":"challenge-with-evidence"}]'::jsonb`);
    expect(itemQuery).toContain(`offers @> '[{"status":"declined"}]'::jsonb`);
  });

  it("exposes a computed contested flag on queue rows", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z" });

    expect(calls[1]?.sql).toContain("AS contested");
  });

  it("narrows the queue to contested cases when the contested filter is set", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z", contested: true });

    expect(calls[0]?.sql).toContain("escalated_by_role IN ('buyer', 'seller')");
    // Contested is a parameter-free predicate, so no new bind parameters appear.
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
  });

  it("narrows the queue to overdue cases against the now timestamp when the overdue filter is set", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportOperationsQueue(db, { now: "2026-06-01T00:00:00.000Z", overdue: true });

    expect(calls[0]?.sql).toContain("seller_response_due_at <= $1::timestamptz");
    expect(calls[0]?.sql).toContain("support_review_due_at <= $1::timestamptz");
    expect(calls[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
  });

  it("filters by flow type when it is a recognized flow, ignoring unknown flows", async () => {
    const recognized: QueryCall[] = [];
    const unknown: QueryCall[] = [];

    await listSupportOperationsQueue(buildDb(recognized), {
      now: "2026-06-01T00:00:00.000Z",
      flowType: "product-not-as-described",
    });
    await listSupportOperationsQueue(buildDb(unknown), {
      now: "2026-06-01T00:00:00.000Z",
      flowType: "not-a-real-flow",
    });

    expect(recognized[0]?.sql).toContain("flow_type = $2");
    expect(recognized[0]?.params).toEqual(["2026-06-01T00:00:00.000Z", "product-not-as-described"]);
    expect(unknown[0]?.sql).not.toContain("flow_type = $2");
    expect(unknown[0]?.params).toEqual(["2026-06-01T00:00:00.000Z"]);
  });

  it("keeps flow type after search in the parameter ordering so existing binds are stable", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls, "1", [{ support_request_id: "sup_1" }]);

    await listSupportOperationsQueue(db, {
      now: "2026-06-01T00:00:00.000Z",
      accountId: "acc_seller",
      status: "waiting-on-seller",
      priority: "normal",
      search: "sup1",
      flowType: "return-request",
    });

    expect(calls[0]?.params).toEqual([
      "2026-06-01T00:00:00.000Z",
      "acc_seller",
      "waiting-on-seller",
      "normal",
      "%sup1%",
      "return-request",
    ]);
  });

  it("exposes an explicit legacy responsibility interpretation from pre-change read-model JSON", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls, "0", [
      {
        support_request_id: "sup_legacy",
        flow_type: "product-not-received",
        resolution: {
          resolutionType: "full-refund",
          summary: "Historical refund.",
          refundAmount: "25.00",
          resolvedByAccountId: null,
          resolvedByRole: null,
          resolvedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);

    await expect(getSupportOperationsRequest(db, "sup_legacy")).resolves.toMatchObject({
      resolution: {
        responsibility: "undetermined",
        evidenceBasis: { type: "legacy" },
        responsibilityReasonCode: "product-not-received.legacy-resolution-without-responsibility",
      },
    });
  });

  it("keeps live legacy rows auto-close eligible while requiring explicit eligibility for remedy rows", async () => {
    const calls: QueryCall[] = [];
    const db = buildDb(calls);

    await listSupportRequestsReadyForAutoClose(db, { now: "2026-07-14T00:00:00.000Z" });

    expect(calls[0]?.sql).toContain("(closure_eligible = true OR remedy IS NULL)");
    expect(calls[0]?.sql).toContain("auto_close_due_at <= $1::timestamptz");
  });
});
