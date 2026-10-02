import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  OBSERVATION_PACK_DECISION_LINK,
  buildObservationPack,
  observationPackEnvelopeContentHash,
  recordObservationPackAcceptance,
  replayRepresentativeCatalogPacks,
  representativeCatalogExternalReferenceDigest,
  scrydexOnePieceCardFixture as scrydexCardFixture,
  serializeObservationPackManifest,
  type ObservationPackBundle,
} from "@chase-sets/catalog/server";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as checkoutModule } from "@chase-sets/checkout";
import { module as collectionsModule } from "@chase-sets/collections";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { module as discoveryModule } from "@chase-sets/discovery";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { module as orderingModule } from "@chase-sets/ordering";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  seedMountedContextTestRuntimeIfEmpty,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sourceImage = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAYAAADkOT91AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGMQCVjwHxkz0EIAAHp5MEltiCNbAAAAAElFTkSuQmCC",
    "base64",
  ),
);
const sourceImageUrls = [
  "https://cards.scryfall.io/normal/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.jpg",
  "https://cards.scryfall.io/png/front/0/0/0000579f-7b35-4ed3-b44c-db2a538066fe.png",
] as const;
const temporaryRoots: string[] = [];
const storedAssets = new Map<string, Uint8Array>();
let catalogAssetBaseUrl = "http://127.0.0.1:4173/catalog-assets";
const replayContextNames = [
  "catalog",
  "checkout",
  "collections",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "discovery",
] as const;

const catalogAssetStorage = {
  async putObject(input: { key: string; body: Uint8Array }) {
    storedAssets.set(input.key, new Uint8Array(input.body));
    return {
      key: input.key,
      publicUrl: `${catalogAssetBaseUrl}/${input.key}`,
    };
  },
};

