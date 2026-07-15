import { describe, expect, it, vi } from "vitest";
import { isSellerAttentionItem, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import {
  createImportResolutionAttentionSource,
  createImportResolutionAttentionSourceFromReadModel,
  toImportResolutionAttentionItems,
  type ImportResolutionAttentionRow,
} from "./seller-attention-source";

const CONTEXT: SellerAttentionContext = { accountId: "acct-1", now: "2026-07-14T12:00:00.000Z" };

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
  it("queries unresolved rows for only the requested seller account", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          batch_id: "batch-1",
          source_filename: "inventory.csv",
          unresolved_count: 2,
          observed_at: "2026-07-13T00:00:00.000Z",
        },
      ],
    }));

    const items = await createImportResolutionAttentionSourceFromReadModel({ query } as never).load(CONTEXT);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("row.resolution_status = 'unresolved'"), ["acct-1"]);
    expect(items[0]?.summary.params).toEqual({ reference: "inventory.csv", count: 2 });
  });
});

describe("createImportResolutionAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createImportResolutionAttentionSource({ loadImportResolutionRows: async () => [row()] });
    expect(source.id).toBe("inventory-resolution");
    expect(await source.load(CONTEXT)).toHaveLength(1);
  });
});
