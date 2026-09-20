import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import {
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../../source-observations/api/providers/tcgplayer/adapter";
import { resolveHeldSetExport } from "./held-set-resolution";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog"] as const;

describeDb("scope-sync-held-set-resolution real DB matrix", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "scope_sync_held_sets");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.catalog.query(catalogModule.schemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("resolves four product lines independently and reports every closed refusal reason", async () => {
    await seedScope("scope-magic-shared", "magic", "set", "Magic Shared");
    await seedScope("scope-pokemon-shared", "pokemon", "expansion", "Pokemon Shared");
    await seedScope("scope-yugioh-starter", "yugioh", "set", "Starter Deck: Yugi");
    await seedScope("scope-one-piece-romance", "one-piece", "set", "Romance Dawn");
    await seedScope("scope-one-piece-pending", "one-piece", "set", "Pending Review");

    await seedObservation(TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "magic-shared", "Shared Name");
    await seedObservation(
      TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "pokemon-shared",
      "Shared Name",
      "expansion",
    );
    await seedObservation(
      TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "yugioh-starter",
      "Starter Deck: Yugi",
    );
    await seedObservation(
      TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "one-piece-romance",
      "Romance Dawn",
    );
    await seedObservation(TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "ambiguous-a", "Ambiguous");
    await seedObservation(TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "ambiguous-b", " ambiguous ");
    await seedObservation(TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "unmapped", "No Mapping");
    await seedObservation(
      TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "pending",
      "Review Pending",
    );

    await seedMapping(
      "mapping-magic-shared",
      "scope-magic-shared",
      TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "magic-shared",
      "accepted",
    );
    await seedMapping(
      "mapping-pokemon-shared",
      "scope-pokemon-shared",
      TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "pokemon-shared",
      "auto-accepted",
    );
    await seedMapping(
      "mapping-yugioh-starter",
      "scope-yugioh-starter",
      TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "yugioh-starter",
      "accepted",
    );
    await seedMapping(
      "mapping-one-piece-romance",
      "scope-one-piece-romance",
      TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "one-piece-romance",
      "accepted",
    );
    await seedMapping(
      "mapping-one-piece-pending",
      "scope-one-piece-pending",
      TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      "pending",
      "proposed",
    );

    const result = await resolveHeldSetExport(
      pools.catalog,
      exportFixture([
        ["Magic", "Shared Name"],
        ["  MAGIC ", " shared   name "],
        ["Pokemon", "Shared Name"],
        ["Yu-Gi-Oh!", "Starter Deck: Yugi"],
        ["One Piece Card Game", "Romance Dawn"],
        ["Pokemon Japan", "Japanese Set"],
        ["Pokemon", "Absent Set"],
        ["Magic", "Ambiguous"],
        ["Yu Gi Oh", "No Mapping"],
        ["One Piece", "Review Pending"],
      ]),
    );

    expect(result.resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeRecordId: "scope-magic-shared", productDomain: "magic", rowCount: 2 }),
        expect.objectContaining({ scopeRecordId: "scope-pokemon-shared", productDomain: "pokemon", rowCount: 1 }),
        expect.objectContaining({ scopeRecordId: "scope-yugioh-starter", productDomain: "yugioh" }),
        expect.objectContaining({ scopeRecordId: "scope-one-piece-romance", productDomain: "one-piece" }),
      ]),
    );
    expect(result.resolved.filter((row) => row.setName.toLowerCase().includes("shared"))).toEqual([
      expect.objectContaining({ scopeRecordId: "scope-magic-shared" }),
      expect.objectContaining({ scopeRecordId: "scope-pokemon-shared" }),
    ]);
    expect(Object.fromEntries(result.unresolved.map((row) => [row.setName, row.reason]))).toEqual({
      Ambiguous: "set-ambiguous",
      "Review Pending": "mapping-not-accepted",
      "Japanese Set": "product-line-unresolved",
      "Absent Set": "set-unresolved",
      "No Mapping": "mapping-missing",
    });
    expect(result.totals).toEqual({
      rows: 10,
      distinctPairs: 9,
      resolvedPairs: 4,
      unresolvedPairs: 5,
      resolvedRows: 5,
      unresolvedRows: 5,
    });
  });

  async function seedScope(
    id: string,
    productDomain: "pokemon" | "magic" | "yugioh" | "one-piece",
    scopeKind: "expansion" | "set",
    name: string,
  ) {
    await pools.catalog.query(
      `INSERT INTO catalog_scope_records (
         scope_record_id, product_domain, scope_kind, reference_type_key, reference_record_id,
         reference_record_key, name, lifecycle_status
       ) VALUES ($1, $2, $3, $3, $4, $4, $5, 'active')`,
      [id, productDomain, scopeKind, `reference-${id}`, name],
    );
  }

  async function seedObservation(unitKey: string, externalId: string, label: string, scopeKind = "set") {
    await pools.catalog.query(
      `INSERT INTO catalog_provider_scope_observations (
         provider_key, unit_key, scope_kind, source_query_kind, language_code, external_id, label,
         observation_hash, scan_id, scanned_at
       ) VALUES ('tcgplayer', $1, $2, 'sets', 'en', $3, $4, $5, 'scan-held-sets', now())`,
      [unitKey, scopeKind, externalId, label, `hash-${unitKey}-${externalId}`],
    );
  }

  async function seedMapping(
    mappingId: string,
    scopeRecordId: string,
    unitKey: string,
    setId: string,
    reviewStatus: "accepted" | "auto-accepted" | "proposed",
  ) {
    await pools.catalog.query(
      `INSERT INTO catalog_provider_scope_mappings (
         mapping_id, scope_record_id, provider_key, unit_key, set_id, set_name,
         confidence, review_status, policy_version
       ) VALUES ($1, $2, 'tcgplayer', $3, $4, $4, 'exact', $5, 'test')`,
      [mappingId, scopeRecordId, unitKey, setId, reviewStatus],
    );
  }
});

const liveHeader = [
  "TCGplayer Id",
  "Product Line",
  "Set Name",
  "Product Name",
  "Title",
  "Number",
  "Rarity",
  "Condition",
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Total Quantity",
  "Add to Quantity",
  "TCG Marketplace Price",
  "Photo URL",
] as const;

function exportFixture(rows: readonly (readonly [string, string])[]): Uint8Array {
  const lines = rows.map(([productLine, setName], index) =>
    liveHeader
      .map((header) => {
        if (header === "TCGplayer Id") return String(index + 1);
        if (header === "Product Line") return productLine;
        if (header === "Set Name") return setName;
        return "ignored";
      })
      .map(csvCell)
      .join(","),
  );
  return new TextEncoder().encode([liveHeader.join(","), ...lines].join("\r\n"));
}

function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
