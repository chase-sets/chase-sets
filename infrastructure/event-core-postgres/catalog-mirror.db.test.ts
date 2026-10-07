import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildCatalogMirrorProjectionHandlers } from "./catalog-mirror";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("catalog mirror blueprint lifecycle on Postgres", () => {
  let schema: IsolatedPostgresTestSchema;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "catalog_mirror");
  });

  afterAll(async () => {
    await schema?.close();
  });

  it.each([
    { name: "statusless Collections shape", hasStatus: false, blueprintDraftStatusOnUpsert: false },
    { name: "default Checkout shape", hasStatus: true, blueprintDraftStatusOnUpsert: undefined },
    { name: "opted-out Inventory shape", hasStatus: true, blueprintDraftStatusOnUpsert: false },
  ])("creates, revises, publishes and replays the $name", async ({ hasStatus, blueprintDraftStatusOnUpsert }) => {
    await schema.pool.query(`
      DROP TABLE IF EXISTS mirror_catalog_items, mirror_catalog_blueprints;
      CREATE TABLE mirror_catalog_blueprints (
        blueprint_id text PRIMARY KEY,
        name text NOT NULL DEFAULT '',
        ${hasStatus ? "status text NOT NULL DEFAULT 'draft'," : ""}
        dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
        canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE mirror_catalog_items (
        catalog_item_id text PRIMARY KEY,
        blueprint_id text,
        product_schema jsonb,
        updated_at timestamptz NOT NULL
      );
    `);
    const handlers = buildCatalogMirrorProjectionHandlers(schema.pool, {
      tablePrefix: "mirror_catalog",
      blueprintDraftStatusOnUpsert,
    });
    const createdAt = "2026-05-09T00:00:00.000Z";
    const revisedAt = "2026-05-10T00:00:00.000Z";
    const publishedAt = "2026-05-11T00:00:00.000Z";
    const event = (type: string, data: Record<string, unknown>, recordedAt: string) =>
      buildTransportEvent(type, data, {
        streamId: "catalog.blueprint-bp_1",
        timing: { occurredAt: recordedAt, recordedAt },
      });
    const readBlueprint = async () => (await schema.pool.query("SELECT * FROM mirror_catalog_blueprints")).rows;

    await handlers["catalog.blueprint.created"]!(
      event("catalog.blueprint.created", { blueprintId: "bp_1", name: "Card" }, createdAt),
    );
    expect(await readBlueprint()).toEqual([
      expect.objectContaining({ blueprint_id: "bp_1", name: "Card", updated_at: new Date(createdAt) }),
    ]);
    await handlers["catalog.blueprint.revised"]!(
      event("catalog.blueprint.revised", { name: "Card revised" }, revisedAt),
    );
    expect(await readBlueprint()).toEqual([
      expect.objectContaining({ name: "Card revised", updated_at: new Date(revisedAt) }),
    ]);
    if (hasStatus) expect((await readBlueprint())[0]!.status).toBe("draft");

    await schema.pool.query(
      `INSERT INTO mirror_catalog_items VALUES ('assigned', 'bp_1', NULL, $1), ('other', 'bp_other', NULL, $1)`,
      [createdAt],
    );
    const published = event("catalog.blueprint.published", {}, publishedAt);
    for (let replay = 0; replay < 2; replay += 1) {
      await handlers["catalog.blueprint.published"]!(published);
      const rows = await readBlueprint();
      expect(rows).toEqual([
        expect.objectContaining({ blueprint_id: "bp_1", name: "Card revised", updated_at: new Date(publishedAt) }),
      ]);
      if (hasStatus) expect(rows[0]!.status).toBe(blueprintDraftStatusOnUpsert === false ? "draft" : "active");
      else expect(rows[0]).not.toHaveProperty("status");
      expect((await schema.pool.query("SELECT * FROM mirror_catalog_items ORDER BY catalog_item_id")).rows).toEqual([
        {
          catalog_item_id: "assigned",
          blueprint_id: "bp_1",
          product_schema: { canonicalDimensionOrder: [], dimensions: [] },
          updated_at: new Date(createdAt),
        },
        { catalog_item_id: "other", blueprint_id: "bp_other", product_schema: null, updated_at: new Date(createdAt) },
      ]);
    }
  });
});
