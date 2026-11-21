import { describe, expect, it, vi } from "vitest";
import {
  aggregateSellerAttentionQueue,
  isSellerAttentionItem,
  type SellerAttentionContext,
} from "@chase-sets/seller-attention-queue";
import {
  createImportResolutionAttentionSource,
  createImportResolutionAttentionSourceFromReadModel,
  toImportResolutionAttentionItems,
  type ImportResolutionAttentionRow,
} from "./seller-attention-source";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

// node-postgres hands back a timestamptz column as a Date unless the query reads
// it as text; this fake answers the same way for the column it is asked about.
function pgTimestamp(sql: string, column: string, iso: string): string | Date {
  return sql.includes(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`) ? iso : new Date(iso);
}

function row(overrides: Partial<ImportResolutionAttentionRow> = {}): ImportResolutionAttentionRow {
  return {
    batchId: "batch-1",
    reference: "IMP-1",
    unresolvedCount: 3,
    observedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("toImportResolutionAttentionItems", () => {
  it("maps an unresolved batch to a warning item that opens the resolution drawer over the Desk home", () => {
    const [item] = toImportResolutionAttentionItems([row()]);
    expect(item.severity).toBe("warning");
    expect(item.summary).toEqual({ code: "import-rows-unresolved", params: { reference: "IMP-1", count: 3 } });
    expect(item.deepLink).toEqual({
      surface: "resolution-drawer",
      href: "/account/desk?drawer=resolution-drawer&entity=batch-1",
    });
    expect(isSellerAttentionItem(item, "inventory-resolution")).toBe(true);
  });

  it("drops batches with nothing left to resolve", () => {
    expect(toImportResolutionAttentionItems([row({ unresolvedCount: 0 })])).toHaveLength(0);
  });
});

describe("createImportResolutionAttentionSourceFromReadModel", () => {
  it("queries unresolved rows for only the requested seller account and references each batch by id", async () => {
    const query = vi.fn(async () => ({
      rows: [{ batch_id: "batch-1", unresolved_count: 2, observed_at: "2026-07-13T00:00:00.000Z" }],
    }));

    const items = await createImportResolutionAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("row.resolution_status = 'unresolved'"), ["acct-1"]);
    expect(query).toHaveBeenCalledWith(expect.not.stringContaining("source_filename"), ["acct-1"]);
    expect(items[0]?.summary.params).toEqual({ reference: "batch-1", count: 2 });
  });

  it("reads the batch's time as ISO text, so the queue keeps a nonempty batch", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [
        {
          batch_id: "batch-1",
          unresolved_count: 2,
          observed_at: pgTimestamp(sql, "MIN(row.updated_at)", "2026-07-13T00:00:00.000Z"),
        },
      ],
    }));

    const queue = await aggregateSellerAttentionQueue(
      [createImportResolutionAttentionSourceFromReadModel({ query } as never)],
      CONTEXT,
    );

    expect(queue.sources).toEqual([{ id: "inventory-resolution", status: "available", itemCount: 1 }]);
    expect(queue.items[0]?.observedAt).toBe("2026-07-13T00:00:00.000Z");
  });
});

describe("createImportResolutionAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createImportResolutionAttentionSource({ loadImportResolutionRows: async () => [row()] });
    expect(source.id).toBe("inventory-resolution");
    expect(await source.load(CONTEXT)).toHaveLength(1);
  });
});