describe("representative catalog Observation Pack replay", () => {
  const seedRuntime = useRepresentativeCatalogRuntime();

  beforeEach(() => {
    storedAssets.clear();
    delete process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE;
    delete process.env.REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT;
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("synthetic seeded-Set Lorcana pack publishes required ink through the real seed and converges only for seeded state", async () => {
    // This positive covers seeded-state ink publication/convergence, not source 03's pack-provisioned Set.
    const packDir = await writeSyntheticLorcanaPack();
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = packDir;
    vi.stubGlobal("fetch", async () => {
      throw new Error("synthetic Lorcana replay must never call provider transport");
    });

    await seedRuntime.seed();
    const rows = await seedRuntime.pools.catalog.query<{
      observation_id: string;
      observation_status: string;
      status: string;
      subtitle: string;
      display_identity_hash: string;
      ink: string;
    }>(
      `SELECT observation.observation_id, observation.status AS observation_status,
         item.status, identity.subtitle, identity.display_identity_hash, value->>'value' AS ink
       FROM catalog_source_observations AS observation
       JOIN catalog_items AS item ON item.catalog_item_id = observation.promoted_catalog_item_id
       JOIN catalog_item_display_identities AS identity
         ON identity.catalog_item_id = item.catalog_item_id AND identity.language_code = item.language_code
       CROSS JOIN LATERAL jsonb_array_elements(item.field_values) AS value
       JOIN catalog_fields AS field ON field.field_id = value->>'fieldId'
       WHERE observation.provider_key = 'lorcanajson' AND field.key = 'ink-color'
       ORDER BY observation.observation_id`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const [index, ink] of ["Amethyst", "Amber"].entries()) {
      expect(rows.rows[index]).toMatchObject({ observation_status: "promoted", status: "active", ink });
      expect(rows.rows[index]?.subtitle).toContain(ink);
      expect(rows.rows[index]?.display_identity_hash).toBeTruthy();
    }
    const observationCount = await seedRuntime.pools.catalog.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM catalog_source_observations WHERE provider_key = 'lorcanajson'",
    );
    expect(Number(observationCount.rows[0]?.count)).toBe(2);
    const firstEventCount = await countRows(seedRuntime.pools.catalog, "event_store_events");
    const firstAssetCount = storedAssets.size;
    await seedRuntime.seed();
    expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(firstEventCount);
    expect(storedAssets.size).toBe(firstAssetCount);
  });

  it("synthetic source-03-shaped Lorcana pack publishes truthful identities and converges on repeated boots", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticLorcanaPack(["Amethyst"], "1");
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "representative-catalog-synthetic-repeat-"));
    temporaryRoots.push(evidenceRoot);
    const receiptPath = path.join(evidenceRoot, "receipt.json");
    process.env.REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT = receiptPath;
    vi.stubGlobal("fetch", async () => {
      throw new Error("synthetic Lorcana replay must never call provider transport");
    });

    // Source 03's key "1" is provisioned by the pack, unlike the seeded "the-first-chapter" positive.
    await seedRuntime.seed();
    const observations = await seedRuntime.pools.catalog.query<{
      status: string;
      promoted_catalog_item_id: string;
      item_status: string;
      publication_count: number;
    }>(
      `SELECT observation.status, observation.promoted_catalog_item_id, item.status AS item_status,
         (SELECT COUNT(*)::integer FROM event_store_events AS publication
          WHERE publication.stream_id = 'catalog.item-' || item.catalog_item_id
            AND publication.event_type = 'catalog.catalog-item.published') AS publication_count
       FROM catalog_source_observations AS observation
       JOIN catalog_items AS item ON item.catalog_item_id = observation.promoted_catalog_item_id
       WHERE observation.provider_key = 'lorcanajson'`,
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({ status: "promoted", item_status: "active", publication_count: 1 });
    const provisionedSet = await seedRuntime.pools.catalog.query<{ reference_record_id: string; key: string }>(
      "SELECT reference_record_id, key FROM catalog_reference_records WHERE reference_record_id = $1",
      ["ref_lorcanajson_lorcana_set_1"],
    );
    expect(provisionedSet.rows).toEqual([{ reference_record_id: "ref_lorcanajson_lorcana_set_1", key: "1" }]);
    const firstReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(firstReceipt).toMatchObject({
      schemaVersion: "representative-catalog-replay.receipt/v1",
      type: "representative-catalog-replay.complete",
      packs: [{ envelopeCount: 1, observationCount: 1, catalogItemCount: 1, assetSetCount: 1 }],
    });
    const firstEventCount = await countRows(seedRuntime.pools.catalog, "event_store_events");
    const firstAssetCount = storedAssets.size;
    await unlink(receiptPath);

    const identities = await seedRuntime.pools.catalog.query<{ subtitle: string; resolution_status: string }>(
      "SELECT subtitle, resolution_status FROM catalog_item_display_identities WHERE catalog_item_id = $1",
      [observations.rows[0]!.promoted_catalog_item_id],
    );
    expect(identities.rows).toHaveLength(1);
    expect(identities.rows[0]).toMatchObject({ resolution_status: "resolved" });
    expect(identities.rows[0]?.subtitle).toContain("The First Chapter");
    expect(identities.rows[0]?.subtitle).toContain("Amethyst");
    await seedRuntime.seed();
    expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(firstEventCount);
    expect(storedAssets.size).toBe(firstAssetCount);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
      type: "representative-catalog-replay.complete",
      totals: { appendedEventCount: 0, appendedAssetSetCount: 0 },
    });
    await seedRuntime.seed();
    expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(firstEventCount);
    expect(storedAssets.size).toBe(firstAssetCount);
    const retainedObservations = await seedRuntime.pools.catalog.query<{
      status: string;
      promoted_catalog_item_id: string;
      item_status: string;
      publication_count: number;
    }>(
      `SELECT observation.status, observation.promoted_catalog_item_id, item.status AS item_status,
         (SELECT COUNT(*)::integer FROM event_store_events AS publication
          WHERE publication.stream_id = 'catalog.item-' || item.catalog_item_id
            AND publication.event_type = 'catalog.catalog-item.published') AS publication_count
       FROM catalog_source_observations AS observation
       JOIN catalog_items AS item ON item.catalog_item_id = observation.promoted_catalog_item_id
       WHERE observation.provider_key = 'lorcanajson'`,
    );
    expect(retainedObservations.rows).toEqual(observations.rows);
    const services = catalogModule.createServices(seedRuntime.pools.catalog, { catalogAssetStorage });
    await services.referenceData.referenceRecordCommandHandler({
      streamId: "catalog.reference-record-ref_lorcanajson_lorcana_set_1",
      command: { type: "DeprecateReferenceRecord" },
      context: { tenantId: "tnt_system", audit: { performedByUserId: "usr_system", forAccountId: "acc_system" } },
    });
    await services.referenceData.referenceRecordCommandHandler({
      streamId: "catalog.reference-record-ref_lorcanajson_lorcana_set_1",
      command: { type: "ArchiveReferenceRecord" },
      context: { tenantId: "tnt_system", audit: { performedByUserId: "usr_system", forAccountId: "acc_system" } },
    });
    await unlink(receiptPath);
    const terminalEventCount = await countRows(seedRuntime.pools.catalog, "event_store_events");
    await expect(seedRuntime.seed()).rejects.toMatchObject({
      name: "RepresentativeCatalogReplayError",
      code: "representative-catalog-history-invalid",
    });
    expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(terminalEventCount);
    expect(storedAssets.size).toBe(firstAssetCount);
    await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["CreateCatalogItem", "SetCatalogItemProductAssetSets"])(
    "resumes a synthetic promotion interrupted after %s without reauthoring its stream",
    async (interruptedCommand) => {
      await seedRuntime.bootstrap();
      process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticLorcanaPack(["Amethyst"], "1");
      vi.stubGlobal("fetch", async () => {
        throw new Error("synthetic replay must stay offline");
      });
      const createServices = catalogModule.createServices;
      let interruptedItemId: string | null = null;
      const spy = vi.spyOn(catalogModule, "createServices").mockImplementation((...args) => {
        const services = createServices(...args);
        const handler = services.items.commandHandler;
        vi.spyOn(services.items, "commandHandler").mockImplementation(async (input) => {
          const result = await handler(input);
          if (input.command.type === interruptedCommand && interruptedItemId === null) {
            interruptedItemId = input.streamId.slice("catalog.item-".length);
            throw new Error("synthetic crash after durable item creation");
          }
          return result;
        });
        return services;
      });
      await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-promotion-failed");
      spy.mockRestore();
      expect(interruptedItemId).not.toBeNull();
      const recorded = await seedRuntime.pools.catalog.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM event_store_events WHERE event_type = 'catalog.source-observation.recorded'",
      );
      expect(recorded.rows[0]?.count).toBe(1);
      await seedRuntime.seed();
      const created = await seedRuntime.pools.catalog.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM event_store_events WHERE stream_id = $1 AND event_type = 'catalog.catalog-item.created'",
        [`catalog.item-${interruptedItemId}`],
      );
      expect(created.rows[0]?.count).toBe(1);
      const duplicateEvents = await seedRuntime.pools.catalog.query(
        "SELECT event_type FROM event_store_events WHERE stream_id = $1 GROUP BY event_type, payload HAVING COUNT(*) > 1",
        [`catalog.item-${interruptedItemId}`],
      );
      expect(duplicateEvents.rows).toEqual([]);
      const promoted = await seedRuntime.pools.catalog.query<{ promoted_catalog_item_id: string; status: string }>(
        "SELECT promoted_catalog_item_id, status FROM catalog_source_observations WHERE provider_key = 'lorcanajson'",
      );
      expect(promoted.rows).toEqual([{ promoted_catalog_item_id: interruptedItemId, status: "promoted" }]);
      const events = await countRows(seedRuntime.pools.catalog, "event_store_events");
      const assets = storedAssets.size;
      await seedRuntime.seed();
      expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(events);
      expect(storedAssets.size).toBe(assets);
    },
  );

  it("refuses synthetic pre-fix fingerprints without rewriting history or issuing a completion receipt", async () => {
    await seedRuntime.bootstrap();
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticLorcanaPack(["Amethyst"], "1");
    const root = await mkdtemp(path.join(tmpdir(), "representative-catalog-old-fingerprint-"));
    temporaryRoots.push(root);
    const receiptPath = path.join(root, "receipt.json");
    process.env.REPRESENTATIVE_CATALOG_REPLAY_EVIDENCE_OUT = receiptPath;
    vi.stubGlobal("fetch", async () => {
      throw new Error("synthetic replay must stay offline");
    });
    const query = seedRuntime.pools.catalog.query.bind(seedRuntime.pools.catalog);
    const spy = vi
      .spyOn(seedRuntime.pools.catalog, "query")
      .mockImplementation(async (sql, values) =>
        sql.includes("AS reference_event") ? { rows: [], rowCount: 0 } : query(sql, values),
      );
    // Synthetic #8470 history: the real planner sees no Set name before projection.
    await seedRuntime.seed();
    spy.mockRestore();
    vi.restoreAllMocks();
    await unlink(receiptPath);
    const events = await countRows(seedRuntime.pools.catalog, "event_store_events");
    const assets = storedAssets.size;
    await expect(seedRuntime.seed()).rejects.toMatchObject({
      name: "RepresentativeCatalogReplayError",
      code: "representative-catalog-history-invalid-plan",
    });
    expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(events);
    expect(storedAssets.size).toBe(assets);
    await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("synthetic Lorcana pack without ink cannot take ordinary promotion or publication", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticLorcanaPack([null]);
    vi.stubGlobal("fetch", async () => {
      throw new Error("synthetic Lorcana replay must never call provider transport");
    });
    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-promotion-failed");
    const observations = await seedRuntime.pools.catalog.query<{
      status: string;
      promoted_catalog_item_id: string | null;
    }>("SELECT status, promoted_catalog_item_id FROM catalog_source_observations WHERE provider_key = 'lorcanajson'");
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]?.status).not.toBe("promoted");
    expect(observations.rows[0]?.promoted_catalog_item_id).toBeNull();
  });

  it("replays through mapping, promotion, asset normalization, publication, downstream projections, and converges on boot two", async () => {
    const packDir = await writeSyntheticPack({ accepted: true });
    const assetServer = await startCatalogAssetServer();
    catalogAssetBaseUrl = assetServer.baseUrl;
    await seedRuntime.addUnrelatedCatalogEvent();
    const prerequisiteBeforeReplay = await seedRuntime.pools.catalog.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM catalog_provider_integration_profile_versions
       WHERE provider_key = 'scryfall'
         AND profile_key = 'mtg-card-print-reference-data'
         AND lifecycle = 'active'
         AND active = true`,
    );
    expect(Number(prerequisiteBeforeReplay.rows[0]?.count ?? 0)).toBe(0);
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = packDir;
    const networkFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async () => {
      throw new Error("test transport must never be called");
    });

    await seedRuntime.seed();
    const firstEventCount = await countRows(seedRuntime.pools.catalog, "event_store_events");
    const firstStoredAssetCount = storedAssets.size;

    const observations = await seedRuntime.pools.catalog.query<{
      observation_id: string;
      promoted_catalog_item_id: string;
      status: string;
    }>(
      `SELECT observation_id, promoted_catalog_item_id, status
       FROM catalog_source_observations
       WHERE provider_key = 'scryfall'
         AND source_profile_key = 'mtg-card-print-reference-data'`,
    );
    expect(observations.rows).toHaveLength(1);
    expect(observations.rows[0]).toMatchObject({
      observation_id: "scryfall_card_en_0000579f-7b35-4ed3-b44c-db2a538066fe",
      status: "promoted",
    });

    const itemId = observations.rows[0]!.promoted_catalog_item_id;
    const items = await replayEvidence(seedRuntime.pools.catalog, [itemId]);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("active");
    expect(items[0]?.externalReferences).toEqual(
      expect.arrayContaining([{ providerKey: "tcgplayer", externalKey: "product:14240" }]),
    );
    expect(items[0]?.productAssetSets).toHaveLength(1);
    expect(items[0]?.productAssetSets[0]).toMatchObject({
      kind: "product-image",
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      source: { role: "source", publicUrl: expect.stringContaining("/catalog-assets/") },
      variants: [
        { role: "thumbnail", density: 1 },
        { role: "thumbnail", density: 2 },
        { role: "search-card", density: 1 },
        { role: "search-card", density: 2 },
        { role: "catalog-detail", density: 1 },
        { role: "catalog-detail", density: 2 },
      ],
    });
    expect(storedAssets.size).toBe(7);
    expect(representativeCatalogExternalReferenceDigest(items)).toMatch(/^sha256:[0-9a-f]{64}$/);

    const [searchProjection, detailProjection] = await Promise.all([
      seedRuntime.pools.discovery.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM discovery_search_catalog_items WHERE catalog_item_id = $1",
        [itemId],
      ),
      seedRuntime.pools.discovery.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM discovery_item_detail_catalog_items WHERE catalog_item_id = $1",
        [itemId],
      ),
    ]);
    expect(Number(searchProjection.rows[0]?.count ?? 0)).toBe(1);
    expect(Number(detailProjection.rows[0]?.count ?? 0)).toBe(1);

    try {
      const verifier = await import("../../../scripts/verify-observation-pack.mjs");
      let verifierOutput = "";
      const verifierExitCode = await verifier.runVerifyObservationPackCli(
        [
          "--target",
          "local",
          "--pack-dir",
          packDir,
          "--require-accepted",
          "true",
          "--post-replay",
          "true",
          "--catalog-database-url",
          seedRuntime.databaseUrls.catalog,
          "--discovery-database-url",
          seedRuntime.databaseUrls.discovery,
          "--asset-base-url",
          assetServer.baseUrl,
        ],
        process.env,
        { write: (value: string) => void (verifierOutput += value) },
        { fetch: networkFetch },
      );
      expect(verifierExitCode).toBe(0);
      expect(JSON.parse(verifierOutput)).toMatchObject({
        status: "verified",
        postReplay: {
          externalReferenceDigest: representativeCatalogExternalReferenceDigest(items),
          counts: {
            envelopes: 1,
            observations: 1,
            catalogItems: 1,
            productAssetSets: 1,
            storedAssetUrls: 7,
            discoverySearchItems: 1,
            discoveryItemDetails: 1,
          },
          assetRoute: { checked: 7, http200: 7 },
        },
      });

      await seedRuntime.seed();
      expect(await countRows(seedRuntime.pools.catalog, "event_store_events")).toBe(firstEventCount);
      expect(storedAssets.size).toBe(firstStoredAssetCount);

      await expectPoisonedHistoriesToFail({
        pool: seedRuntime.pools.catalog,
        services: catalogModule.createServices(seedRuntime.pools.catalog, { catalogAssetStorage }),
        packDir,
        eventCount: firstEventCount,
      });
    } finally {
      await assetServer.close();
    }
  }, 240_000);

  it("refuses a non-accepted pack with no partial pack state", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticPack({ accepted: false });
    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-pack-not-accepted");
    await expectNoPackState(seedRuntime.pools.catalog);
  });

  it("refuses an active-profile version mismatch with no partial pack state", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticPack({
      accepted: true,
      profileVersion: "2026.06.18",
    });
    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-profile-version-mismatch");
    await expectNoPackState(seedRuntime.pools.catalog);
  });

  it("refuses a tampered asset with no partial pack state", async () => {
    const packDir = await writeSyntheticPack({ accepted: true });
    const manifest = JSON.parse(await readFile(path.join(packDir, "manifest.json"), "utf8"));
    await writeFile(path.join(packDir, ...manifest.assets[0].path.split("/")), Buffer.from("tampered"));
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = packDir;

    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-asset-hash-mismatch");
    await expectNoPackState(seedRuntime.pools.catalog);
  });

  it("refuses a missing asset with no partial pack state", async () => {
    const packDir = await writeSyntheticPack({ accepted: true });
    const manifest = JSON.parse(await readFile(path.join(packDir, "manifest.json"), "utf8"));
    await unlink(path.join(packDir, ...manifest.assets[0].path.split("/")));
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = packDir;

    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-asset-missing");
    await expectNoPackState(seedRuntime.pools.catalog);
  });

  it("refuses an undecodable asset with no partial pack state", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticPack({
      accepted: true,
      assetBytes: new TextEncoder().encode("not-an-image"),
    });

    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-asset-undecodable");
    await expectNoPackState(seedRuntime.pools.catalog);
  });

  it("replays a synthetic Scrydex expansion-labelled One Piece pack through the seed entrypoint", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticScrydexPack();
    vi.stubGlobal("fetch", async () => {
      throw new Error("test transport must never be called");
    });

    await seedRuntime.seed();
    const result = await seedRuntime.pools.catalog.query<{ status: string; promoted_catalog_item_id: string }>(
      "SELECT status, promoted_catalog_item_id FROM catalog_source_observations WHERE provider_key = 'scrydex'",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ status: "promoted", promoted_catalog_item_id: expect.any(String) });
    const items = await replayEvidence(seedRuntime.pools.catalog, [result.rows[0]!.promoted_catalog_item_id]);
    expect(items).toMatchObject([{ status: "active" }]);
  }, 240_000);

  it("refuses a conflicting synthetic Scrydex manifest before recording pack state", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = await writeSyntheticScrydexPack(true);

    await expect(seedRuntime.seed()).rejects.toThrow("representative-catalog-import-failed");
    const observations = await seedRuntime.pools.catalog.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM catalog_source_observations WHERE provider_key = 'scrydex'",
    );
    expect(Number(observations.rows[0]?.count ?? 0)).toBe(0);
    expect(storedAssets.size).toBe(0);
  }, 240_000);

  it("keeps representative Catalog replay off through the real no-options seed entrypoint", async () => {
    process.env.REPRESENTATIVE_CATALOG_PACK_SOURCE = path.join(tmpdir(), "must-not-be-read-by-default-profile");

    await expect(seedRuntime.seedDefault()).resolves.toBeDefined();
    const observations = await seedRuntime.pools.catalog.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM catalog_source_observations WHERE provider_key = 'scryfall'",
    );
    expect(Number(observations.rows[0]?.count ?? 0)).toBe(0);
  }, 180_000);
});

function useRepresentativeCatalogRuntime() {
  let databaseUrls: Readonly<Record<(typeof replayContextNames)[number], string>> | undefined;
  let pools: Readonly<Record<(typeof replayContextNames)[number], PgTransactionalPool>> | undefined;
  const requirePools = () => {
    if (!pools) throw new Error("Representative Catalog test pools are not initialized.");
    return pools;
  };

  beforeAll(async () => {
    const baseUrl = process.env.TEST_DATABASE_URL;
    if (!baseUrl) {
      throw new Error("TEST_DATABASE_URL is required for database-backed representative Catalog seed tests.");
    }
    databaseUrls = createMultiContextTestDatabaseUrls(baseUrl, replayContextNames, "representative_catalog_seed");
    await ensureMultiContextTestDatabases(baseUrl, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls) as typeof pools;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(requirePools());
  }, 120_000);
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function seedWithOptions(options: Parameters<typeof seedMountedContextTestRuntimeIfEmpty>[2]) {
    const activePools = requirePools();
    const runtime = createMountedContextTestRuntime([
      {
        contextName: "catalog",
        module: catalogModule,
        pool: activePools.catalog,
        ports: { catalogAssetStorage },
      },
      {
        contextName: "checkout",
        mountRole: "source-only",
        module: checkoutModule,
        pool: activePools.checkout,
        ports: { commercialTermsResolver: createNoopCommercialTermsResolver() },
      },
      {
        contextName: "collections",
        mountRole: "source-only",
        module: collectionsModule,
        pool: activePools.collections,
        ports: undefined,
      },
      {
        contextName: "identity",
        mountRole: "source-only",
        module: identityModule,
        pool: activePools.identity,
        ports: undefined,
      },
      {
        contextName: "inventory",
        mountRole: "source-only",
        module: inventoryModule,
        pool: activePools.inventory,
        ports: undefined,
      },
      {
        contextName: "marketplace",
        mountRole: "source-only",
        module: marketplaceModule,
        pool: activePools.marketplace,
        ports: { commercialTermsResolver: createNoopCommercialTermsResolver() },
      },
      {
        contextName: "ordering",
        mountRole: "source-only",
        module: orderingModule,
        pool: activePools.ordering,
        ports: { inventoryCleanupAuthority: { kind: "not-mounted" } },
      },
      {
        contextName: "discovery",
        module: discoveryModule,
        pool: activePools.discovery,
        ports: undefined,
      },
    ]);
    await seedMountedContextTestRuntimeIfEmpty(runtime, ["catalog", "discovery"], options);
    return runtime;
  }

  return {
    get pools() {
      return requirePools();
    },
    get databaseUrls() {
      if (!databaseUrls) throw new Error("Representative Catalog test database URLs are not initialized.");
      return databaseUrls;
    },
    async addUnrelatedCatalogEvent() {
      const activePools = requirePools();
      await bootstrapContextDatabase(catalogModule, activePools.catalog);
      await activePools.catalog.query(
        `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
         VALUES ('catalog.unrelated-representative-seed-control', 1, NOW());
         INSERT INTO event_store_events (
           event_id,
           stream_id,
           stream_version,
           tenant_id,
           stream_context_name,
           stream_category,
           event_type,
           payload,
           metadata,
           occurred_at,
           recorded_at,
           performed_by_user_id,
           for_account_id
         )
         VALUES (
           'evt_representative_seed_unrelated',
           'catalog.unrelated-representative-seed-control',
           1,
           'tnt_system',
           'catalog',
           'unrelated-representative-seed-control',
           'catalog.unrelated-representative-seed-control-created',
           '{}'::jsonb,
           '{}'::jsonb,
           NOW(),
           NOW(),
           'usr_system',
           'acc_system'
         )`,
      );
    },
    async bootstrap() {
      return seedWithOptions({ enabledDataProfiles: ["catalog-integration-bootstrap"], environmentName: "test" });
    },
    async seed() {
      return seedWithOptions({
        enabledDataProfiles: ["representative-catalog"],
        environmentName: "test",
      });
    },
    async seedDefault() {
      return seedWithOptions(undefined);
    },
  };
}

async function startCatalogAssetServer() {
  const server = createServer((request, response) => {
    const marker = "/catalog-assets/";
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith(marker)) {
      response.writeHead(404).end();
      return;
    }
    const body = storedAssets.get(decodeURIComponent(pathname.slice(marker.length)));
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": String(body.byteLength),
    });
    response.end(Buffer.from(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Catalog asset test server did not bind to a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/catalog-assets`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      ),
  };
}

