// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogItemListPage } from "./catalog-item-list-page";
import type { CatalogItemListItem } from "./contracts";

const {
  mockPreviewBulkCatalogItemEdit,
  mockPreviewBulkCatalogItemLifecycle,
  mockPreviewBulkPublishCatalogItems,
  mockRemoveDraftCatalogItem,
  mockUseNavigation,
  mockUseRevalidator,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockPreviewBulkCatalogItemEdit: vi.fn(),
  mockPreviewBulkCatalogItemLifecycle: vi.fn(),
  mockPreviewBulkPublishCatalogItems: vi.fn(),
  mockRemoveDraftCatalogItem: vi.fn(),
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
  previewBulkCatalogItemLifecycle: mockPreviewBulkCatalogItemLifecycle,
  previewBulkPublishCatalogItems: mockPreviewBulkPublishCatalogItems,
  removeDraftCatalogItem: mockRemoveDraftCatalogItem,
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

  it("previews bulk publish for matching draft Catalog Items", async () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockPreviewBulkPublishCatalogItems.mockResolvedValue({
      mode: "filter",
      item_ids: ["cat_1", "cat_2"],
      total: 2,
      ready_count: 1,
      blocked_count: 1,
      candidates: [],
    });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 2, count: 1 }}
        query={{
          search: "charizard",
          status: "draft",
          language: "en",
          source: "tcgplayer",
          blueprintId: "bpr_card",
          tag: "imported",
          blueprintState: "assigned",
          hasImages: "true",
          hasSourceReferences: "true",
          missingRequiredFields: "false",
          setId: "",
          typeKey: "",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview matching drafts" }));

    await waitFor(() => {
      expect(mockPreviewBulkPublishCatalogItems).toHaveBeenCalledWith({
        mode: "filter",
        query: {
          search: "charizard",
          status: "draft",
          language: "en",
          source: "tcgplayer",
          blueprintId: "bpr_card",
          tag: "imported",
          blueprintState: "assigned",
          hasImages: "true",
          hasSourceReferences: "true",
          missingRequiredFields: "false",
        },
      });
    });
    expect(await screen.findByText("Bulk Publish Preview")).toBeTruthy();
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
        query={{ search: "", status: "draft", language: "", source: "tcgplayer", blueprintId: "", tag: "", setId: "", typeKey: "", page: 0, pageSize: 50 }}
      />,
    );

    expect(screen.getAllByText("tcgplayer").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Preview matching drafts" })).toBeTruthy();
    expect(screen.getAllByText("1 matching Catalog Items")).toHaveLength(1);

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    expect(selectRow).toBeTruthy();
    fireEvent.click(selectRow!);
    expect(screen.getAllByText("1 Catalog Items selected")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Preview publish" }));

    await waitFor(() => {
      expect(mockPreviewBulkPublishCatalogItems).toHaveBeenCalledWith({
        mode: "ids",
        ids: ["cat_1"],
      });
    });
    expect(await screen.findByText("Bulk Publish Preview")).toBeTruthy();
  });

  it("previews selected shared bulk edits from the list", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("combobox", { name: "Operation" }));
    await user.click(await screen.findByRole("option", { name: "Assign Blueprint" }));
    const blueprintInputs = screen.getAllByLabelText("Blueprint ID or slug");
    fireEvent.change(blueprintInputs[blueprintInputs.length - 1]!, { target: { value: "bpr_card" } });
    const previewEdit = screen.getByRole("button", { name: "Preview blueprint assignment" });
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

  it("hides matching bulk actions once rows are selected", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ search: "", status: "active", language: "", source: "tcgplayer", page: 0, pageSize: 50 }}
      />,
    );

    expect(screen.getAllByText("1 matching Catalog Items")).toHaveLength(1);

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);

    expect(screen.getAllByText("1 Catalog Items selected").length).toBeGreaterThan(0);
    expect(screen.queryByText("1 matching Catalog Items")).toBeNull();
  });

  it("previews matching bulk edits from a single side-panel action surface", async () => {
    const user = userEvent.setup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockPreviewBulkCatalogItemEdit.mockResolvedValue({
      mode: "filter",
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
        query={{ search: "", status: "active", language: "", source: "tcgplayer", page: 0, pageSize: 50 }}
      />,
    );

    expect(screen.getAllByText("1 matching Catalog Items")).toHaveLength(1);
    expect(screen.queryByLabelText("Action")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("combobox", { name: "Action" }));
    await user.click(await screen.findByRole("option", { name: "Assign Blueprint" }));
    fireEvent.change(screen.getByLabelText("Blueprint ID or slug"), { target: { value: "bpr_card" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matching items" }));

    await waitFor(() => {
      expect(mockPreviewBulkCatalogItemEdit).toHaveBeenCalledWith(
        { action: "assignBlueprint", blueprintId: "bpr_card" },
        { mode: "filter", query: { search: "", status: "active", language: "", source: "tcgplayer", page: 0, pageSize: 50 } },
      );
    });
    expect(await screen.findByText("Bulk Assign Blueprint Preview")).toBeTruthy();
  });

  it("removes selected draft items from the grid", async () => {
    const user = userEvent.setup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    const revalidate = vi.fn();
    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockRemoveDraftCatalogItem.mockResolvedValue({ id: "cat_1", version: 2, status: "removed" });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ search: "", status: "draft", language: "", source: "", page: 0, pageSize: 50 }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    await user.click(screen.getByRole("combobox", { name: "Operation" }));
    await user.click(await screen.findByRole("option", { name: "Remove drafts" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove drafts from selected" }));

    const confirmButtons = await screen.findAllByRole("button", { name: "Remove drafts from selected" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(mockRemoveDraftCatalogItem).toHaveBeenCalledWith("cat_1");
      expect(revalidate).toHaveBeenCalled();
    });
  });
});
