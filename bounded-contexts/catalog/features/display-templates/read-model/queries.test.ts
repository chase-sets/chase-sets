import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { listDisplayTemplates } from "./queries";

describe("display template read-model queries", () => {
  it("clamps and parameterizes display-template list pagination", async () => {
    const db = queryableSequence([[{ count: "1" }], [{ display_template_id: "dt_1" }]]);

    const result = await listDisplayTemplates(db, {
      status: "active",
      targetKind: "catalog-item",
      search: "title_%",
      limit: "999999999",
      offset: -20,
    });

    expect(result).toEqual({ items: [{ display_template_id: "dt_1" }], total: 1 });
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).toContain("ILIKE $3 ESCAPE '\\'");
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("LIMIT $4 OFFSET $5"), [
      "active",
      "catalog-item",
      "%title\\_\\%%",
      500,
      0,
    ]);
  });
});

function queryableSequence(results: readonly (readonly Record<string, unknown>[])[]): PgQueryable {
  let index = 0;

  return {
    query: vi.fn(async () => {
      const rows = results[Math.min(index, results.length - 1)] ?? [];
      index += 1;
      return {
        rows: [...rows],
        rowCount: rows.length,
      };
    }),
  };
}
