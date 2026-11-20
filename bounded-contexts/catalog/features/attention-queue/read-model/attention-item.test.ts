import { describe, expect, it } from "vitest";
import {
  CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT,
  CATALOG_ATTENTION_ITEM_KINDS,
  CATALOG_ATTENTION_KIND_SEVERITIES,
  CATALOG_ATTENTION_SUMMARY_WINDOW,
  catalogAttentionKindWindow,
  sortCatalogAttentionItems,
  type CatalogAttentionItem,
} from "./attention-item";

function item(
  overrides: Partial<CatalogAttentionItem> & Pick<CatalogAttentionItem, "itemKey" | "severity" | "observedAt" | "kind">,
): CatalogAttentionItem {
  return {
    titleKey: "t",
    titleParams: {},
    detailKey: "d",
    detailParams: {},
    providerKey: null,
    unitKey: null,
    resolution: { intent: "review", mode: "drawer", labelKey: "l", fields: {} },
    secondaryResolutions: [],
    ...overrides,
  };
}

describe("sortCatalogAttentionItems", () => {
  it("orders critical before warning before info", () => {
    const sorted = sortCatalogAttentionItems([
      item({ itemKey: "a", kind: "alias-candidate", severity: "info", observedAt: "2026-07-01T00:00:00.000Z" }),
      item({ itemKey: "b", kind: "merge-conflict", severity: "critical", observedAt: "2026-07-01T00:00:00.000Z" }),
      item({ itemKey: "c", kind: "unmapped-scope", severity: "warning", observedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.severity)).toEqual(["critical", "warning", "info"]);
  });

  it("surfaces the most-aged item first within a severity band", () => {
    const sorted = sortCatalogAttentionItems([
      item({ itemKey: "new", kind: "merge-conflict", severity: "critical", observedAt: "2026-07-05T00:00:00.000Z" }),
      item({ itemKey: "old", kind: "merge-conflict", severity: "critical", observedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.itemKey)).toEqual(["old", "new"]);
  });

  it("is a stable, total order via the item-key tiebreak", () => {
    const sorted = sortCatalogAttentionItems([
      item({ itemKey: "z", kind: "import-job", severity: "warning", observedAt: "2026-07-01T00:00:00.000Z" }),
      item({ itemKey: "a", kind: "import-job", severity: "warning", observedAt: "2026-07-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((entry) => entry.itemKey)).toEqual(["a", "z"]);
  });
});

describe("catalogAttentionKindWindow", () => {
  it("gives every kind the summary window and only the paged kind a named-kind window", () => {
    const summary = { kind: null, offset: 0, limit: CATALOG_ATTENTION_DEFAULT_WINDOW_LIMIT } as const;
    expect(CATALOG_ATTENTION_SUMMARY_WINDOW).toEqual(summary);
    for (const kind of CATALOG_ATTENTION_ITEM_KINDS) {
      expect(catalogAttentionKindWindow(summary, kind)).toEqual({ offset: 0, limit: 20 });
      expect(catalogAttentionKindWindow({ kind: null, offset: 40, limit: 200 }, kind)).toEqual({
        offset: 40,
        limit: 200,
      });
    }

    const paged = { kind: "unmapped-scope", offset: 200, limit: 200 } as const;
    expect(catalogAttentionKindWindow(paged, "unmapped-scope")).toEqual({ offset: 200, limit: 200 });
    for (const kind of CATALOG_ATTENTION_ITEM_KINDS.filter((candidate) => candidate !== "unmapped-scope")) {
      expect(catalogAttentionKindWindow(paged, kind)).toEqual({ offset: 0, limit: 0 });
    }
  });

  it("declares a producible severity set for every kind", () => {
    expect(Object.keys(CATALOG_ATTENTION_KIND_SEVERITIES).sort()).toEqual([...CATALOG_ATTENTION_ITEM_KINDS].sort());
    expect(CATALOG_ATTENTION_KIND_SEVERITIES["import-job"]).toEqual(["critical", "warning"]);
    expect(CATALOG_ATTENTION_KIND_SEVERITIES["merge-conflict"]).toEqual(["critical", "warning"]);
  });
});
