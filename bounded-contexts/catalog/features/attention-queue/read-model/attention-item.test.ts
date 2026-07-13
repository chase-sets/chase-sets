import { describe, expect, it } from "vitest";
import { sortCatalogAttentionItems, summarizeCatalogAttentionItems, type CatalogAttentionItem } from "./attention-item";

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

describe("summarizeCatalogAttentionItems", () => {
  it("counts by severity and kind and cannot disagree with the list length", () => {
    const items = [
      item({ itemKey: "a", kind: "merge-conflict", severity: "critical", observedAt: "2026-07-01T00:00:00.000Z" }),
      item({ itemKey: "b", kind: "provider-health", severity: "critical", observedAt: "2026-07-01T00:00:00.000Z" }),
      item({ itemKey: "c", kind: "alias-candidate", severity: "info", observedAt: "2026-07-01T00:00:00.000Z" }),
    ];
    const counts = summarizeCatalogAttentionItems(items);
    expect(counts.total).toBe(items.length);
    expect(counts.bySeverity.critical).toBe(2);
    expect(counts.bySeverity.info).toBe(1);
    expect(counts.byKind["merge-conflict"]).toBe(1);
    expect(counts.byKind["provider-health"]).toBe(1);
  });
});
