// @vitest-environment jsdom

import { t } from "@chase-sets/localization";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SavedListPreviewPage } from "./saved-list-preview-page";
import type {
  SavedListId,
  SavedListLineId,
  SavedListPreview,
  SavedListPreviewContent,
  SavedListPreviewLine,
} from "./preview-contract";

afterEach(() => cleanup());

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
    owner: { displayName: "Ada Collector", profileHref: "/accounts/ada", avatarUrl: null },
    coverImageUrl: null,
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

function available(overrides: Partial<SavedListPreviewContent> = {}): SavedListPreview {
  return { status: "available", content: content(overrides) };
}

describe("SavedListPreviewPage", () => {
  it("renders the list title, owner reference, and item rows", () => {
    render(<SavedListPreviewPage preview={available()} saveCopyHref="/collections/save-a-copy" />);

    expect(screen.getByRole("heading", { level: 1, name: "Grail chase set" })).toBeTruthy();
    expect(screen.getByText("Prismatic Evolutions Booster Box")).toBeTruthy();
    expect(screen.getByText("Sealed")).toBeTruthy();
    const ownerLink = screen.getByRole("link", { name: "Ada Collector" });
    expect(ownerLink.getAttribute("href")).toBe("/accounts/ada");
  });

  it("renders disclosed tracked quantities and estimated value", () => {
    render(<SavedListPreviewPage preview={available()} />);

    expect(screen.getByText(t("collections.features.savedLists.web.preview.column.quantity"))).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.preview.column.value"))).toBeTruthy();
    expect(screen.getAllByText(/\$120/).length).toBeGreaterThan(0);
  });

  it("never leaks quantity or value into the markup when disclosure is off", () => {
    const { container } = render(
      <SavedListPreviewPage
        preview={available({
          disclosure: { showTrackedQuantities: false, showEstimatedValue: false },
          valuation: null,
        })}
      />,
    );

    expect(screen.queryByText(t("collections.features.savedLists.web.preview.column.quantity"))).toBeNull();
    expect(screen.queryByText(t("collections.features.savedLists.web.preview.column.value"))).toBeNull();
    // The concrete hidden numbers must not appear anywhere in the rendered tree.
    expect(container.textContent ?? "").not.toContain("120");
    expect(container.textContent ?? "").not.toContain("$120");
  });

  it("flags a retired Product and shows no estimate for it", () => {
    render(
      <SavedListPreviewPage
        preview={available({
          lines: [line({ availability: "retired", productHref: null, estimatedValue: null })],
        })}
      />,
    );

    expect(screen.getByText(t("collections.features.savedLists.web.preview.line.retired"))).toBeTruthy();
    expect(screen.getByText(t("collections.features.savedLists.web.preview.line.noEstimate"))).toBeTruthy();
  });

  it("shows a removed line as removed and not a Product link", () => {
    render(
      <SavedListPreviewPage
        preview={available({
          lines: [line({ availability: "removed" })],
        })}
      />,
    );

    expect(screen.getByText(t("collections.features.savedLists.web.preview.line.removed"))).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Prismatic Evolutions Booster Box" })).toBeNull();
  });

  it("renders an empty state when the list has no items", () => {
    render(<SavedListPreviewPage preview={available({ lines: [], lineCount: 0, valuation: null })} />);

    expect(screen.getByText(t("collections.features.savedLists.web.preview.empty.title"))).toBeTruthy();
  });

  it("renders items as an accessible list", () => {
    render(
      <SavedListPreviewPage
        preview={available({
          lines: [line(), line({ lineId: "sll_2" as SavedListLineId, position: 2, productName: "Surging Sparks" })],
          lineCount: 2,
        })}
      />,
    );

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("embeds structured metadata that matches the visible list", () => {
    const { container } = render(<SavedListPreviewPage preview={available()} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeTruthy();

    const parsed = JSON.parse(script?.textContent ?? "{}");
    expect(parsed["@type"]).toBe("ItemList");
    expect(parsed.name).toBe("Grail chase set");
    expect(parsed.itemListElement).toHaveLength(1);
  });

  it("shows the revoked state for an unavailable link", () => {
    render(<SavedListPreviewPage preview={{ status: "unavailable", reason: "revoked" }} />);

    expect(screen.getByText(t("collections.features.savedLists.web.preview.unavailable.revoked.title"))).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Grail chase set" })).toBeNull();
  });
});