async function writeSyntheticPack(options: {
  accepted: boolean;
  profileVersion?: string;
  assetBytes?: Uint8Array;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "representative-catalog-"));
  temporaryRoots.push(root);
  const bundle = syntheticPack(options.profileVersion ?? "2026.06.19", options.assetBytes);
  const manifest = options.accepted
    ? recordObservationPackAcceptance(bundle.manifest, {
        acceptedBy: "Todd",
        acceptedAt: "2026-07-22T18:30:00-05:00",
        decisionLink: OBSERVATION_PACK_DECISION_LINK,
      })
    : bundle.manifest;

  for (const file of bundle.files) {
    const target = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.path === "manifest.json" ? serializeObservationPackManifest(manifest) : file.body);
  }
  return root;
}

async function writeSyntheticScrydexPack(conflictingCoordinate = false): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "representative-catalog-synthetic-scrydex-"));
  temporaryRoots.push(root);
  const imageUrl = "https://images.example.invalid/synthetic/one-piece-card.png";
  const payload = {
    ...scrydexCardFixture,
    card: { ...scrydexCardFixture.card, imageUrls: [imageUrl] },
  };
  const envelope = {
    unitKey: "scrydex:one-piece:single-card:source-observation-import",
    providerKey: "scrydex",
    externalKey: "card:op01-001",
    payload,
    provenance: { sourceUrl: payload.sourceUrl, sourceUpdatedAt: "2022-12-02", fetchedAt: "2026-06-23T00:00:00.000Z" },
  };
  const bundle = buildObservationPack({
    packId: "synthetic-scrydex-one-piece-romance-dawn-en",
    packVersion: "v1-synthetic",
    capturedAt: "2026-07-22T18:00:00-05:00",
    identity: {
      productLineKey: "one-piece-card-game",
      productLineDisplayName: "One Piece Card Game",
      setKind: "set",
      setExternalId: "OP01",
      setDisplayName: "Romance Dawn",
      providerKey: "scrydex",
      integrationProfileKey: "one-piece-card-print-source-observation",
      integrationProfileVersion: "2026.06.22",
      ingestionUnit: envelope.unitKey,
      language: "en",
      scopeKey: "expansion",
      scopeCoordinates: {
        languageCode: "en",
        expansionId: "OP01",
        ...(conflictingCoordinate ? { setId: "OP02" } : {}),
      },
    },
    envelopes: [envelope],
    assets: [
      {
        bytes: sourceImage,
        mediaType: "image/png",
        sourceReference: imageUrl,
        envelopeContentHashes: [observationPackEnvelopeContentHash(envelope)],
      },
    ],
  });
  const manifest = recordObservationPackAcceptance(bundle.manifest, {
    acceptedBy: "Todd",
    acceptedAt: "2026-07-22T18:30:00-05:00",
    decisionLink: OBSERVATION_PACK_DECISION_LINK,
  });
  for (const file of bundle.files) {
    const target = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.path === "manifest.json" ? serializeObservationPackManifest(manifest) : file.body);
  }
  return root;
}

