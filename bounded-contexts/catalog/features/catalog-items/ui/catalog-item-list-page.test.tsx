// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogItemListPage } from "./catalog-item-list-page";
import type { CatalogItemListItem } from "./contracts";

const {
  mockPreviewBulkCatalogItemEdit,
  mockPreviewBulkPublishCatalogItems,
  mockUseNavigation,
  mockUseRevalidator,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockPreviewBulkCatalogItemEdit: vi.fn(),
  mockPreviewBulkPublishCatalogItems: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseRevalidator: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useNavigation: mockUseNavigation,
  useRevalidator: mockUseRevalidator,
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-catalog-items", () => ({
  confirmBulkCatalogItemEdit: vi.fn(),
  confirmBulkCatalogItemLifecycle: vi.fn(),
  confirmBulkPublishCatalogItems: vi.fn(),
  createCatalogItem: vi.fn(),
  localizedTextMapFromEnglish: (value: string) => ({ defaultLocale: "en", values: { en: value } }),
  previewBulkCatalogItemEdit: mockPreviewBulkCatalogItemEdit,
  previewBulkCatalogItemLifecycle: vi.fn(),
  previewBulkPublishCatalogItems: mockPreviewBulkPublishCatalogItems,
}));

const catalogItem: CatalogItemListItem = {
  catalog_item_id: "cat_1",
  language_code: "en",
  title_i18n: null,
  title: "Charizard",
  subtitle_i18n: null,
  subtitle: "Base Set",
  blueprint: { blueprintId: "bpr_card", name: "Pokemon Card" },
  status: "draft",
  source_providers: ["tcgplayer"],
  tags: [],
  updated_at: "2026-05-16T00:00:00.000Z",
};

describe("CatalogItemListPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("selects rows and previews bulk publish from the list", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockPreviewBulkPublishCatalogItems.mockResolvedValue({
      mode: "ids",
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [
        {
          catalog_item_id: "cat_1",
          title: "Charizard",
          subtitle: "Base Set",
          status: "draft",
          blueprint_id: "bpr_card",
          blueprint_name: "Pokemon Card",
          source_providers: ["tcgplayer"],
          outcome: "ready",
          reason: null,
          required_field_ids: [],
        },
      ],
    });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ search: "", status: "draft", language: "", source: "tcgplayer", page: 0, pageSize: 50 }}
      />,
    );

    expect(screen.getAllByText("tcgplayer").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Preview Filtered Drafts" })).toBeTruthy();

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    expect(selectRow).toBeTruthy();
    fireEvent.click(selectRow!);
    fireEvent.click(screen.getByRole("button", { name: "Preview Publish" }));

    await waitFor(() => {
      expect(mockPreviewBulkPublishCatalogItems).toHaveBeenCalledWith({
        mode: "ids",
        ids: ["cat_1"],
      });
    });
    expect(await screen.findByText("Bulk Publish Preview")).toBeTruthy();
  });

  it("previews selected shared bulk edits from the list", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockPreviewBulkCatalogItemEdit.mockResolvedValue({
      mode: "ids",
      action: "assignBlueprint",
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [
        {
          catalog_item_id: "cat_1",
          title: "Charizard",
          status: "draft",
          blueprint_id: null,
          category_ids: [],
          tags: [],
          outcome: "ready",
          reason: null,
        },
      ],
    });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ search: "", status: "draft", language: "", source: "tcgplayer", page: 0, pageSize: 50 }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    const blueprintInputs = screen.getAllByLabelText("Blueprint ID");
    fireEvent.change(blueprintInputs[blueprintInputs.length - 1]!, { target: { value: "bpr_card" } });
    const previewEdit = screen.getByRole("button", { name: "Preview Edit" });
    await waitFor(() => {
      expect((previewEdit as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(previewEdit);

    await waitFor(() => {
      expect(mockPreviewBulkCatalogItemEdit).toHaveBeenCalledWith(
        { action: "assignBlueprint", blueprintId: "bpr_card" },
        { mode: "ids", ids: ["cat_1"] },
      );
    });
    expect(await screen.findByText("Bulk Assign Blueprint Preview")).toBeTruthy();
  });

  it("shows archive as the only bulk lifecycle action", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ search: "", status: "active", language: "", source: "tcgplayer", page: 0, pageSize: 50 }}
      />,
    );

    expect(screen.getByLabelText("Action")).toBeTruthy();
    expect(screen.getByText("Archive")).toBeTruthy();
    expect(screen.queryByText("Retire")).toBeNull();
  });
});
