import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as pricingModule } from "../../../index";
import { createTcgplayerMarketCapture } from "../api/market-capture";
import { createPriceSignalRuntime } from "../api/runtime";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import type { TcgplayerMarketTransport } from "../integrations/tcgplayer/transport-port";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("essential price-signal isolation from secondary capture", () => {
  let pool: PgTransactionalPool;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["pricing"], "pricing_signal_isolation");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).pricing;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ pricing: pool });
    await pool.query(pricingModule.schemaSql);
    await seedMappings(pool);
  });
  afterAll(async () => closeMultiContextTestPools({ pricing: pool }));

  it("commits the real price-only signal before invalid capture policy and advances only its terminal header", async () => {
    const events: string[] = [];
    const priceSignals = createPriceSignalRuntime({ db: pool });
    const run = createTcgplayerMarketCapture({
      pool,
      transport: transport(events),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
      resolveObservationPolicy: async () => {
        events.push("capture-policy");
        return null;
      },
      resolveStatHygienePolicy: async () => { throw new Error("must-not-run"); },
      recordTcgplayerPriceSignal: async (input) => {
        events.push("signal-write-start");
        const result = await priceSignals.recordTcgplayerPriceSignal(input);
        events.push("signal-write-committed");
        return result;
      },
    });
    await expect(run()).resolves.toMatchObject({ status: "configuration-invalid", signalsRecorded: 1, capturesCommitted: 1 });
    expect(events.indexOf("signal-write-committed")).toBeLessThan(events.indexOf("capture-policy"));
    expect(events).not.toContain("sales");
    const state = await persistedState(pool);
    expect(state.signals).toEqual([
      expect.objectContaining({
        source_payload: expect.objectContaining({ latestSales: null, listings: null, priceHistory: null }),
      }),
    ]);
    expect(state.headers).toEqual([{ outcome_kind: "configuration-invalid" }]);
    expect(state.cursor).toEqual([{ generation: "1" }]);
  });

  it("keeps the signal committed when every secondary envelope fails closed", async () => {
    const events: string[] = [];
    const priceSignals = createPriceSignalRuntime({ db: pool });
    const run = createTcgplayerMarketCapture({
      pool,
      transport: transport(events, { malformedSecondary: true }),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
      resolveObservationPolicy: async () => ({
        revisionId: "synthetic-observation-r1",
        value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 },
      }),
      resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
      recordTcgplayerPriceSignal: async (input) => {
        const result = await priceSignals.recordTcgplayerPriceSignal(input);
        events.push("signal-write-committed");
        return result;
      },
    });
    await expect(run()).resolves.toMatchObject({ status: "completed", signalsRecorded: 1, capturesCommitted: 1 });
    expect(events.indexOf("signal-write-committed")).toBeLessThan(events.indexOf("sales"));
    expect((await persistedState(pool)).headers).toEqual([{ outcome_kind: "provider-unavailable" }]);
  });

  it("rolls back a capture write failure without rolling back the already committed signal", async () => {
    const events: string[] = [];
    const failingPool = new HeaderFailingPool(pool);
    const priceSignals = createPriceSignalRuntime({ db: failingPool });
    const run = createTcgplayerMarketCapture({
      pool: failingPool,
      transport: transport(events, { malformedSecondary: true }),
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } }),
      resolveObservationPolicy: async () => ({
        revisionId: "synthetic-observation-r1",
        value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 1 },
      }),
      resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
      recordTcgplayerPriceSignal: priceSignals.recordTcgplayerPriceSignal,
    });
    await expect(run()).resolves.toMatchObject({ status: "retryable-abort", reason: "capture-write-failed" });
    const state = await persistedState(pool);
    expect(state.signals).toHaveLength(1);
    expect(state.headers).toEqual([]);
    expect(state.cursor).toEqual([]);
  });
});

class HeaderFailingPool implements PgTransactionalPool {
  constructor(private readonly delegate: PgTransactionalPool) {}

  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
    return this.delegate.query<Row>(sql, params);
  }

  async connect(): Promise<PgPoolClient> {
    const client = await this.delegate.connect();
    return {
      ...client,
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes("INSERT INTO pricing_external_market_captures")) throw new Error("synthetic-capture-write-failure");
        return client.query<Row>(sql, params);
      },
      release: () => client.release(),
    };
  }
}

function transport(events: string[], options: Readonly<{ malformedSecondary?: boolean }> = {}): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <T>() => {
        events.push("price-points");
        return [{ skuId: 9001, marketPrice: 10, lowestPrice: 9, highestPrice: 11, priceCount: 3, calculatedAt: "2026-09-01T15:00:00.000Z" }] as T;
      },
    },
    mpApi: {
      post: async <T>() => {
        events.push("sales");
        if (options.malformedSecondary) return { data: "not-an-array" } as T;
        throw new Error("secondary-call-must-not-run");
      },
    },
    mpSearchApi: {
      post: async <T>() => {
        events.push("listings");
        if (options.malformedSecondary) return { results: [] } as T;
        throw new Error("secondary-call-must-not-run");
      },
    },
    infiniteApi: {
      get: async <T>() => {
        events.push("history");
        if (options.malformedSecondary) return { result: "not-an-array" } as T;
        throw new Error("secondary-call-must-not-run");
      },
    },
  };
}

async function seedMappings(pool: PgTransactionalPool) {
  await pool.query(
    `INSERT INTO pricing_external_catalog_item_reference_inputs
       (provider_key, external_key, catalog_item_id, updated_at)
     VALUES ('tcgplayer','product:7001','cat_synthetic','2026-09-01T14:00:00.000Z')`,
  );
  await pool.query(
    `INSERT INTO pricing_external_product_reference_inputs
       (provider_key, external_key, catalog_item_id, catalog_product_key, selected_options, updated_at)
     VALUES ('tcgplayer','sku:9001','cat_synthetic','cat_synthetic::','[]','2026-09-01T14:00:00.000Z')`,
  );
}

async function persistedState(pool: PgTransactionalPool) {
  const [signals, headers, cursor] = await Promise.all([
    pool.query<{ source_payload: Record<string, unknown> }>("SELECT source_payload FROM pricing_tcgplayer_price_signals"),
    pool.query<{ outcome_kind: string }>("SELECT outcome_kind FROM pricing_external_market_captures"),
    pool.query<{ generation: string }>("SELECT generation::text FROM pricing_external_market_capture_cursors"),
  ]);
  return { signals: signals.rows, headers: headers.rows, cursor: cursor.rows };
}

function clock() {
  let value = Date.parse("2026-09-01T14:59:59.000Z");
  return () => new Date((value += 1_000)).toISOString();
}