async function writeSyntheticLorcanaPack(
  inkColors: readonly (string | null)[] = ["Amethyst", "Amber"],
  setCode = "the-first-chapter",
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "representative-catalog-synthetic-lorcana-"));
  temporaryRoots.push(root);
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "../../../bounded-contexts/catalog/features/source-observations/api/__fixtures__/lorcanajson-card-reference/normal.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  // Default to seeded-state ink coverage; the separately named #8475 control uses pack-provisioned key "1".
  const envelopes = inkColors.map((inkColor, index) => {
    const cardId = `synthetic-ink-${index}`;
    const imageUrl = `https://images.example.invalid/synthetic/lorcana-${index}.png`;
    const payload = {
      ...fixture,
      observationId: `lorcanajson_card_en_${cardId}`,
      externalKey: `card:${cardId}`,
      cardId,
      name: `Synthetic Lorcana ${index}`,
      cardNumber: String(index + 1),
      setId: setCode,
      setCode,
      inkColor,
      imageUrls: [imageUrl],
      externalCatalogItemReferences: [],
      tcgplayerProductId: null,
      sourcePayload: {
        ...fixture.sourcePayload,
        set: { ...fixture.sourcePayload.set, setId: setCode, setCode },
        card: {
          ...fixture.sourcePayload.card,
          id: cardId,
          name: `Synthetic Lorcana ${index}`,
          cardNumber: String(index + 1),
          inkColor,
          imageUrls: [imageUrl],
          tcgplayerProductId: null,
        },
      },
      catalogHashMaterial: {
        ...fixture.catalogHashMaterial,
        setId: setCode,
        setCode,
        cardId,
        cardNumber: String(index + 1),
        name: `Synthetic Lorcana ${index}`,
        inkColor,
        tcgplayerProductId: null,
      },
      mergeIdentity: {
        ...fixture.mergeIdentity,
        printedProductName: `Synthetic Lorcana ${index}`,
        collectorNumber: String(index + 1),
      },
    };
    return {
      unitKey: "lorcanajson:lorcana:single-card:reference-data",
      providerKey: "lorcanajson",
      externalKey: payload.externalKey,
      payload,
      provenance: {
        sourceUrl: payload.sourceUrl,
        sourceUpdatedAt: payload.sourceUpdatedAt,
        fetchedAt: "2026-06-23T00:00:00.000Z",
      },
    };
  });
  const bundle = buildObservationPack({
    packId: "synthetic-lorcanajson-lorcana-ink-en",
    packVersion: "v1-synthetic",
    capturedAt: "2026-07-22T18:00:00-05:00",
    identity: {
      productLineKey: "disney-lorcana",
      productLineDisplayName: "Disney Lorcana",
      setKind: "set",
      setExternalId: setCode,
      setDisplayName: "The First Chapter",
      providerKey: "lorcanajson",
      integrationProfileKey: "lorcana-card-reference-data",
      integrationProfileVersion: "2026.06.23",
      ingestionUnit: envelopes[0]!.unitKey,
      language: "en",
      scopeKey: "set",
      scopeCoordinates: { languageCode: "en", setCode },
    },
    envelopes,
    assets: envelopes.map((envelope) => ({
      bytes: sourceImage,
      mediaType: "image/png",
      sourceReference: envelope.payload.imageUrls[0]!,
      envelopeContentHashes: [observationPackEnvelopeContentHash(envelope)],
    })),
  });
  const manifest = recordObservationPackAcceptance(bundle.manifest, {
    acceptedBy: "Todd",
    acceptedAt: "2026-07-22T18:30:00-05:00",
    decisionLink: OBSERVATION_PACK_DECISION_LINK,
  });
  for (const file of bundle.files) {
    const target = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.path === "manifest.json" ? serializeObservationPackManifest(manifest) : file.body);
  }
  return root;
}

