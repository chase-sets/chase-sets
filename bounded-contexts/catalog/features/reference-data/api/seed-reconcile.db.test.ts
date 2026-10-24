import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext } from "../../../support/seed-support/context";
import {
  evolveReferenceRecord,
  initialReferenceRecordState,
  type ReferenceRecordEvent,
  type ReferenceRecordState,
} from "../domain/domain";
import { seedReferenceData } from "./seed";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Reference Data seed reconcile database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

const seededExpansionIds = Object.values(catalogSeedIds.referenceRecords.expansions);
const editedBaseSet = catalogSeedIds.referenceRecords.expansions.baseSet;
/** SYNTHETIC operator edit: bootstrap must keep it, not restore the seed's `BS`. */
const editedAbbreviation = "SYNTHETIC-EDITED-BS";
const recordStream = (id: string) => `catalog.reference-record-${id}`;

describeDb("Reference Data seed reconciliation of missing seed attributes (#10059)", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["catalog"],
      "catalog_reference_data_seed_reconcile",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  const drain = () => drainLocalProjectionHandlerSets("catalog", pool, services.projectors);

  async function runSeed(): Promise<void> {
    await seedReferenceData(services);
    await drain();
  }

  async function history(id: string): Promise<{ types: string[]; state: ReferenceRecordState }> {
    const rows = await pool.query<{ event_type: ReferenceRecordEvent["type"]; payload: ReferenceRecordEvent["data"] }>(
      "SELECT event_type, payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
      [recordStream(id)],
    );
    return {
      types: rows.rows.map((row) => row.event_type),
      state: rows.rows
        .map((row) => ({ type: row.event_type, data: row.payload }) as ReferenceRecordEvent)
        .reduce(evolveReferenceRecord, initialReferenceRecordState),
    };
  }

  async function referenceRecordEventCount(): Promise<number> {
    const rows = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM event_store_events WHERE stream_id LIKE 'catalog.reference-record-%'",
    );
    return Number(rows.rows[0]?.count);
  }

  /** The seven seeded expansions as the seed wrote them before they recorded a language edition. */
  async function seedExpansionsWithoutLanguageEditions(): Promise<void> {
    await runSeed();
    for (const id of seededExpansionIds) {
      const { state } = await history(id);
      const attributes = Object.fromEntries(
        Object.entries(state.attributes).filter(([attributeKey]) => attributeKey !== "language-editions"),
      );
      await services.referenceData.referenceRecordCommandHandler({
        streamId: recordStream(id),
        command: {
          type: "ReviseReferenceRecord",
          typeKey: state.typeKey!,
          key: state.key!,
          name: state.name!,
          description: state.description,
          attributes: id === editedBaseSet ? { ...attributes, abbreviation: editedAbbreviation } : attributes,
          relationships: state.relationships,
        },
        context: seedContext,
      });
    }
    await drain();
  }

  it("adds only the missing language edition to each seeded expansion, then appends nothing on a second run", async () => {
    await seedExpansionsWithoutLanguageEditions();
    const before = new Map(await Promise.all(seededExpansionIds.map(async (id) => [id, await history(id)] as const)));
    for (const [id, { state }] of before) {
      expect(state.attributes, id).not.toHaveProperty("language-editions");
    }
    const beforeFirstRun = await referenceRecordEventCount();

    await runSeed();

    // One revision per seeded expansion and none anywhere else.
    expect(await referenceRecordEventCount()).toBe(beforeFirstRun + seededExpansionIds.length);
    for (const id of seededExpansionIds) {
      const { types, state } = await history(id);
      const prior = before.get(id)!;
      expect(types, id).toEqual([...prior.types, "catalog.reference-record.revised"]);
      expect(state.attributes, id).toEqual({ ...prior.state.attributes, "language-editions": ["en"] });
      expect({ ...state, attributes: null }, id).toEqual({ ...prior.state, attributes: null });
    }
    expect((await history(editedBaseSet)).state.attributes.abbreviation).toBe(editedAbbreviation);
    const scopeRecords = await pool.query<{ reference_record_id: string; language_editions: string[] }>(
      "SELECT reference_record_id, language_editions FROM catalog_scope_records WHERE reference_record_id = ANY($1) ORDER BY reference_record_id",
      [seededExpansionIds],
    );
    expect(scopeRecords.rows).toEqual(
      [...seededExpansionIds].sort().map((id) => ({ reference_record_id: id, language_editions: ["en"] })),
    );

    const afterFirstRun = await referenceRecordEventCount();
    await runSeed();

    expect(await referenceRecordEventCount()).toBe(afterFirstRun);
  });
});
