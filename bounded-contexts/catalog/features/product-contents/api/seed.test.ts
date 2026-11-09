import { describe, expect, it, vi } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createProductContentRuntime } from "./runtime";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedProductContentConfiguration, seedProductContentScenario } from "./seed";

function createSeedServices() {
  const productContents = {
    upsertContentType: vi.fn(async () => undefined),
    upsertInclusionPolicy: vi.fn(async () => undefined),
    readProductContentsAuthoringState: vi.fn(async () => ({ version: 0 })),
    replaceProductContents: vi.fn(async () => undefined),
  };
  const db = {
    query: vi.fn(async () => ({
      rows: [
        { catalog_item_id: catalogSeedIds.items.prismaticEvolutionsBoosterPack },
        { catalog_item_id: catalogSeedIds.items.pikachuPrismaticEvolutions },
      ],
    })),
  };

  return {
    services: {
      productContents,
      db,
    } as unknown as CatalogServices,
    productContents,
    db,
  };
}

describe("product contents seed", () => {
  it("retained contents seed uses authoritative version and refuses an intervening edit", async () => {
    const store = createInMemoryEventStore();
    const ids = [catalogSeedIds.items.prismaticEvolutionsBoosterPack, catalogSeedIds.items.pikachuPrismaticEvolutions];
    let projectedRows: readonly Record<string, unknown>[] = [];
    const query = vi.fn(async <T>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM catalog_items")) {
        const itemIds = sql.includes("ANY($1") ? ids : [params?.[0]];
        return {
          rows: itemIds.map((id) => ({
            catalog_item_id: id,
            status: "active",
            blueprint_id: "bp_plain",
            dimension_rules: [],
            canonical_dimension_order: [],
          })) as T[],
        };
      }
      if (sql.includes("FROM catalog_product_content_types"))
        return {
          rows: [
            {
              content_type_id: catalogSeedIds.productContentTypes.card,
              key: "card",
              display_name: { defaultLocale: "en", values: { en: "Card" } },
              status: "active",
              sort_order: 10,
              discovery_search_weight: 0.7,
            },
          ] as T[],
        };
      if (sql.includes("FROM catalog_product_content_inclusion_policies"))
        return {
          rows: [
            {
              inclusion_policy_id: catalogSeedIds.productContentInclusionPolicies.randomized,
              key: "randomized",
              display_name: { defaultLocale: "en", values: { en: "Randomized" } },
              status: "active",
              sort_order: 10,
            },
          ] as T[],
        };
      if (sql.includes("FROM catalog_resolved_product_contents")) return { rows: projectedRows as T[] };
      return { rows: [] as T[] };
    });
    const productContents = createProductContentRuntime({
      db: { query },
      eventStore: store.eventStore,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    });
    const services = { db: { query }, productContents };
    const originalRead = productContents.readProductContentsAuthoringState;
    const read = vi.spyOn(productContents, "readProductContentsAuthoringState");
    const replace = vi.spyOn(productContents, "replaceProductContents");
    await expect(seedProductContentScenario(services)).resolves.toBe(true);
    expect(store.readAllEvents()).toHaveLength(2);
    const retained = store.readAllEvents();
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await expect(seedProductContentScenario(services)).resolves.toBe(true);
      expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 2 }), expect.anything());
      expect(store.readAllEvents()).toEqual(retained);
      projectedRows = [
        {
          container_catalog_item_id: ids[0],
          container_product_id: null,
          contained_catalog_item_id: ids[1],
          contained_product_id: null,
          quantity: 99,
        },
      ];
    }
    read.mockImplementationOnce(async (...args) => {
      const captured = await originalRead(...args);
      const input = replace.mock.calls[0]![0];
      await productContents.replaceProductContents(
        { ...input, expectedVersion: captured.version, lines: [{ ...input.lines[0]!, quantity: 7 }] },
        replace.mock.calls[0]![1],
      );
      return captured;
    });
    read.mockClear();
    query.mockClear();
    await expect(seedProductContentScenario(services)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 2 }), expect.anything());
    expect(store.readAllEvents()).toHaveLength(4);
    const writes = query.mock.calls.filter(([sql]) =>
      /(?:INSERT INTO|DELETE FROM) catalog_resolved_product_contents/.test(sql),
    );
    expect(writes).toHaveLength(2);
    await expect(productContents.readProductContentsAuthoringState(ids[0])).resolves.toMatchObject({
      version: 4,
      lines: [{ quantity: 7 }],
    });
  });

  it("reconciles configured content types and inclusion policies without scenario data", async () => {
    const { services, productContents } = createSeedServices();

    await seedProductContentConfiguration(services);

    expect(productContents.upsertContentType).toHaveBeenCalledTimes(4);
    expect(productContents.upsertContentType).toHaveBeenCalledWith(
      expect.objectContaining({
        contentTypeId: catalogSeedIds.productContentTypes.card,
        key: "card",
        discoverySearchWeight: 0.7,
      }),
    );
    expect(productContents.upsertInclusionPolicy).toHaveBeenCalledTimes(4);
    expect(productContents.replaceProductContents).not.toHaveBeenCalled();
  });

  it("adds a representative scenario relationship for end-to-end rollout proof", async () => {
    const { services, productContents, db } = createSeedServices();

    await expect(seedProductContentScenario(services)).resolves.toBe(true);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM catalog_items"), [
      [catalogSeedIds.items.prismaticEvolutionsBoosterPack, catalogSeedIds.items.pikachuPrismaticEvolutions],
    ]);
    expect(productContents.replaceProductContents).toHaveBeenCalledTimes(1);
    expect(productContents.replaceProductContents).toHaveBeenCalledWith(
      expect.objectContaining({
        containerCatalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
        lines: [
          expect.objectContaining({
            containedCatalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
            contentTypeId: catalogSeedIds.productContentTypes.card,
            inclusionPolicyId: catalogSeedIds.productContentInclusionPolicies.randomized,
            provenance: expect.objectContaining({ source: "scenario-seed" }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it("records representative refresh provenance for the staging-owned scenario", async () => {
    const { services, productContents } = createSeedServices();

    await seedProductContentScenario(services, { provenanceSource: "representative-commerce-state" });

    expect(productContents.replaceProductContents).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [
          expect.objectContaining({
            provenance: expect.objectContaining({ source: "representative-commerce-state" }),
          }),
        ],
      }),
      expect.any(Object),
    );
  });

  it("waits for Catalog Item projections before writing the representative scenario relationship", async () => {
    const { services, productContents, db } = createSeedServices();
    db.query.mockResolvedValueOnce({
      rows: [{ catalog_item_id: catalogSeedIds.items.prismaticEvolutionsBoosterPack }],
    });

    await expect(seedProductContentScenario(services)).resolves.toBe(false);

    expect(productContents.upsertContentType).toHaveBeenCalledTimes(4);
    expect(productContents.upsertInclusionPolicy).toHaveBeenCalledTimes(4);
    expect(productContents.replaceProductContents).not.toHaveBeenCalled();
  });
});
