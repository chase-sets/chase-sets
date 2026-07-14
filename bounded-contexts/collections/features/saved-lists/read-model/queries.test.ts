import { describe, expect, it, vi } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { listSavedListSummaries, loadSavedListDetail, SavedListQueryError } from "./queries";
import { savedListReadModelSchemaSql } from "./schema";

const ownerAccountId = "acc_owner" as AccountId;

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    list_id: "svl_3",
    owner_account_id: ownerAccountId,
    title: "Trade targets",
    description: null,
    visibility: "private",
    lifecycle: "active",
    cover_line_id: "sll_cover",
    cover_catalog_item_id: "cat_1",
    cover_product_id: "cat_1::condition=near_mint",
    cover_selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    line_count: 2,
    tracked_unit_count: "4",
    created_at: "2026-07-13T03:00:00.000Z",
    changed_at: "2026-07-13T04:00:00.000Z",
    archived_at: null,
    last_stream_version: 8,
    catalog_item_present: "cat_1",
    catalog_language_code: "en",
    catalog_title: "Black Lotus",
    catalog_subtitle: "Limited Edition Alpha",
    catalog_status: "active",
    catalog_options: [
      {
        dimensionId: "condition",
        dimensionName: "Condition",
        optionId: "near_mint",
        optionLabel: "Near Mint",
      },
    ],
    catalog_updated_at: "2026-07-13T02:00:00.000Z",
    snapshot_position: "900",
    total_count: "200",
    ...overrides,
  };
}

describe("Saved List read-model queries", () => {
  it("uses a fenced keyset cursor and preserves the first page total", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          summaryRow(),
          summaryRow({ list_id: "svl_2", created_at: "2026-07-13T02:00:00.000Z" }),
          summaryRow({ list_id: "svl_1", created_at: "2026-07-13T01:00:00.000Z" }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [summaryRow({ list_id: "svl_1", created_at: "2026-07-13T01:00:00.000Z", total_count: "1" })],
      });

    const first = await listSavedListSummaries(queryDb(query), {
      ownerAccountId,
      search: "lotus",
      visibilities: ["private"],
      limit: 2,
    });
    const second = await listSavedListSummaries(queryDb(query), {
      ownerAccountId,
      search: "lotus",
      visibilities: ["private"],
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.items.map((item) => item.listId)).toEqual(["svl_3", "svl_2"]);
    expect(first.total).toBe(200);
    expect(first.nextCursor).toBeTruthy();
    expect(second.total).toBe(200);
    expect(second.items.map((item) => item.listId)).toEqual(["svl_1"]);

    const firstSql = String(query.mock.calls[0]![0]);
    const secondSql = String(query.mock.calls[1]![0]);
    expect(firstSql).toContain("MAX(created_global_position)");
    expect(firstSql).toContain("summary.created_global_position <= snapshot.snapshot_position");
    expect(firstSql).toContain("ORDER BY summary.created_at DESC, summary.list_id DESC");
    expect(secondSql).toContain("(summary.created_at, summary.list_id) <");
    expect(query.mock.calls[1]![1]).toContain("900");
  });

  it("binds a cursor to its search and visibility filters", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [summaryRow(), summaryRow({ list_id: "svl_2", created_at: "2026-07-13T02:00:00.000Z" })],
    });
    const first = await listSavedListSummaries(queryDb(query), {
      ownerAccountId,
      search: "lotus",
      limit: 1,
    });

    await expect(
      listSavedListSummaries(queryDb(query), {
        ownerAccountId,
        search: "dragon",
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(SavedListQueryError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns deterministic private lines with active, retired, and missing Catalog states", async () => {
    const base = {
      ...summaryRow({ cover_line_id: "sll_1" }),
      line_id: "sll_1",
      catalog_item_id: "cat_1",
      product_id: "cat_1::condition=near_mint",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
      tracked_quantity: 2,
      private_notes: "Binder copy",
      private_tags: ["priority"],
      position: 0,
      added_at: "2026-07-13T01:00:00.000Z",
      line_changed_at: "2026-07-13T02:00:00.000Z",
    };
    const query = vi.fn().mockResolvedValue({
      rows: [
        base,
        {
          ...base,
          line_id: "sll_2",
          catalog_item_id: "cat_2",
          product_id: "cat_2::printing=foil",
          position: 1,
          catalog_item_present: "cat_2",
          catalog_status: "retired",
          catalog_title: "Retired card",
        },
        {
          ...base,
          line_id: "sll_3",
          catalog_item_id: "cat_missing",
          product_id: "cat_missing::default",
          position: 2,
          catalog_item_present: null,
          catalog_status: null,
          catalog_title: null,
          catalog_subtitle: null,
          catalog_language_code: null,
          catalog_updated_at: null,
          catalog_options: [],
        },
      ],
    });

    const detail = await loadSavedListDetail(queryDb(query), {
      ownerAccountId,
      listId: "svl_3" as never,
    });

    expect(detail?.lines.map((line) => line.position)).toEqual([0, 1, 2]);
    expect(detail?.lines.map((line) => line.catalog.availability)).toEqual(["active", "retired", "missing"]);
    expect(detail?.lines[0]).toMatchObject({
      privateNotes: "Binder copy",
      privateTags: ["priority"],
      catalog: {
        title: "Black Lotus",
        selectedOptions: [{ dimensionName: "Condition", optionLabel: "Near Mint" }],
      },
    });
    expect(detail?.cover?.lineId).toBe("sll_1");
    expect(String(query.mock.calls[0]![0])).toContain("ORDER BY line.position ASC");
  });

  it("declares indexes for many Lists, 10k-line order, Product joins, and full-text search", () => {
    expect(savedListReadModelSchemaSql).toContain("collections_saved_list_summaries_owner_page_idx");
    expect(savedListReadModelSchemaSql).toContain("collections_saved_list_lines_list_order_idx");
    expect(savedListReadModelSchemaSql).toContain("collections_saved_list_lines_catalog_item_idx");
    expect(savedListReadModelSchemaSql).toContain("collections_saved_list_summaries_search_idx");
    expect(savedListReadModelSchemaSql).toContain("collections_catalog_items_search_idx");
    expect(savedListReadModelSchemaSql).toContain("collections_catalog_dimension_options_search_idx");
  });
});

function queryDb(query: ReturnType<typeof vi.fn>) {
  return { query } as never;
}
