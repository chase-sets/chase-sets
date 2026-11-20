import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPgPool,
  createPostgresEventStore,
  withPgTransaction,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { module as catalogModule } from "../../../index";
import { createProductContentRuntime } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("product contents runtime db", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_product_contents_runtime");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createPgPool(urls.catalog, { max: 1 });
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await pool.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ catalog: pool });
  });

  it("product contents append/projection interleaving", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const context = {
      tenantId: "tnt_product_contents" as never,
      audit: { performedByUserId: "usr_product_contents" as never, forAccountId: "acc_product_contents" as never },
    };
    const streamId = "catalog.product-contents-cat_db_race";
    await eventStore.appendToStream({ streamId, expectedVersion: "no_stream", context, events: [] });
    await expect(
      eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: [{ eventType: "catalog.product-contents.resolved", payload: {} }],
      }),
    ).resolves.toHaveLength(1);
    await expect(
      eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context,
        events: [{ eventType: "catalog.product-contents.resolved", payload: {} }],
      }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
  });

  it("capped seed pool rechecks a delayed no-op and projection on their transaction client", async () => {
    await pool.query(
      "INSERT INTO catalog_items (catalog_item_id, status) VALUES ('cat_box', 'active'), ('cat_card', 'active')",
    );
    const eventStore = createPostgresEventStore({ pool });
    const checkpointStore = {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    };
    const services = createProductContentRuntime({ db: pool, eventStore, checkpointStore });
    const context = {
      tenantId: "tnt_product_contents" as never,
      audit: { performedByUserId: "usr_product_contents" as never, forAccountId: "acc_product_contents" as never },
    };
    await services.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: { defaultLocale: "en", values: { en: "Included item" } },
    });
    const input = {
      containerCatalogItemId: "cat_box" as never,
      expectedVersion: 0,
      lines: [{ containedCatalogItemId: "cat_card" as never, quantity: 1, contentTypeId: "pct_included_item" }],
    };
    const first = await services.replaceProductContents(input, context);
    expect(first.version).toBe(2);
    await expect(services.replaceProductContents({ ...input, expectedVersion: 2 }, context)).resolves.toMatchObject({
      version: 2,
    });

    let interleaved = false;
    const delayedStore: EventStore & Pick<typeof eventStore, "readStreamInTransaction"> = {
      ...eventStore,
      readStream: async (read) => {
        const snapshot = await eventStore.readStream(read);
        if (!interleaved) {
          interleaved = true;
          await services.replaceProductContents(
            {
              ...input,
              expectedVersion: 2,
              lines: [{ ...input.lines[0]!, quantity: 2 }],
            },
            context,
          );
        }
        return snapshot;
      },
    };
    const delayedServices = createProductContentRuntime({ db: pool, eventStore: delayedStore, checkpointStore });
    await delayedServices.replaceProductContents({ ...input, expectedVersion: 2 }, context);
    expect(interleaved).toBe(true);
    expect((await services.listProductContentsForContainer("cat_box"))[0]?.quantity).toBe(2);

    const handler = services.projectors[0]!.handlers["catalog.product-contents.resolved"]!;
    await withPgTransaction(pool, (client) =>
      handler(
        {
          data: first,
          streamVersion: first.version,
        } as never,
        { db: client },
      ),
    );
    expect((await services.listProductContentsForContainer("cat_box"))[0]?.quantity).toBe(2);
    expect((await services.readProductContentsAuthoringState("cat_box")).version).toBe(4);
    for (const command of [
      () => services.replaceProductContents({ ...input, expectedVersion: 2 }, context),
      () => services.removeProductContents({ containerCatalogItemId: "cat_box" as never, expectedVersion: 2 }, context),
    ]) {
      await expect(command()).rejects.toMatchObject({ code: "concurrency_conflict" });
    }
    expect(await eventStore.readStream({ streamId: "catalog.product-contents-cat_box" })).toHaveLength(4);
    expect((await services.listProductContentsForContainer("cat_box"))[0]?.quantity).toBe(2);
  });

  it("delayed cross-selection writeback and replay retain both configurations with a capped pool", async () => {
    await pool.query(
      `INSERT INTO catalog_blueprints (blueprint_id, key, name, dimension_rules, canonical_dimension_order)
       VALUES ('bp_languages', 'languages', 'Languages', $1, '["language"]'::jsonb)`,
      [JSON.stringify([{ dimensionId: "language", allowedOptions: [{ optionId: "en" }, { optionId: "ja" }] }])],
    );
    await pool.query(
      "INSERT INTO catalog_items (catalog_item_id, status, blueprint_id) VALUES ('cat_box', 'active', 'bp_languages')",
    );
    const eventStore = createPostgresEventStore({ pool });
    const checkpointStore = {
      loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
      saveCheckpoint: async () => undefined,
    };
    const services = createProductContentRuntime({ db: pool, eventStore, checkpointStore });
    const context = {
      tenantId: "tnt_product_contents" as never,
      audit: { performedByUserId: "usr_product_contents" as never, forAccountId: "acc_product_contents" as never },
    };
    await services.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: { defaultLocale: "en", values: { en: "Included item" } },
    });
    const input = {
      containerCatalogItemId: "cat_box" as never,
      containerSelectedOptions: [{ dimensionId: "language", optionId: "en" }],
      expectedVersion: 0,
      lines: [{ quantity: 1, contentTypeId: "pct_included_item" }],
    };
    let interleaved = false;
    const delayedStore: EventStore & Pick<typeof eventStore, "readStreamInTransaction"> = {
      ...eventStore,
      appendToStream: async (command) => {
        const committed = await eventStore.appendToStream(command);
        if (!interleaved) {
          interleaved = true;
          await services.replaceProductContents(
            {
              ...input,
              expectedVersion: 2,
              containerSelectedOptions: [{ dimensionId: "language", optionId: "ja" }],
              lines: [{ ...input.lines[0]!, quantity: 2 }],
            },
            context,
          );
        }
        return committed;
      },
    };
    const delayedServices = createProductContentRuntime({ db: pool, eventStore: delayedStore, checkpointStore });
    await delayedServices.replaceProductContents(input, context);
    const projected = async () =>
      (await services.listProductContentsForContainer("cat_box"))
        .map((line) => [line.containerProductId, line.quantity])
        .sort();
    const expected = [
      ["cat_box::language:en", 1],
      ["cat_box::language:ja", 2],
    ];
    expect(await projected()).toEqual(expected);
    await pool.query("DELETE FROM catalog_resolved_product_contents");
    const events = await eventStore.readStream({ streamId: "catalog.product-contents-cat_box" });
    const handler = services.projectors[0]!.handlers["catalog.product-contents.resolved"]!;
    for (const event of events.filter((event) => event.eventType === "catalog.product-contents.resolved")) {
      await withPgTransaction(pool, (client) =>
        handler({ data: event.payload, streamVersion: event.streamVersion } as never, { db: client }),
      );
    }
    expect(await projected()).toEqual(expected);
    await pool.query("DELETE FROM catalog_resolved_product_contents");
    await services.replaceProductContents({ ...input, expectedVersion: 4 }, context);
    expect(await projected()).toEqual([expected[0]]);
    expect(await eventStore.readStream({ streamId: "catalog.product-contents-cat_box" })).toHaveLength(4);
  });
});
