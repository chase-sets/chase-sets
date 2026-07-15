import { describe, expect, it } from "vitest";
import { isSellerAttentionItem, type SellerAttentionContext } from "@chase-sets/seller-attention-queue";
import {
  createImportResolutionAttentionSource,
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

describe("createImportResolutionAttentionSource", () => {
  it("loads rows through the injected query", async () => {
    const source = createImportResolutionAttentionSource({ loadImportResolutionRows: async () => [row()] });
    expect(source.id).toBe("inventory-resolution");
    expect(await source.load(CONTEXT)).toHaveLength(1);
  });
});
