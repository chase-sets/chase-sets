import { describe, expect, it } from "vitest";
import type { SavedListId, SavedListLineId } from "./preview-contract";
import type { SavedListPreviewContent, SavedListPreviewLine } from "./preview-contract";
import { buildSavedListPreviewMetadata, isSavedListPreviewIndexable } from "./preview-metadata";

function line(overrides: Partial<SavedListPreviewLine> = {}): SavedListPreviewLine {
  return {
    lineId: "sll_1" as SavedListLineId,
    position: 1,
    productName: "Prismatic Evolutions Booster Box",
    productHref: "/catalog/prismatic-evolutions",
    optionLabels: ["Sealed", "English"],
    imageUrl: "https://cdn.example.com/box.png",
    availability: "active",
    trackedQuantity: 3,
    estimatedValue: { amount: "120.00", currencyCode: "USD" },
    ...overrides,
  };
}

function content(overrides: Partial<SavedListPreviewContent> = {}): SavedListPreviewContent {
  return {
    listId: "svl_1" as SavedListId,
    title: "Grail chase set",
    description: "The cards I am hunting.",
    visibility: "public",
    owner: { displayName: "Ada", profileHref: "/accounts/ada", avatarUrl: null },
    coverImageUrl: "https://cdn.example.com/cover.png",
    disclosure: { showTrackedQuantities: true, showEstimatedValue: true },
    lines: [line()],
    lineCount: 1,
    valuation: {
      totalEstimatedValue: { amount: "120.00", currencyCode: "USD" },
      valuedLineCount: 1,
      totalLineCount: 1,
      asOf: "2026-07-10T00:00:00.000Z",
    },
    pagination: { page: 1, pageSize: 24, totalPages: 1 },
    changedAt: "2026-07-10T00:00:00.000Z",
    version: 4,
    canSaveCopy: true,
    seoIndexable: true,
    ...overrides,
  };
}

describe("buildSavedListPreviewMetadata", () => {
  it("marks a public list under explicit posture as indexable", () => {
    const meta = buildSavedListPreviewMetadata(content(), { title: "Grail chase set" });

    expect(isSavedListPreviewIndexable(content())).toBe(true);
    expect(meta.robots).toBe("index, follow");
    expect(meta.includeInSitemap).toBe(true);
    expect(meta.descriptors).toContainEqual({ name: "robots", content: "index, follow" });
  });

  it("keeps a public list without posture out of the index and sitemap", () => {
    const meta = buildSavedListPreviewMetadata(content({ seoIndexable: false }), { title: "Grail chase set" });

    expect(meta.robots).toBe("noindex, nofollow");
    expect(meta.includeInSitemap).toBe(false);
  });

  it("always keeps an unlisted list noindex and absent from sitemaps", () => {
    const unlisted = content({ visibility: "unlisted", seoIndexable: true });
    const meta = buildSavedListPreviewMetadata(unlisted, { title: "Grail chase set" });

    expect(isSavedListPreviewIndexable(unlisted)).toBe(false);
    expect(meta.robots).toBe("noindex, nofollow");
    expect(meta.includeInSitemap).toBe(false);
  });

  it("emits structured metadata that matches the visible list exactly", () => {
    const meta = buildSavedListPreviewMetadata(content(), { title: "Grail chase set" });

    expect(meta.jsonLd["@type"]).toBe("ItemList");
    expect(meta.jsonLd.name).toBe("Grail chase set");
    expect(meta.jsonLd.numberOfItems).toBe(1);
    expect(meta.jsonLd.itemListElement).toHaveLength(1);
    expect(meta.jsonLd.itemListElement[0]).toMatchObject({
      "@type": "ListItem",
      name: "Prismatic Evolutions Booster Box",
      url: "/catalog/prismatic-evolutions",
      offers: { "@type": "Offer", price: "120.00", priceCurrency: "USD" },
    });
  });

  it("never leaks estimated value into metadata when value disclosure is off", () => {
    const hidden = content({ disclosure: { showTrackedQuantities: true, showEstimatedValue: false } });
    const meta = buildSavedListPreviewMetadata(hidden, { title: "Grail chase set" });
    const serialized = JSON.stringify(meta);

    expect(serialized).not.toContain("120.00");
    expect(serialized).not.toContain("Offer");
    expect(meta.jsonLd.itemListElement[0].offers).toBeUndefined();
  });

  it("omits removed lines from structured metadata", () => {
    const withRemoved = content({
      lines: [line(), line({ lineId: "sll_2" as SavedListLineId, position: 2, availability: "removed" })],
      lineCount: 2,
    });
    const meta = buildSavedListPreviewMetadata(withRemoved, { title: "Grail chase set" });

    expect(meta.jsonLd.itemListElement).toHaveLength(1);
    expect(meta.jsonLd.numberOfItems).toBe(2);
  });
});
