import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createChannelConnectionsOperatorReadSourceFromReadModel } from "./operator-read-source";

function database(count: number) {
  const connections = Array.from({ length: count }, (_, index) => ({
    connection_id: `connection-${String(index).padStart(5, "0")}`,
    account_id: `account-${index % 2}`,
    provider_key: "ebay",
    status: index % 2 ? "disconnected" : "active",
    credential_reference: "MUST-NOT-CROSS",
  }));
  const query = vi.fn<PgQueryable["query"]>().mockImplementation(async (sql, values = []) => {
    if (sql.includes("channel_connection_health")) {
      expect((values[0] as string[]).length).toBeLessThanOrEqual(100);
      return {
        rows: (values[0] as string[]).map((id) => ({
          connection_id: id,
          state: "healthy",
          observed_at: "2020-01-01T00:00:00Z",
          evidence: "MUST-NOT-CROSS",
        })),
      };
    }
    expect(sql).not.toContain("account_id =");
    expect(sql).not.toContain("status =");
    return {
      rows: connections
        .filter((row) => values[0] === null || row.connection_id > String(values[0]))
        .slice(0, Number(values[1] ?? 1)),
    };
  });
  return { query };
}

describe("Channels operator read source", () => {
  it.each([0, 1, 100, 101, 1000, 1001])("proves completion or marks the page-cap tail for %i rows", async (count) => {
    const db = database(count);
    const result = await createChannelConnectionsOperatorReadSourceFromReadModel(db)();
    expect(result.complete).toBe(count <= 1000);
    expect(result.rows).toHaveLength(Math.min(count, 1000));
    expect(db.query.mock.calls.length).toBeLessThanOrEqual(21);
    expect(JSON.stringify(result)).not.toContain("MUST-NOT-CROSS");
    for (const row of result.rows)
      expect(row).toMatchObject({ credentialReadiness: "unknown", destination: null, freshness: null });
    if (count > 1) expect(result.rows[1]).toMatchObject({ accountId: "account-1", status: "disconnected" });
  });

  it("propagates a failed read rather than reporting an empty home", async () => {
    const query = vi.fn<PgQueryable["query"]>().mockRejectedValue(new Error("offline"));
    await expect(createChannelConnectionsOperatorReadSourceFromReadModel({ query })()).rejects.toThrow("offline");
  });
});
