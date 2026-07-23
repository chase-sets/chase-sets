import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { defineBcProjectionGroupReset } from "@chase-sets/bounded-context-module";
import { describe, expect, it, vi } from "vitest";
import contextManifest from "../context.json";
import { module as discoveryModule } from "../index";
import { buildDiscoveryCategoryProjectionHandlers } from "../features/categories/read-model/projection";
import { buildDiscoverySearchItemProjectionHandlers } from "../features/search/read-model/projection";
import type { DiscoveryServices } from "../support/runtime-support/services";

const db: PgQueryable = {
  query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }),
};

describe("Discovery Search Index contracts", () => {
  it("rejects projection resets that can discard the supplied transaction database", () => {
    if (false) {
      // @ts-expect-error A projection reset must declare a required database parameter.
      defineBcProjectionGroupReset(async () => undefined);
    }
    expect(true).toBe(true);
  });

  it("subscribes every category and Search Index event to an explicit handler", () => {
    const categorySubscription = contextManifest.eventSubscriptions.find(
      (subscription) => subscription.projectionName === "discovery-category-projection",
    );
    const searchSubscription = contextManifest.eventSubscriptions.find(
      (subscription) => subscription.projectionName === "discovery-search-item-projection",
    );

    expect(categorySubscription?.subscriptionVersion).toBe(2);
    expect(searchSubscription?.subscriptionVersion).toBe(9);
    expect([...Object.keys(buildDiscoveryCategoryProjectionHandlers(db))].sort()).toEqual(
      [...(categorySubscription?.eventTypes ?? [])].sort(),
    );
    expect([...Object.keys(buildDiscoverySearchItemProjectionHandlers(db))].sort()).toEqual(
      [...(searchSubscription?.eventTypes ?? [])].sort(),
    );
    expect(searchSubscription?.eventTypes).not.toContain("catalog.blueprint.product-resolution-rules-set");
    expect(searchSubscription?.eventTypes).not.toContain("catalog.blueprint.published");
  });

  it("binds the existing projection operation to the Discovery-owned atomic rebuild", async () => {
    const rebuildSearchIndex = vi.fn(async (_database: PgQueryable) => undefined);
    const groups =
      discoveryModule.buildProjectionGroups?.({
        items: { search: { rebuildSearchIndex } },
      } as unknown as DiscoveryServices) ?? [];
    const searchGroup = groups.find((group) => group.projectionName === "discovery-search-item-projection");

    expect(searchGroup).toMatchObject({
      projectionRevision: 2,
      resetStrategy: "generation-cutover",
    });
    await searchGroup?.reset?.execute(db);
    expect(rebuildSearchIndex).toHaveBeenCalledOnce();
    expect(rebuildSearchIndex).toHaveBeenCalledWith(db, undefined);
  });
});
