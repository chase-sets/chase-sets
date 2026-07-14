import { describe, expect, it, vi } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildSavedListCatalogProjectionHandlers } from "../integrations/catalog/projection";
import { buildSavedListProjectionHandlers } from "./projection";

function event(type: string, data: Record<string, unknown>, streamVersion: number): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "collections.saved-list-svl_1",
    streamVersion,
    globalPosition: String(100 + streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_owner" },
    timing: { occurredAt: "2026-07-13T00:00:00.000Z", recordedAt: "2026-07-13T00:00:00.000Z" },
  });
}

describe("Saved List projection", () => {
  it("consumes the foundation event payloads into summary and line tables", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSavedListProjectionHandlers({ query } as never);

    await handlers["collections.saved-list.created"]!(
      event(
        "collections.saved-list.created",
        {
          eventSchemaVersion: 1,
          commandId: "slc_1",
          listId: "svl_1",
          ownerAccountId: "acc_owner",
          title: "Trade targets",
          description: null,
          visibility: "private",
          createdAt: "2026-07-13T00:00:00.000Z",
        },
        1,
      ),
    );
    await handlers["collections.saved-list.line-added"]!(
      event(
        "collections.saved-list.line-added",
        {
          eventSchemaVersion: 1,
          commandId: "slc_2",
          listId: "svl_1",
          lineId: "sll_1",
          product: {
            catalogItemId: "cat_1",
            productId: "cat_1::condition=near_mint",
            selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
          },
          trackedQuantity: 3,
          privateNotes: "Prefer first printing",
          privateTags: ["priority"],
          addedAt: "2026-07-13T00:01:00.000Z",
        },
        2,
      ),
    );

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]![0]).toContain("INSERT INTO collections_saved_list_summaries");
    expect(query.mock.calls[1]![0]).toContain("INSERT INTO collections_saved_list_lines");
    expect(query.mock.calls[1]![1]).toEqual([
      "sll_1",
      "svl_1",
      "cat_1",
      "cat_1::condition=near_mint",
      '[{"dimensionId":"condition","optionId":"near_mint"}]',
      3,
      "Prefer first printing",
      '["priority"]',
      "2026-07-13T00:01:00.000Z",
      2,
    ]);
    expect(query.mock.calls[2]![0]).toContain("tracked_unit_count = membership.tracked_unit_count");
  });

  it("reorders all affected positions deterministically and advances the summary version", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSavedListProjectionHandlers({ query } as never);

    await handlers["collections.saved-list.line-reordered"]!(
      event(
        "collections.saved-list.line-reordered",
        {
          eventSchemaVersion: 1,
          commandId: "slc_3",
          listId: "svl_1",
          lineId: "sll_3",
          afterLineId: "sll_1",
          changedAt: "2026-07-13T00:02:00.000Z",
        },
        4,
      ),
    );

    expect(query.mock.calls[0]![0]).toContain("ROW_NUMBER() OVER (ORDER BY position, line_id)");
    expect(query.mock.calls[0]![0]).toContain("new_positions");
    expect(query.mock.calls[0]![1]).toEqual(["svl_1", "sll_3", "sll_1", 4]);
    expect(query.mock.calls[1]![1]).toEqual(["svl_1", null, "2026-07-13T00:02:00.000Z", "104", 4]);
  });

  it("subscribes to resolved Catalog display identity and lifecycle degradation", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildSavedListCatalogProjectionHandlers({ query } as never);

    expect(handlers).toHaveProperty("catalog.catalog-item.display-identity-resolved");
    expect(handlers).toHaveProperty("catalog.catalog-item.retired");
    expect(handlers).toHaveProperty("catalog.catalog-item.archived");

    await handlers["catalog.catalog-item.display-identity-resolved"]!(
      buildTransportEvent(
        "catalog.catalog-item.display-identity-resolved",
        {
          catalogItemId: "cat_1",
          languageCode: "en",
          title: "Black Lotus",
          subtitle: "Limited Edition Alpha",
        },
        {
          id: "evt_catalog_1",
          streamId: "catalog.item-cat_1",
          streamVersion: 2,
          globalPosition: "200",
          tenantId: "tnt_1",
          audit: { performedByUserId: "usr_1", forAccountId: "acc_owner" },
          timing: { occurredAt: "2026-07-13T00:00:00.000Z", recordedAt: "2026-07-13T00:00:00.000Z" },
        },
      ),
    );

    expect(query.mock.calls[0]![0]).toContain("UPDATE collections_catalog_items");
    expect(query.mock.calls[0]![1]).toEqual([
      "cat_1",
      "en",
      "Black Lotus",
      "Limited Edition Alpha",
      "2026-07-13T00:00:00.000Z",
    ]);
  });
});
