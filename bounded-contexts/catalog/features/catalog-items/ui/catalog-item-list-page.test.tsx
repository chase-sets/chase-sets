// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogRealtimeReloadActionBar } from "./realtime-reload-action-bar";
import { CatalogItemListPage } from "./catalog-item-list-page";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import type { CatalogItemListItem } from "./contracts";

const {
  mockConfirmBulkCatalogItemEdit,
  mockConfirmBulkCatalogItemLifecycle,
  mockConfirmBulkPublishCatalogItems,
  mockCreateCatalogItem,
  mockPreviewBulkCatalogItemEdit,
  mockPreviewBulkCatalogItemLifecycle,
  mockPreviewBulkPublishCatalogItems,
  mockRemoveDraftCatalogItem,
  mockUseNavigation,
  mockUseRevalidator,
  mockUseSearchParams,
} = vi.hoisted(() => ({
  mockConfirmBulkCatalogItemEdit: vi.fn(),
  mockConfirmBulkCatalogItemLifecycle: vi.fn(),
  mockConfirmBulkPublishCatalogItems: vi.fn(),
  mockCreateCatalogItem: vi.fn(),
  mockPreviewBulkCatalogItemEdit: vi.fn(),
  mockPreviewBulkCatalogItemLifecycle: vi.fn(),
  mockPreviewBulkPublishCatalogItems: vi.fn(),
  mockRemoveDraftCatalogItem: vi.fn(),
  mockUseNavigation: vi.fn(),
  mockUseRevalidator: vi.fn(),
  mockUseSearchParams: vi.fn(),
}));

vi.mock("react-router", () => ({
  useLocation: () => ({ pathname: "/catalog/catalog-items", search: "", hash: "", state: null, key: "test" }),
  useNavigation: mockUseNavigation,
  useRevalidator: mockUseRevalidator,
  useSearchParams: mockUseSearchParams,
}));

