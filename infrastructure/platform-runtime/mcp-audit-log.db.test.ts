import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresMcpAuditLog, platformMcpAuditLogSchemaSql } from "./mcp-audit-log";
import type { McpAuditRecord } from "./mcp";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;

describe("Postgres MCP audit log", () => {
  let pools: Readonly<Record<"platform", PgTransactionalPool>>;

  beforeAll(async () => {
    if (!adminDatabaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for mcp-audit-log DB tests.");
    }

    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["platform"], "mcp_audit_log");
    await ensureMultiContextTestDatabases(adminDatabaseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.platform.query(platformMcpAuditLogSchemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("persists audit records and lists them for the owning grant, newest first", async () => {
    const auditLog = createPostgresMcpAuditLog(pools.platform);

    const allowed: McpAuditRecord = {
      outcome: "allowed",
      method: "tools/call",
      toolName: "list_cart",
      actorId: "usr_1",
      accountId: "acc_1",
      agentGrantId: "lpa_1",
      agentGrantScopes: ["checkout:read"],
      auditEventName: "cart.viewed",
      targetType: "cart",
    };
    const denied: McpAuditRecord = {
      outcome: "denied",
      method: "tools/call",
      toolName: "request_payout",
      actorId: "usr_1",
      accountId: "acc_1",
      agentGrantId: "lpa_1",
      agentGrantScopes: ["checkout:read"],
      auditEventName: "payout.requested",
      targetType: "payout",
      reason: "Missing scope payouts:request.",
    };

    await auditLog.record(allowed, new Date("2026-07-10T10:00:00.000Z"));
    await auditLog.record(denied, new Date("2026-07-10T10:05:00.000Z"));
    // A record for a different grant on the same account must never leak into lpa_1's activity.
    await auditLog.record({ ...allowed, agentGrantId: "lpa_2" }, new Date("2026-07-10T10:06:00.000Z"));

    const page = await auditLog.listForGrant({ accountId: "acc_1", grantId: "lpa_1", limit: 50, offset: 0 });

    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.toolName)).toEqual(["request_payout", "list_cart"]);
    expect(page.items[0]).toMatchObject({
      outcome: "denied",
      reason: "Missing scope payouts:request.",
      auditEventName: "payout.requested",
    });
  });

  it("never returns activity for a grant that does not belong to the requesting account", async () => {
    const auditLog = createPostgresMcpAuditLog(pools.platform);
    await auditLog.record({
      outcome: "allowed",
      method: "tools/call",
      toolName: "list_cart",
      accountId: "acc_owner",
      agentGrantId: "lpa_shared_id",
    });

    const page = await auditLog.listForGrant({
      accountId: "acc_intruder",
      grantId: "lpa_shared_id",
      limit: 50,
      offset: 0,
    });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it("paginates with limit and offset", async () => {
    const auditLog = createPostgresMcpAuditLog(pools.platform);
    for (let index = 0; index < 5; index += 1) {
      await auditLog.record(
        {
          outcome: "allowed",
          method: "tools/call",
          toolName: `tool_${index}`,
          accountId: "acc_1",
          agentGrantId: "lpa_page",
        },
        new Date(2026, 6, 10, 10, index),
      );
    }

    const page = await auditLog.listForGrant({ accountId: "acc_1", grantId: "lpa_page", limit: 2, offset: 2 });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.toolName)).toEqual(["tool_2", "tool_1"]);
  });
});
