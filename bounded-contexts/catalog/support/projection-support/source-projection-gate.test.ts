import { describe, expect, it, vi } from "vitest";
import { isTransientProjectionError, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildCatalogAdminBlueprintProjectionHandlers } from "../../features/blueprints/read-model/admin-projection";
import { buildCatalogAdminCategoryProjectionHandlers } from "../../features/categories/read-model/admin-projection";
import { buildCatalogAdminComponentProjectionHandlers } from "../../features/components/read-model/admin-projection";
import { afterCatalogSourceProjections, catalogSourceProjectionFor } from "./source-projection-gate";

function categoryCreated() {
  return buildTransportEvent(
    "catalog.category.created",
    { categoryId: "ctg_1" },
    {
      id: "evt_ctg_1_1",
      streamId: "catalog.category-ctg_1",
      streamVersion: 1,
      globalPosition: "6083",
      tenantId: "tnt_catalog",
      metadata: {},
      audit: { performedByUserId: "usr_catalog", forAccountId: "acc_catalog" },
      trace: {},
      timing: { occurredAt: "2026-11-20T13:49:45.000Z", recordedAt: "2026-11-20T13:49:45.000Z" },
    },
  );
}

function sourceDb(applied: boolean) {
  return { query: vi.fn(async () => ({ rows: [{ applied }] })) };
}

describe("afterCatalogSourceProjections", () => {
  it("builds the page once the source projection has applied the event", async () => {
    const db = sourceDb(true);
    const handler = vi.fn(async () => undefined);
    const gated = afterCatalogSourceProjections({ "catalog.category.created": handler }, db as never);

    await gated["catalog.category.created"]!(categoryCreated(), undefined as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("event_subscription_applications"), [
      "catalog-category-projection:catalog:v1",
      "evt_ctg_1_1",
      "catalog.category-ctg_1",
      "6083",
    ]);
  });

  it("retries the event, without building the page, while the source projection has not applied it", async () => {
    const handler = vi.fn(async () => undefined);
    const gated = afterCatalogSourceProjections({ "catalog.category.created": handler }, sourceDb(false) as never);

    const failure = await gated["catalog.category.created"]!(categoryCreated(), undefined as never).catch(
      (error: unknown) => error,
    );

    expect(isTransientProjectionError(failure)).toBe(true);
    expect(String(failure)).toContain("catalog-category-projection has not applied catalog.category.created");
    expect(handler).not.toHaveBeenCalled();
  });

  it("knows the source projection of every event the admin page projections handle", () => {
    const db = sourceDb(true) as never;
    const handlerMaps: ProjectorHandlerMap[] = [
      buildCatalogAdminCategoryProjectionHandlers(db),
      buildCatalogAdminBlueprintProjectionHandlers(db),
      buildCatalogAdminComponentProjectionHandlers(db),
    ];
    const sources = new Set(
      handlerMaps
        .flatMap((handlers) => Object.keys(handlers))
        .map((eventType) => catalogSourceProjectionFor(eventType)),
    );

    expect([...sources].sort()).toEqual([
      "catalog-blueprint-projection",
      "catalog-category-projection",
      "catalog-component-projection",
      "catalog-dimension-projection",
      "catalog-field-projection",
    ]);
    expect(() => catalogSourceProjectionFor("catalog.catalog-item.created")).toThrow(/No Catalog source projection/);
  });
});
