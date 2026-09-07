import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { providerCaptureId, type ProviderObservationCapture } from "../domain/provider-observation-mapper";
import { listProviderSaleEvidence } from "../read-model/provider-observation-queries";
import {
  commitProviderObservationCapture,
  type MarketCaptureWorkItem,
} from "../read-model/provider-observation-writes";
import { generateSyntheticProviderObservationFixture } from "./fixtures/provider-observations/generate-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("provider sale occurrence identity and immutable replay", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_sale_occurrence");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("reuses a byte-identical same-id replay without child append or cursor advance", async () => {
    const capture = compactCapture(2);
    await expect(commitProviderObservationCapture(pool, "tcgplayer", work("", 0, "product:700000001", 1), capture))
      .resolves.toBe("committed");
    const before = await durableState(pool);

    const reordered = {
      ...capture,
      sales: [...capture.sales].reverse(),
      weekly: [...capture.weekly].reverse(),
      snapshots: [...capture.snapshots].reverse(),
      askDepth: [...capture.askDepth].reverse(),
    };
    await expect(
      commitProviderObservationCapture(
        pool,
        "tcgplayer",
        work("product:700000001", 1, "", 2),
        reordered,
      ),
    ).resolves.toBe("replayed");
    expect(await durableState(pool)).toEqual(before);

    const appendedChildMutant = {
      ...capture,
      sales: [
        ...capture.sales,
        { ...capture.sales[0]!, saleFingerprint: "synthetic-header-conflict-bypass-mutant" },
      ],
    };
    await expect(
      commitProviderObservationCapture(
        pool,
        "tcgplayer",
        work("product:700000001", 1, "", 2),
        appendedChildMutant,
      ),
    ).resolves.toBe("replayed");
    expect(await durableState(pool)).toEqual(before);
  });

  it("rejects conflicting immutable header content and consolidates different captures by maximum", async () => {
    const first = compactCapture(2);
    await commitProviderObservationCapture(pool, "tcgplayer", work("", 0, "product:700000001", 1), first);

    await expect(
      commitProviderObservationCapture(
        pool,
        "tcgplayer",
        work("product:700000001", 1, "", 2),
        { ...first, header: { ...first.header, recordedSignalCount: 99 } },
      ),
    ).rejects.toThrow("capture-immutable-conflict");
    await expect(cursor(pool)).resolves.toEqual({ after_external_key: "product:700000001", generation: "1" });

    const secondStartedAt = "2026-09-02T15:00:00.000Z";
    const secondId = providerCaptureId(
      first.header.providerKey,
      first.header.catalogItemId,
      first.header.externalKey,
      secondStartedAt,
    );
    const second: ProviderObservationCapture = {
      ...first,
      header: {
        ...first.header,
        captureId: secondId,
        captureStartedAt: secondStartedAt,
        captureCompletedAt: "2026-09-02T15:00:01.000Z",
      },
      sales: first.sales.map((row) => ({ ...row, captureId: secondId, observedOccurrenceCount: 3 })),
    };
    await expect(
      commitProviderObservationCapture(
        pool,
        "tcgplayer",
        work("product:700000001", 1, "", 2),
        second,
      ),
    ).resolves.toBe("committed");

    const evidence = await listProviderSaleEvidence(pool, {
      providerKey: "tcgplayer",
      catalogItemId: first.header.catalogItemId,
      soldSince: "2026-01-01T00:00:00.000Z",
    });
    expect(evidence).toEqual([
      expect.objectContaining({
        maxObservedTupleMultiplicity: 3,
        countSemantics: "provider-returned-max-per-capture",
        captureIds: [first.header.captureId, secondId],
      }),
    ]);
  });
});

function compactCapture(observedOccurrenceCount: number): ProviderObservationCapture {
  const capture = generateSyntheticProviderObservationFixture().capture;
  return {
    ...capture,
    sales: [{ ...capture.sales[0]!, observedOccurrenceCount }],
    weekly: [],
    snapshots: [],
    askDepth: [],
  };
}

function work(
  afterExternalKey: string,
  generation: number,
  nextAfterExternalKey: string,
  nextGeneration: number,
): MarketCaptureWorkItem {
  return {
    productExternalKey: "product:700000001",
    productId: 700000001,
    catalogItemId: "cat_unmistakably_synthetic_provider_fixture",
    skus: [],
    expectedCursor: { afterExternalKey, generation },
    nextCursor: { afterExternalKey: nextAfterExternalKey, generation: nextGeneration },
  };
}

async function cursor(pool: PgTransactionalPool) {
  const result = await pool.query<{ after_external_key: string; generation: string }>(
    `SELECT after_external_key, generation::text FROM pricing_external_market_capture_cursors WHERE provider_key = 'tcgplayer'`,
  );
  return result.rows[0];
}

async function durableState(pool: PgTransactionalPool) {
  const result = await pool.query<{ state: unknown }>(
    `SELECT jsonb_build_object(
       'headers', (SELECT jsonb_agg(row_to_json(c) ORDER BY c.capture_id) FROM pricing_external_market_captures c),
       'sales', (SELECT jsonb_agg(row_to_json(s) ORDER BY s.sale_fingerprint) FROM pricing_external_sale_observations s),
       'cursor', (SELECT row_to_json(k) FROM pricing_external_market_capture_cursors k WHERE provider_key = 'tcgplayer')
     ) AS state`,
  );
  return result.rows[0]?.state;
}