function syntheticPack(profileVersion: string, assetBytes: Uint8Array = sourceImage): ObservationPackBundle {
  const envelope = {
    unitKey: "scryfall:mtg:single-card:reference-data",
    providerKey: "scryfall",
    externalKey: "card:0000579f-7b35-4ed3-b44c-db2a538066fe",
    payload: {
      kind: "single-card",
      card: {
        object: "card",
        id: "0000579f-7b35-4ed3-b44c-db2a538066fe",
        oracle_id: "44623693-51d6-49ad-8cd7-140505caf02f",
        name: "Fury Sliver",
        lang: "en",
        released_at: "2006-10-06",
        uri: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
        scryfall_uri: "https://scryfall.com/card/tsp/157/fury-sliver",
        set: "tsp",
        set_id: "c1d109bc-ffd8-428f-8d7d-3f8d7e648046",
        set_name: "Time Spiral",
        collector_number: "157",
        rarity: "uncommon",
        artist: "Pete Venters",
        image_uris: {
          normal: sourceImageUrls[0],
          png: sourceImageUrls[1],
        },
        tcgplayer_id: 14240,
      },
    },
    provenance: {
      sourceUrl: "https://api.scryfall.com/cards/0000579f-7b35-4ed3-b44c-db2a538066fe",
      sourceUpdatedAt: "2026-06-19T00:00:00.000Z",
      fetchedAt: "2026-06-19T00:00:00.000Z",
    },
  } as const;
  const envelopeHash = observationPackEnvelopeContentHash(envelope);
  return buildObservationPack({
    packId: "scryfall-mtg-time-spiral-en",
    packVersion: "v1-synthetic",
    capturedAt: "2026-07-22T18:00:00-05:00",
    identity: {
      productLineKey: "magic-the-gathering",
      productLineDisplayName: "Magic: The Gathering",
      setKind: "set",
      setExternalId: "tsp",
      setDisplayName: "Time Spiral",
      providerKey: "scryfall",
      integrationProfileKey: "mtg-card-print-reference-data",
      integrationProfileVersion: profileVersion,
      ingestionUnit: "scryfall:mtg:single-card:reference-data",
      language: "en",
      scopeKey: "set",
      scopeCoordinates: { languageCode: "en", setCode: "tsp" },
    },
    envelopes: [envelope],
    assets: sourceImageUrls.map((sourceReference) => ({
      bytes: assetBytes,
      mediaType: "image/png",
      sourceReference,
      envelopeContentHashes: [envelopeHash],
    })),
  });
}

