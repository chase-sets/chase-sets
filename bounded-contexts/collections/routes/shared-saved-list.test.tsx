import { describe, expect, it } from "vitest";
import { meta } from "./shared-saved-list";
import type {
  SavedListId,
  SavedListLineId,
  SavedListPreview,
  SavedListPreviewContent,
} from "../features/saved-lists/ui";

type MetaArgs = Parameters<NonNullable<typeof meta>>[0];
type MetaDescriptor = { title?: string; name?: string; property?: string; content?: string };

function content(overrides: Partial<SavedListPreviewContent> = {}): SavedListPreviewContent {
  return {
    listId: "svl_1" as SavedListId,
    title: "Grail chase set",
    description: "The cards I am hunting.",
    visibility: "public",
    owner: { displayName: "Ada", profileHref: "/accounts/ada", avatarUrl: null },
    coverImageUrl: null,
    disclosure: { showTrackedQuantities: true, showEstimatedValue: false },
    lines: [
      {
        lineId: "sll_1" as SavedListLineId,
        position: 1,
        productName: "Prismatic Evolutions Booster Box",
        productHref: "/catalog/prismatic-evolutions",
        optionLabels: [],
        imageUrl: null,
        availability: "active",
        trackedQuantity: 2,
        estimatedValue: null,
      },
    ],
    lineCount: 1,
    valuation: null,
    pagination: { page: 1, pageSize: 24, totalPages: 1 },
    changedAt: "2026-07-10T00:00:00.000Z",
    version: 1,
    canSaveCopy: true,
    seoIndexable: true,
    ...overrides,
  };
}

function runMeta(preview: SavedListPreview): MetaDescriptor[] {
  const result = meta?.({ data: preview } as unknown as MetaArgs);
  return (result ?? []) as MetaDescriptor[];
}

function robotsOf(descriptors: MetaDescriptor[]): string | undefined {
  return descriptors.find((descriptor) => descriptor.name === "robots")?.content;
}

describe("shared saved list route meta", () => {
  it("indexes a public list published under an explicit posture", () => {
    const descriptors = runMeta({ status: "available", content: content() });
    expect(robotsOf(descriptors)).toBe("index, follow");
  });

  it("keeps an unlisted list noindex regardless of posture", () => {
    const descriptors = runMeta({
      status: "available",
      content: content({ visibility: "unlisted", seoIndexable: true }),
    });
    expect(robotsOf(descriptors)).toBe("noindex, nofollow");
  });

  it("keeps a public list without posture noindex", () => {
    const descriptors = runMeta({ status: "available", content: content({ seoIndexable: false }) });
    expect(robotsOf(descriptors)).toBe("noindex, nofollow");
  });

  it("returns a noindex fallback for an unavailable list", () => {
    const descriptors = runMeta({ status: "unavailable", reason: "revoked" });
    expect(robotsOf(descriptors)).toBe("noindex, nofollow");
  });
});
