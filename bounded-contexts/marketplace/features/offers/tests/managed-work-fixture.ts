import { vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import { createManagedOfferWork } from "../integrations/managed-work";
import type { MarketplaceOfferServices } from "../api/runtime";

export function managedWorkFixture(
  eventStore: EventStore,
  products: readonly { offer_id: string; catalog_catalog_item_id: string; product_id: string }[],
  applyManagedOfferPage: MarketplaceOfferServices["applyManagedOfferPage"] = vi.fn(async () => {}),
) {
  let clock = Date.parse("2026-09-27T00:00:00Z");
  let cursor = { after_offer_id: "", generation: "0", pending_work_ids: [] as string[] };
  let hideProjection = false;
  async function workRows() {
    const rows = new Map<
      string,
      {
        work_id: string;
        last_stream_version: number;
        catalog_item_id: string;
        product_id: string;
        status: string;
        available_at: string;
        kind: string;
      }
    >();
    let afterGlobalPosition: GlobalPosition | undefined;
    for (;;) {
      const events = await eventStore.readAll({ afterGlobalPosition });
      if (events.length === 0) break;
      afterGlobalPosition = events.at(-1)!.globalPosition;
      for (const event of events) {
        if (!event.eventType.startsWith("marketplace.offer.work-")) continue;
        const p = event.payload;
        rows.set(String(p.workId), {
          work_id: String(p.workId),
          last_stream_version: event.streamVersion,
          catalog_item_id: String(p.catalogItemId),
          product_id: String(p.productId),
          status: String(p.status),
          available_at: String(p.availableAt),
          kind: String(p.kind ?? "reaction"),
        });
      }
    }
    return [...rows.values()];
  }
  const db = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.startsWith("SELECT after_offer_id")) return { rows: [{ ...cursor }] };
      if (sql.startsWith("INSERT INTO marketplace_managed_offer_recovery")) return { rows: [] };
      if (sql.startsWith("UPDATE marketplace_managed_offer_recovery")) {
        if (cursor.after_offer_id === values[1] && cursor.generation === values[2])
          cursor = {
            after_offer_id: String(values[0]),
            generation: String(Number(cursor.generation) + Number(values[3])),
            pending_work_ids: values[4] as string[],
          };
        return { rows: [] };
      }
      if (sql.includes("FROM marketplace_managed_offer_work")) {
        const rows = hideProjection ? [] : (await workRows()).filter((row) => row.status !== "completed");
        if (sql.includes("catalog_item_id = $1"))
          return {
            rows: rows.filter((row) => row.catalog_item_id === values[0] && row.product_id === values[1]).slice(0, 1),
          };
        if (!sql.includes("ORDER BY kind, available_at, work_id")) throw new Error("Reaction priority is required.");
        return {
          rows: rows
            .filter((row) => Date.parse(row.available_at) <= Date.parse(String(values[0])))
            .sort(
              (a, b) =>
                a.kind.localeCompare(b.kind) ||
                a.available_at.localeCompare(b.available_at) ||
                a.work_id.localeCompare(b.work_id),
            )
            .slice(0, 1),
        };
      }
      if (sql.includes("SELECT offer.offer_id")) {
        const page = sql.includes("offer.catalog_catalog_item_id = $1")
          ? products.filter(
              (row) =>
                row.catalog_catalog_item_id === values[0] &&
                row.product_id === values[1] &&
                row.offer_id > String(values[2]),
            )
          : products.filter((row) => row.offer_id > String(values[0]));
        return { rows: page.slice(0, 100) };
      }
      throw new Error(`Unexpected work query: ${sql}`);
    }),
  };
  return {
    db,
    workRows,
    cursor: () => cursor,
    advance: (ms: number) => {
      clock += ms;
    },
    hideProjection: (hide: boolean) => {
      hideProjection = hide;
    },
    worker: () =>
      createManagedOfferWork({
        eventStore,
        db: db as never,
        offers: { applyManagedOfferPage },
        now: () => new Date(clock),
      }),
  };
}