async function expectNoPackState(pool: {
  query: <TRow = unknown>(sql: string, params?: readonly unknown[]) => Promise<{ rows: TRow[] }>;
}) {
  const [observations, items] = await Promise.all([
    pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM catalog_source_observations WHERE provider_key = 'scryfall'",
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM catalog_external_catalog_item_references
       WHERE provider_key IN ('scryfall', 'tcgplayer')`,
    ),
  ]);
  expect(Number(observations.rows[0]?.count ?? 0)).toBe(0);
  expect(Number(items.rows[0]?.count ?? 0)).toBe(0);
  expect(storedAssets.size).toBe(0);
}

async function countRows(
  pool: { query: <TRow = unknown>(sql: string) => Promise<{ rows: TRow[] }> },
  tableName: "event_store_events",
) {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function replayEvidence(
  pool: {
    query: <TRow = unknown>(sql: string, params?: readonly unknown[]) => Promise<{ rows: TRow[] }>;
  },
  itemIds: readonly string[],
) {
  const result = await pool.query<{
    catalog_item_id: string;
    status: string;
    external_references: unknown;
    product_asset_sets: unknown;
  }>(
    `SELECT
       item.catalog_item_id,
       item.status,
       item.product_asset_sets,
       COALESCE(
         (
           SELECT jsonb_agg(
             jsonb_build_object(
               'providerKey', reference.provider_key,
               'externalKey', reference.external_key
             )
             ORDER BY reference.provider_key, reference.external_key
           )
           FROM catalog_external_catalog_item_references AS reference
           WHERE reference.catalog_item_id = item.catalog_item_id
         ),
         '[]'::jsonb
       ) AS external_references
     FROM catalog_items AS item
     WHERE item.catalog_item_id = ANY($1::text[])
     ORDER BY item.catalog_item_id`,
    [itemIds],
  );
  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    status: row.status,
    externalReferences: Array.isArray(row.external_references) ? row.external_references : [],
    productAssetSets: Array.isArray(row.product_asset_sets) ? row.product_asset_sets : [],
  }));
}

async function expectPoisonedHistoriesToFail(input: {
  pool: PgTransactionalPool;
  services: ReturnType<typeof catalogModule.createServices>;
  packDir: string;
  eventCount: number;
}) {
  const streamId = "catalog.source-observation-scryfall_card_en_0000579f-7b35-4ed3-b44c-db2a538066fe";
  const events = await input.pool.query<{
    event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT event_id, event_type, payload
     FROM event_store_events
     WHERE stream_id = $1
     ORDER BY stream_version`,
    [streamId],
  );
  const recorded = events.rows.find((event) => event.event_type === "catalog.source-observation.recorded");
  const promoted = events.rows.find((event) => event.event_type === "catalog.source-observation.promoted");
  expect(recorded).toBeDefined();
  expect(promoted).toBeDefined();

  const cases = [
    {
      label: "partial",
      eventId: promoted!.event_id,
      eventType: "catalog.source-observation.source-payload-chunk-recorded",
      payload: {},
    },
    {
      label: "promoted-only",
      eventId: recorded!.event_id,
      eventType: "catalog.source-observation.promoted",
      payload: promoted!.payload,
    },
    {
      label: "unexpected",
      eventId: promoted!.event_id,
      eventType: "catalog.source-observation.rejected",
      payload: {},
    },
    {
      label: "mismatched",
      eventId: recorded!.event_id,
      eventType: recorded!.event_type,
      payload: { ...recorded!.payload, externalKey: "card:poisoned-history" },
    },
    {
      label: "mismatched-target",
      eventId: promoted!.event_id,
      eventType: promoted!.event_type,
      payload: { ...promoted!.payload, catalogItemId: "cat_poisoned_history_target" },
    },
    {
      label: "mismatched-promotion-fingerprint",
      eventId: promoted!.event_id,
      eventType: promoted!.event_type,
      payload: { ...promoted!.payload, promotionPlanFingerprint: "f".repeat(64) },
    },
    {
      label: "mismatched-promotion-profile",
      eventId: promoted!.event_id,
      eventType: promoted!.event_type,
      payload: { ...promoted!.payload, promotionProfileVersion: "synthetic-poisoned-profile" },
    },
    {
      label: "mismatched-source-facts",
      eventId: recorded!.event_id,
      eventType: recorded!.event_type,
      payload: { ...recorded!.payload, normalized: { kind: "synthetic-poisoned-facts" } },
    },
    {
      label: "unexpected-event",
      eventId: promoted!.event_id,
      eventType: "catalog.synthetic-unexpected",
      payload: {},
    },
    {
      label: "repeated",
      eventId: promoted!.event_id,
      eventType: "catalog.source-observation.recorded",
      payload: recorded!.payload,
    },
  ] as const;

  for (const poison of cases) {
    const assets = storedAssets.size;
    const original = poison.eventId === recorded!.event_id ? recorded! : promoted!;
    await input.pool.query("UPDATE event_store_events SET event_type = $2, payload = $3::jsonb WHERE event_id = $1", [
      poison.eventId,
      poison.eventType,
      JSON.stringify(poison.payload),
    ]);
    try {
      await expect(
        replayRepresentativeCatalogPacks({
          services: input.services,
          source: input.packDir,
          context: {
            tenantId: "tnt_system" as never,
            audit: {
              performedByUserId: "usr_system" as never,
              forAccountId: "acc_system" as never,
            },
          },
        }),
        poison.label,
      ).rejects.toThrow("representative-catalog-history-invalid");
      expect(await countRows(input.pool, "event_store_events")).toBe(input.eventCount);
      expect(storedAssets.size).toBe(assets);
    } finally {
      await input.pool.query("UPDATE event_store_events SET event_type = $2, payload = $3::jsonb WHERE event_id = $1", [
        original.event_id,
        original.event_type,
        JSON.stringify(original.payload),
      ]);
    }
  }
}