vi.mock("./use-catalog-items", () => ({
  confirmBulkCatalogItemEdit: mockConfirmBulkCatalogItemEdit,
  confirmBulkCatalogItemLifecycle: mockConfirmBulkCatalogItemLifecycle,
  confirmBulkPublishCatalogItems: mockConfirmBulkPublishCatalogItems,
  createCatalogItem: mockCreateCatalogItem,
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
  display_template_key: null,
  display_identity_hash: null,
  display_identity_resolved_at: null,
  blueprint: { blueprintId: "bpr_card", name: "Pokemon Card" },
  status: "draft",
  source_providers: ["tcgplayer"],
  tags: [],
  updated_at: "2026-05-16T00:00:00.000Z",
};

const defaultQuery: CatalogListQuery = {
  search: "",
  status: "",
  language: "",
  source: "",
  setId: "",
  typeKey: "",
  valueKind: "",
  valueType: "",
  filterable: "",
  searchable: "",
  sortable: "",
  hasFieldRules: "",
  hasDimensionRules: "",
  hasComponents: "",
  parentCategoryId: "",
  hierarchy: "",
  blueprintId: "",
  blueprintState: "",
  tag: "",
  hasImages: "",
  hasSourceReferences: "",
  missingRequiredFields: "",
  attributeKey: "",
  attributeValue: "",
  relationshipType: "",
  relatedReferenceId: "",
  targetKind: "",
  page: 0,
  pageSize: 50,
};

describe("CatalogItemListPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("previews bulk publish for matching Catalog Items from the shared action panel", async () => {
    const user = userEvent.setup();
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
          ...defaultQuery,
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

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("button", { name: "Preview publish" }));

    await waitFor(() => {
      expect(mockPreviewBulkPublishCatalogItems).toHaveBeenCalledWith({
        mode: "filter",
        query: {
          ...defaultQuery,
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
        },
      });
    });
    expect(await screen.findByText("Bulk Publish Preview")).toBeTruthy();
  });

  it("creates Catalog Items without manual title or subtitle controls", async () => {
    const user = userEvent.setup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    const revalidate = vi.fn();
    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockCreateCatalogItem.mockResolvedValue({ id: "cat_1", version: 1, status: "draft" });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "",
          language: "",
          source: "",
          setId: "",
          typeKey: "",
          targetKind: "",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New Catalog Item" }));

    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByLabelText("Subtitle")).toBeNull();

    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Draft from fields" } });
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(mockCreateCatalogItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: { defaultLocale: "en", values: { en: expect.stringMatching(/^cat_/) } },
          subtitle: null,
          description: { defaultLocale: "en", values: { en: "Draft from fields" } },
        }),
      );
      expect(revalidate).toHaveBeenCalled();
    });
  });

  it("selects rows and previews bulk publish from the list", async () => {
    const user = userEvent.setup();
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
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          blueprintId: "",
          tag: "",
          setId: "",
          typeKey: "",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    expect(screen.getAllByText("tcgplayer").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
    expect(screen.getAllByText("1 matching Catalog Items")).toHaveLength(1);

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    expect(selectRow).toBeTruthy();
    fireEvent.click(selectRow!);
    expect(screen.getAllByText("1 Catalog Items selected")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview publish" }));

    await waitFor(() => {
      expect(mockPreviewBulkPublishCatalogItems).toHaveBeenCalledWith({
        mode: "ids",
        ids: ["cat_1"],
      });
    });
    expect(await screen.findByText("Bulk Publish Preview")).toBeTruthy();
  });

  it("renders live progress while confirming bulk publish jobs", async () => {
    const user = userEvent.setup();
    const revalidate = vi.fn();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockPreviewBulkPublishCatalogItems.mockResolvedValue({
      mode: "ids",
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [],
    });
    mockConfirmBulkPublishCatalogItems.mockImplementation(async (_itemIds, options) => {
      options.onProgress({
        phase: "running",
        completed: 1,
        total: 3,
        currentName: "Charizard",
        status: "activating",
      });
      return {
        mode: "ids",
        item_ids: ["cat_1"],
        total: 1,
        published_count: 1,
        skipped_count: 0,
        failed_count: 0,
        candidates: [],
      };
    });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ ...defaultQuery, search: "", status: "draft", language: "", source: "", page: 0, pageSize: 50 }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview publish" }));
    expect(await screen.findByText("Bulk Publish Preview")).toBeTruthy();
    fireEvent.click(await screen.findByText("Publish Ready Items"));

    await waitFor(() => {
      expect(mockConfirmBulkPublishCatalogItems).toHaveBeenCalledWith(
        ["cat_1"],
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
    });
    expect(await screen.findByText("activating")).toBeTruthy();
    expect(screen.getByText("1 of 3 processed.")).toBeTruthy();
    expect(screen.getByText("Current: Charizard")).toBeTruthy();
    expect(revalidate).toHaveBeenCalled();
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
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("combobox", { name: "Action" }));
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

  it("uses the same bulk action options for matching and selected scopes", async () => {
    const user = userEvent.setup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("combobox", { name: "Action" }));
    const matchingOptions = (await screen.findAllByRole("option")).map((option) => option.textContent);

    cleanup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("combobox", { name: "Action" }));
    const selectedOptions = (await screen.findAllByRole("option")).map((option) => option.textContent);

    expect(selectedOptions).toEqual(matchingOptions);
    expect(selectedOptions).toEqual([
      "Publish",
      "Archive",
      "Assign Blueprint",
      "Assign Category",
      "Remove Category",
      "Set Tags",
      "Merge Tags",
      "Clear Tags",
    ]);
  });

  it("hides matching bulk actions once rows are selected", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "active",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    expect(screen.getAllByText("1 matching Catalog Items")).toHaveLength(1);

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);

    expect(screen.getAllByText("1 Catalog Items selected").length).toBeGreaterThan(0);
    expect(screen.queryByText("1 matching Catalog Items")).toBeNull();
  });

  it("prioritizes the realtime reload action bar over matching bulk actions", () => {
    const reload = vi.fn();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
        realtimeReloadActionBar={
          <CatalogRealtimeReloadActionBar
            pendingChangeCount={3}
            syncRequired={false}
            reload={reload}
            entityName="Catalog Items"
          />
        }
      />,
    );

    expect(screen.getByText("3 Catalog Items changed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText("1 matching Catalog Items")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("shows the realtime sync-required reload action before matching bulk actions", () => {
    const reload = vi.fn();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
        realtimeReloadActionBar={
          <CatalogRealtimeReloadActionBar
            pendingChangeCount={0}
            syncRequired={true}
            reload={reload}
            entityName="Catalog Items"
          />
        }
      />,
    );

    expect(screen.getByText("Catalog Items changed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText("1 matching Catalog Items")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("renders the connection status indicator in the page header", () => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{
          ...defaultQuery,
          search: "",
          status: "draft",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
        connectionStatus={<span>Live indicator probe</span>}
      />,
    );

    expect(screen.getByText("Live indicator probe")).toBeTruthy();
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
        query={{
          ...defaultQuery,
          search: "",
          status: "active",
          language: "",
          source: "tcgplayer",
          page: 0,
          pageSize: 50,
        }}
      />,
    );

    expect(screen.getAllByText("1 matching Catalog Items")).toHaveLength(1);
    expect(screen.queryByLabelText("Action")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(await screen.findByRole("combobox", { name: "Action" }));
    await user.click(await screen.findByRole("option", { name: "Assign Blueprint" }));
    fireEvent.change(screen.getByLabelText("Blueprint ID or slug"), { target: { value: "bpr_card" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview blueprint assignment" }));

    await waitFor(() => {
      expect(mockPreviewBulkCatalogItemEdit).toHaveBeenCalledWith(
        { action: "assignBlueprint", blueprintId: "bpr_card" },
        {
          mode: "filter",
          query: {
            ...defaultQuery,
            search: "",
            status: "active",
            language: "",
            source: "tcgplayer",
            page: 0,
            pageSize: 50,
          },
        },
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
        query={{ ...defaultQuery, search: "", status: "draft", language: "", source: "", page: 0, pageSize: 50 }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    fireEvent.click(screen.getByRole("button", { name: "Remove drafts from selected" }));

    const confirmButtons = await screen.findAllByRole("button", { name: "Remove drafts from selected" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]!);

    await waitFor(() => {
      expect(mockRemoveDraftCatalogItem).toHaveBeenCalledWith("cat_1");
      expect(revalidate).toHaveBeenCalled();
    });
  });
});
