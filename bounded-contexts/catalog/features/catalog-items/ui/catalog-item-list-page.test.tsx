// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { CatalogRealtimeReloadActionBar } from "./realtime-reload-action-bar";
import { CatalogItemListPage } from "./catalog-item-list-page";
import type { CatalogListQuery } from "../../../support/shell-support/list-query-state";
import type { CatalogItemListItem } from "./contracts";
import type { BulkRemoveDraftResult } from "./contracts";
import type { BulkLifecycleProgressOptions } from "../../../support/shell-support/ui/bulk-lifecycle-actions";
import { ToastProvider } from "../../../support/shell-support/ui/toasts";

const {
  mockConfirmBulkCatalogItemEdit,
  mockConfirmBulkCatalogItemLifecycle,
  mockConfirmBulkPublishCatalogItems,
  mockCreateCatalogItem,
  mockPreviewBulkCatalogItemEdit,
  mockPreviewBulkCatalogItemLifecycle,
  mockPreviewBulkPublishCatalogItems,
  mockPreviewBulkRemoveDrafts,
  mockConfirmBulkRemoveDrafts,
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
  mockPreviewBulkRemoveDrafts: vi.fn(),
  mockConfirmBulkRemoveDrafts: vi.fn(),
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
  previewBulkRemoveDrafts: mockPreviewBulkRemoveDrafts,
  confirmBulkRemoveDrafts: mockConfirmBulkRemoveDrafts,
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

function removalPreview() {
  return {
    mode: "ids",
    item_ids: ["cat_1", "cat_2", "cat_3"],
    total: 3,
    ready_count: 2,
    blocked_count: 1,
    candidates: [
      { catalog_item_id: "cat_1", title: "Draft one", status: "draft", outcome: "ready", reason: null },
      {
        catalog_item_id: "cat_2",
        title: "Active row",
        status: "active",
        outcome: "blocked",
        reason: "Only draft items can be removed.",
      },
      { catalog_item_id: "cat_3", title: "Draft two", status: "draft", outcome: "ready", reason: null },
    ],
  };
}

function renderRemovalSelection() {
  const revalidate = vi.fn();
  mockUseNavigation.mockReturnValue({ state: "idle" });
  mockUseRevalidator.mockReturnValue({ revalidate });
  mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
  const items = [
    catalogItem,
    { ...catalogItem, catalog_item_id: "cat_2", status: "active" },
    { ...catalogItem, catalog_item_id: "cat_3" },
  ];
  render(
    <ToastProvider>
      <CatalogItemListPage data={{ items, total: 3, count: 3 }} query={defaultQuery} />
    </ToastProvider>,
  );
  for (const item of items) fireEvent.click(screen.getAllByLabelText(`Select row ${item.catalog_item_id}`)[0]!);
  return revalidate;
}

function removalAction() {
  return screen.getByRole("button", {
    name: t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts.from.selected"),
  });
}

function removalConfirm(dialog: HTMLElement) {
  return within(dialog).getByRole("button", {
    name: t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts"),
  });
}

function removalPreviewTitle() {
  return t("catalog.support.shellSupport.ui.bulkLifecycleActions.preview.title", {
    action: t("catalog.features.catalogItems.ui.catalogItemListPage.operation.remove.drafts"),
  });
}

describe("CatalogItemListPage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockPreviewBulkRemoveDrafts.mockReset();
    mockConfirmBulkRemoveDrafts.mockReset();
    mockRemoveDraftCatalogItem.mockReset();
  });

  it.each([0, 1, 50, 51])("renders the independent server total %i for populated and empty pages", (total) => {
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    const items = Array.from({ length: Math.min(total, 50) }, (_, index) => ({
      ...catalogItem,
      catalog_item_id: `synthetic-${index}`,
    }));
    const { container, rerender } = render(
      <CatalogItemListPage data={{ items, count: items.length, total }} query={defaultQuery} />,
    );
    const assertTotal = () => {
      const anchors = container.querySelectorAll("[data-catalog-items-total]");
      expect(anchors.length).toBe(1);
      expect(anchors[0]?.getAttribute("data-catalog-items-total")).toBe(String(total));
      expect(anchors[0]?.textContent).toContain(String(total));
      expect(anchors[0]?.closest('[hidden], [aria-hidden="true"]')).toBeNull();
    };
    assertTotal();
    if (items.length) {
      fireEvent.click(screen.getAllByRole("checkbox")[0]!);
      assertTotal();
    }
    rerender(
      <CatalogItemListPage
        data={{ items: [], count: 0, total }}
        query={defaultQuery}
        realtimeReloadActionBar={<div>Updates available</div>}
      />,
    );
    expect(screen.queryByText("Updates available")).toBeNull();
    assertTotal();
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
          reason_code: null,
          retryable: false,
          display_identity_readiness: "current-resolved",
          missing_tokens: [],
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
    expect(
      screen
        .queryAllByText("1 matching Catalog Items")
        .filter((element) => !element.hasAttribute("data-catalog-items-total")),
    ).toHaveLength(1);

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    expect(selectRow).toBeTruthy();
    fireEvent.click(selectRow!);
    expect(screen.getAllByText("1 Catalog Items selected").length).toBeGreaterThan(0);
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
    fireEvent.click(await screen.findByText("Publish or recheck items"));

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

  it("submits all-outdated previews and keeps the exact failed IDs retryable", async () => {
    const user = userEvent.setup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate: vi.fn() });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    const outdatedCandidate = {
      catalog_item_id: "cat_1",
      title: "Charizard",
      subtitle: "Base Set",
      status: "draft",
      blueprint_id: "bpr_card",
      blueprint_name: "Pokemon Card",
      source_providers: ["tcgplayer"],
      outcome: "blocked" as const,
      reason: "Display identity is outdated. Recheck and retry publication.",
      reason_code: "display-identity-outdated" as const,
      retryable: true,
      display_identity_readiness: "outdated" as const,
      missing_tokens: [],
      required_field_ids: [],
    };
    mockPreviewBulkPublishCatalogItems.mockResolvedValue({
      mode: "ids",
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 0,
      blocked_count: 1,
      candidates: [outdatedCandidate],
    });
    mockConfirmBulkPublishCatalogItems.mockResolvedValue({
      item_ids: ["cat_1"],
      total: 1,
      published_count: 0,
      skipped_count: 0,
      failed_count: 1,
      candidates: [{ ...outdatedCandidate, outcome: "failed" as const }],
    });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ ...defaultQuery, status: "draft", page: 0, pageSize: 50 }}
      />,
    );
    fireEvent.click(screen.getAllByLabelText("Select row cat_1")[0]!);
    await user.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Preview publish" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish or recheck items" }));

    await waitFor(() => expect(mockConfirmBulkPublishCatalogItems).toHaveBeenCalledWith(["cat_1"], expect.anything()));
    expect(await screen.findByRole("button", { name: "Retry items needing attention" })).toBeTruthy();
    expect(screen.getAllByText("1 Catalog Items selected").length).toBeGreaterThan(0);
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

    expect(
      screen
        .queryAllByText("1 matching Catalog Items")
        .filter((element) => !element.hasAttribute("data-catalog-items-total")),
    ).toHaveLength(1);

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);

    expect(screen.getAllByText("1 Catalog Items selected").length).toBeGreaterThan(0);
    expect(
      screen
        .queryAllByText("1 matching Catalog Items")
        .filter((element) => !element.hasAttribute("data-catalog-items-total")),
    ).toHaveLength(0);
    expect(document.querySelector("[data-catalog-items-total]")?.textContent).toBe("1 matching Catalog Items");
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
    expect(
      screen
        .queryAllByText("1 matching Catalog Items")
        .filter((element) => !element.hasAttribute("data-catalog-items-total")),
    ).toHaveLength(0);
    expect(document.querySelector("[data-catalog-items-total]")?.textContent).toBe("1 matching Catalog Items");

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
    expect(
      screen
        .queryAllByText("1 matching Catalog Items")
        .filter((element) => !element.hasAttribute("data-catalog-items-total")),
    ).toHaveLength(0);
    expect(document.querySelector("[data-catalog-items-total]")?.textContent).toBe("1 matching Catalog Items");

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

    expect(
      screen
        .queryAllByText("1 matching Catalog Items")
        .filter((element) => !element.hasAttribute("data-catalog-items-total")),
    ).toHaveLength(1);
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

  it.each([1, 0])("P1: previews every selected id including active and missing rows, with %i ready", async (ready) => {
    const candidates = [
      {
        catalog_item_id: "cat_1",
        title: "Ready row",
        status: "draft",
        outcome: ready ? "ready" : "blocked",
        reason: ready ? null : "Draft no longer available.",
      },
      {
        catalog_item_id: "cat_2",
        title: "Active row",
        status: "active",
        outcome: "blocked",
        reason: "Only draft items can be removed.",
      },
      {
        catalog_item_id: "cat_3",
        title: "Missing row",
        status: "missing",
        outcome: "blocked",
        reason: "Catalog Item was not found.",
      },
    ];
    mockPreviewBulkRemoveDrafts.mockResolvedValueOnce({
      mode: "ids",
      item_ids: ["cat_1", "cat_2", "cat_3"],
      total: 3,
      ready_count: ready,
      blocked_count: 3 - ready,
      candidates,
    });
    renderRemovalSelection();
    const action = removalAction();
    expect((action as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(action);
    const dialog = await screen.findByRole("dialog");
    expect(mockPreviewBulkRemoveDrafts).toHaveBeenCalledWith({ mode: "ids", ids: ["cat_1", "cat_2", "cat_3"] });
    for (const candidate of candidates) {
      const row = within(dialog).getByRole("cell", { name: candidate.title }).closest("tr")!;
      expect(within(row).getByText(candidate.outcome)).toBeTruthy();
      if (candidate.reason) expect(within(row).getByText(candidate.reason)).toBeTruthy();
    }
    const confirm = removalConfirm(dialog) as HTMLButtonElement;
    expect(confirm.disabled).toBe(ready === 0);
    if (!ready) fireEvent.click(confirm);
    expect(mockConfirmBulkRemoveDrafts).not.toHaveBeenCalled();
    expect(mockRemoveDraftCatalogItem).not.toHaveBeenCalled();
  });

  it("P3: renders mixed completion counts, outcomes and reasons in the open dialog and refreshes", async () => {
    mockPreviewBulkRemoveDrafts.mockResolvedValueOnce(removalPreview());
    mockConfirmBulkRemoveDrafts.mockResolvedValueOnce({
      item_ids: ["cat_1", "cat_2", "cat_3"],
      total: 3,
      succeeded_count: 1,
      skipped_count: 1,
      failed_count: 1,
      candidates: [
        { catalog_item_id: "cat_1", title: "Removed row", status: "removed", outcome: "succeeded", reason: null },
        {
          catalog_item_id: "cat_2",
          title: "Skipped row",
          status: "active",
          outcome: "skipped",
          reason: "Only draft items can be removed.",
        },
        {
          catalog_item_id: "cat_3",
          title: "Failed row",
          status: "draft",
          outcome: "failed",
          reason: "Catalog Item removal failed.",
        },
      ],
    });
    const revalidate = renderRemovalSelection();
    fireEvent.click(removalAction());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("cell", { name: "Draft one" })).toBeTruthy();
    fireEvent.click(removalConfirm(dialog));
    await waitFor(() => expect(within(dialog).getByRole("cell", { name: "Removed row" })).toBeTruthy());
    expect(
      within(dialog).getByText(
        t("catalog.support.shellSupport.ui.bulkLifecycleActions.result.description", {
          succeeded: 1,
          skipped: 1,
          failed: 1,
        }),
      ),
    ).toBeTruthy();
    for (const [title, outcome, reason] of [
      ["Removed row", "succeeded", null],
      ["Skipped row", "skipped", "Only draft items can be removed."],
      ["Failed row", "failed", "Catalog Item removal failed."],
    ]) {
      const row = within(dialog).getByRole("cell", { name: title! }).closest("tr")!;
      expect(within(row).getByText(outcome!)).toBeTruthy();
      if (reason) expect(within(row).getByText(reason)).toBeTruthy();
    }
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(mockRemoveDraftCatalogItem).not.toHaveBeenCalled();
  });

  it("P4: shows preview failure, then recovers a populated open preview without confirming", async () => {
    mockPreviewBulkRemoveDrafts
      .mockRejectedValueOnce(new Error("Synthetic preview unavailable"))
      .mockResolvedValueOnce(removalPreview());
    renderRemovalSelection();
    fireEvent.click(removalAction());
    expect(await screen.findByText("Synthetic preview unavailable")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: removalPreviewTitle() })).toBeNull();
    expect(mockConfirmBulkRemoveDrafts).not.toHaveBeenCalled();
    fireEvent.click(removalAction());
    const dialog = await screen.findByRole("dialog", { name: removalPreviewTitle() });
    expect(within(dialog).getByRole("cell", { name: "Draft one" })).toBeTruthy();
    expect(screen.getByText("Synthetic preview unavailable")).toBeTruthy();
    expect(mockConfirmBulkRemoveDrafts).not.toHaveBeenCalled();
    expect(mockRemoveDraftCatalogItem).not.toHaveBeenCalled();
  });

  it("P5: shows enqueue failure while retaining populated preview and never refreshes", async () => {
    mockPreviewBulkRemoveDrafts.mockResolvedValueOnce(removalPreview());
    mockConfirmBulkRemoveDrafts.mockRejectedValueOnce(new Error("Synthetic enqueue unavailable"));
    const revalidate = renderRemovalSelection();
    fireEvent.click(removalAction());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(removalConfirm(dialog));
    expect(await screen.findByText("Synthetic enqueue unavailable")).toBeTruthy();
    expect(within(dialog).getByRole("cell", { name: "Draft one" })).toBeTruthy();
    expect(within(dialog).getByRole("cell", { name: "Draft two" })).toBeTruthy();
    expect((removalConfirm(dialog) as HTMLButtonElement).disabled).toBe(false);
    expect(revalidate).not.toHaveBeenCalled();
    expect(mockRemoveDraftCatalogItem).not.toHaveBeenCalled();
  });

  it("P2: shows removal progress in the populated dialog and confirms once while pending", async () => {
    const revalidate = vi.fn();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    const candidates = [
      { catalog_item_id: "cat_1", title: "Draft one", status: "draft", outcome: "ready" as const, reason: null },
      { catalog_item_id: "cat_2", title: "Draft two", status: "draft", outcome: "ready" as const, reason: null },
    ];
    mockPreviewBulkRemoveDrafts.mockResolvedValueOnce({
      mode: "ids",
      item_ids: ["cat_1", "cat_2"],
      total: 2,
      ready_count: 2,
      blocked_count: 0,
      candidates,
    });
    let complete!: (result: BulkRemoveDraftResult) => void;
    const pending = new Promise<BulkRemoveDraftResult>((resolve) => {
      complete = resolve;
    });
    mockConfirmBulkRemoveDrafts.mockImplementationOnce(
      (_selection: unknown, options?: BulkLifecycleProgressOptions) => {
        options?.onProgress?.({
          phase: "running",
          completed: 1,
          total: 2,
          currentName: "Worker item",
          status: "running",
        });
        return pending;
      },
    );
    render(
      <CatalogItemListPage
        data={{ items: [catalogItem, { ...catalogItem, catalog_item_id: "cat_2" }], total: 2, count: 2 }}
        query={defaultQuery}
      />,
    );
    fireEvent.click(screen.getAllByLabelText("Select row cat_1")[0]!);
    fireEvent.click(screen.getAllByLabelText("Select row cat_2")[0]!);
    fireEvent.click(
      screen.getByRole("button", {
        name: t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts.from.selected"),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("cell", { name: "Draft one" })).toBeTruthy();
    expect(within(dialog).getByRole("cell", { name: "Draft two" })).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts"),
    });
    fireEvent.click(confirm);
    expect(
      within(dialog).getByText(
        t("catalog.support.shellSupport.ui.bulkLifecycleActions.progress", {
          completed: 1,
          total: 2,
        }),
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        t("catalog.support.shellSupport.ui.bulkLifecycleActions.progress.current", {
          name: "Worker item",
        }),
      ),
    ).toBeTruthy();
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(mockConfirmBulkRemoveDrafts).toHaveBeenCalledTimes(1);
    expect(mockConfirmBulkRemoveDrafts).toHaveBeenCalledWith(
      { mode: "ids", ids: ["cat_1", "cat_2"] },
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(mockRemoveDraftCatalogItem).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    await act(async () =>
      complete({
        item_ids: ["cat_1", "cat_2"],
        total: 2,
        succeeded_count: 2,
        skipped_count: 0,
        failed_count: 0,
        candidates: candidates.map((candidate) => ({ ...candidate, status: "removed", outcome: "succeeded" })),
      }),
    );
  });

  it("removes selected draft items from the grid", async () => {
    const user = userEvent.setup();
    mockUseNavigation.mockReturnValue({ state: "idle" });
    const revalidate = vi.fn();
    mockUseRevalidator.mockReturnValue({ revalidate });
    mockUseSearchParams.mockReturnValue([new URLSearchParams(), vi.fn()]);
    mockPreviewBulkRemoveDrafts.mockResolvedValue({
      mode: "ids",
      item_ids: ["cat_1"],
      total: 1,
      ready_count: 1,
      blocked_count: 0,
      candidates: [
        {
          catalog_item_id: "cat_1",
          title: "Charizard",
          status: "draft",
          outcome: "ready",
          reason: null,
        },
      ],
    });
    mockConfirmBulkRemoveDrafts.mockResolvedValue({
      mode: "ids",
      item_ids: ["cat_1"],
      total: 1,
      succeeded_count: 1,
      skipped_count: 0,
      failed_count: 0,
      candidates: [
        {
          catalog_item_id: "cat_1",
          title: "Charizard",
          status: "removed",
          outcome: "succeeded",
          reason: null,
        },
      ],
    });

    render(
      <CatalogItemListPage
        data={{ items: [catalogItem], total: 1, count: 1 }}
        query={{ ...defaultQuery, search: "", status: "draft", language: "", source: "", page: 0, pageSize: 50 }}
      />,
    );

    const [selectRow] = screen.getAllByLabelText("Select row cat_1");
    fireEvent.click(selectRow!);
    fireEvent.click(
      screen.getByRole("button", {
        name: t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts.from.selected"),
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: t("catalog.features.catalogItems.ui.catalogItemListPage.remove.drafts"),
      }),
    );

    await waitFor(() => {
      expect(mockPreviewBulkRemoveDrafts).toHaveBeenCalledWith({ mode: "ids", ids: ["cat_1"] });
      expect(mockConfirmBulkRemoveDrafts).toHaveBeenCalledWith(
        { mode: "ids", ids: ["cat_1"] },
        expect.objectContaining({ onProgress: expect.any(Function) }),
      );
      expect(revalidate).toHaveBeenCalled();
    });
  });
});
