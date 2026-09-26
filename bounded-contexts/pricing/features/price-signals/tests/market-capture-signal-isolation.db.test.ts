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
import {
  decodeProviderObservationPolicyValue,
  PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
} from "../domain/provider-observation-policy";
import { createObjectStorageTcgplayerMarketCaptureReceiptSink } from "../integrations/tcgplayer/capture-sanitizer";
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
    await priceSignals.recordTcgplayerPriceSignal({
      skuId: 9001,
      observedAt: "2026-09-01T15:00:01.000Z",
      pricePoint: {
        skuId: 9001,
        marketPrice: 10,
        lowestPrice: 9,
        highestPrice: 11,
        priceCount: 3,
        calculatedAt: "2026-09-01T15:00:00.000Z",
      },
    });
    const priceOnly = (await pool.query("SELECT * FROM pricing_tcgplayer_price_signals")).rows;
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
      resolveStatHygienePolicy: async () => {
        throw new Error("must-not-run");
      },
      recordTcgplayerPriceSignal: async (input) => {
        events.push("signal-write-start");
        const result = await priceSignals.recordTcgplayerPriceSignal(input);
        events.push("signal-write-committed");
        return result;
      },
    });
    await expect(run()).resolves.toMatchObject({
      status: "configuration-invalid",
      signalsRecorded: 1,
      capturesCommitted: 1,
    });
    expect(events.indexOf("signal-write-committed")).toBeLessThan(events.indexOf("capture-policy"));
    expect(events).not.toContain("sales");
    const state = await persistedState(pool);
    expect((await pool.query("SELECT * FROM pricing_tcgplayer_price_signals")).rows).toEqual(priceOnly);
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

  it.each([
    "observation-null",
    "observation-throws",
    "observation-decoder-invalid",
    "stat-null",
    "stat-throws",
    "malformed-secondary",
    "secondary-throws",
    "slow-secondary",
  ] as const)("keeps three essential signals byte-identical to price-only for %s", async (scenario) => {
    await seedMoreMappings(pool);
    const baselineRuntime = createPriceSignalRuntime({ db: pool });
    for (const [index, skuId] of [9001, 9002, 9003].entries()) {
      await baselineRuntime.recordTcgplayerPriceSignal({
        skuId,
        observedAt: new Date(Date.parse("2026-09-01T15:00:01.000Z") + index * 1000).toISOString(),
        pricePoint: pricePoint(skuId),
      });
    }
    const rows = () => pool.query("SELECT * FROM pricing_tcgplayer_price_signals ORDER BY external_key");
    const baseline = (await rows()).rows;
    expect(baseline).toHaveLength(3);
    await pool.query("TRUNCATE pricing_tcgplayer_price_signals");
    const events: string[] = [];
    let releaseSecondary: (() => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      releaseSecondary = resolve;
    });
    let secondaryEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      secondaryEntered = resolve;
    });
    const runtime = createPriceSignalRuntime({ db: pool });
    const run = createTcgplayerMarketCapture({
      pool,
      transport: {
        ...transport(events, { malformedSecondary: scenario === "malformed-secondary", allProducts: true }),
        mpApi: {
          post: async <T>() => {
            events.push("sales");
            secondaryEntered?.();
            if (scenario === "slow-secondary") await delayed;
            if (scenario === "secondary-throws") throw new Error("C12_SYNTHETIC_TRANSPORT_SECRET");
            if (scenario === "malformed-secondary") return { data: "not-an-array" } as T;
            return { previousPage: "", nextPage: "", resultCount: 0, totalResults: 0, data: [] } as T;
          },
        },
      },
      receiptSink: { kind: "not-mounted" },
      now: clock(),
      resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 3 } }),
      resolveObservationPolicy: async () => {
        events.push("capture-policy");
        if (scenario === "observation-throws") throw new Error("C12_POLICY_SECRET");
        if (scenario === "observation-decoder-invalid") decodeProviderObservationPolicyValue(null);
        return scenario === "observation-null"
          ? null
          : {
              revisionId: "synthetic-observation-r1",
              value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 3 },
            };
      },
      resolveStatHygienePolicy: async () => {
        events.push("stat-policy");
        if (scenario === "stat-throws") throw new Error("C12_STAT_SECRET");
        return scenario === "stat-null" ? null : { revisionId: "synthetic-stat-r1" };
      },
      recordTcgplayerPriceSignal: async (input) => {
        const result = await runtime.recordTcgplayerPriceSignal(input);
        events.push(`signal-committed:${input.skuId}`);
        return result;
      },
    });
    const pending = run();
    if (scenario === "slow-secondary") {
      await entered;
      expect(events.filter((event) => event.startsWith("signal-committed:"))).toEqual([
        "signal-committed:9001",
        "signal-committed:9002",
        "signal-committed:9003",
      ]);
      expect((await rows()).rows).toEqual(baseline);
      releaseSecondary?.();
    }
    await expect(pending).resolves.toMatchObject({ signalsRecorded: 3, capturesCommitted: 3 });
    expect((await rows()).rows).toEqual(baseline);
    const lastSignal = events.indexOf("signal-committed:9003");
    expect(lastSignal).toBeGreaterThan(events.indexOf("signal-committed:9002"));
    expect(events.indexOf("capture-policy")).toBeGreaterThan(lastSignal);
    if (events.includes("sales")) expect(events.indexOf("sales")).toBeGreaterThan(lastSignal);
    const headers = await pool.query<{ outcome_kind: string }>(
      "SELECT outcome_kind FROM pricing_external_market_captures ORDER BY external_key",
    );
    expect(headers.rows).toHaveLength(3);
    expect(
      headers.rows.every(
        (row) =>
          row.outcome_kind ===
          (scenario.startsWith("observation-") || scenario.startsWith("stat-")
            ? "configuration-invalid"
            : scenario === "secondary-throws" || scenario === "malformed-secondary"
              ? "provider-unavailable"
              : "recorded"),
      ),
    ).toBe(true);
  });

  it.each(["observation", "stat"] as const)(
    "persists three safe %s-invalid headers with exact available authority",
    async (missing) => {
      await seedMoreMappings(pool);
      const events: string[] = [];
      const runtime = createPriceSignalRuntime({ db: pool });
      await expect(
        createTcgplayerMarketCapture({
          pool,
          transport: transport(events, { allProducts: true }),
          receiptSink: { kind: "not-mounted" },
          now: clock(),
          resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 3 } }),
          resolveObservationPolicy: async () =>
            missing === "observation"
              ? null
              : {
                  revisionId: "synthetic-observation-r1",
                  value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass: 3 },
                },
          resolveStatHygienePolicy: async () => (missing === "stat" ? null : { revisionId: "synthetic-stat-r1" }),
          recordTcgplayerPriceSignal: runtime.recordTcgplayerPriceSignal,
        })(),
      ).resolves.toMatchObject({ status: "configuration-invalid", signalsRecorded: 3, capturesCommitted: 3 });
      expect(events).not.toContain("sales");
      const headers = await pool.query<Record<string, unknown>>(`SELECT external_key, outcome_kind, reason_code,
      signal_policy_revision_id, products_per_pass, observation_policy_revision_id, stat_hygiene_policy_revision_id,
      captures_per_pass, currency, sales_status, listings_status, history_status
      FROM pricing_external_market_captures ORDER BY external_key`);
      expect(headers.rows).toEqual(
        [7001, 7002, 7003].map((product) => ({
          external_key: `product:${product}`,
          outcome_kind: "configuration-invalid",
          reason_code: `${missing}-policy-invalid`.replace("stat-policy", "stat-hygiene-policy"),
          signal_policy_revision_id: "synthetic-signal-r1",
          products_per_pass: 3,
          observation_policy_revision_id: missing === "observation" ? null : "synthetic-observation-r1",
          stat_hygiene_policy_revision_id: null,
          captures_per_pass: missing === "observation" ? null : 3,
          currency: missing === "observation" ? null : "usd",
          sales_status: null,
          listings_status: null,
          history_status: null,
        })),
      );
      const cursor = await pool.query<{ after_external_key: string; generation: string }>(
        "SELECT after_external_key, generation::text FROM pricing_external_market_capture_cursors",
      );
      expect(cursor.rows).toEqual([{ after_external_key: "", generation: "3" }]);
      for (const table of [
        "pricing_external_sale_observations",
        "pricing_external_weekly_sale_buckets",
        "pricing_external_listing_snapshots",
        "pricing_external_listing_ask_depth",
      ]) {
        expect((await pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      }
    },
  );

  it.each(["23514", "57014"] as const)(
    "rolls back the second capture on synthetic SQLSTATE %s and retries its suffix",
    async (code) => {
      await seedMoreMappings(pool);
      const baselineRuntime = createPriceSignalRuntime({ db: pool });
      for (const [index, skuId] of [9001, 9002, 9003].entries()) {
        await baselineRuntime.recordTcgplayerPriceSignal({
          skuId,
          observedAt: new Date(Date.parse("2026-09-01T15:00:01.000Z") + index * 1000).toISOString(),
          pricePoint: pricePoint(skuId),
        });
      }
      const signalRows = () => pool.query("SELECT * FROM pricing_tcgplayer_price_signals ORDER BY external_key");
      const baseline = (await signalRows()).rows;
      await pool.query("TRUNCATE pricing_tcgplayer_price_signals");
      const events: string[] = [];
      const artifacts: string[] = [];
      const sink = createObjectStorageTcgplayerMarketCaptureReceiptSink({
        putObject: async (input) => {
          expect(input.visibility).toBe("private");
          artifacts.push(new TextDecoder().decode(input.body));
        },
      });
      const fault = new HeaderFailingPool(pool, "product:7002", code);
      const run = (db: PgTransactionalPool, now: () => string, capturesPerPass = 3) =>
        createTcgplayerMarketCapture({
          pool: db,
          transport: transport(events, { allProducts: true, validSecondary: true }),
          receiptSink: sink,
          now,
          resolveSignalPolicy: async () => ({ revisionId: "synthetic-signal-r1", value: { productsPerPass: 3 } }),
          resolveObservationPolicy: async () => ({
            revisionId: "synthetic-observation-r1",
            value: { ...PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE, capturesPerPass },
          }),
          resolveStatHygienePolicy: async () => ({ revisionId: "synthetic-stat-r1" }),
          recordTcgplayerPriceSignal: createPriceSignalRuntime({ db }).recordTcgplayerPriceSignal,
        })();
      await expect(run(fault, clock(), code === "57014" ? 2 : 3)).resolves.toMatchObject({
        status: "retryable-abort",
        reason: "capture-write-failed",
        signalsRecorded: 3,
        capturesCommitted: 1,
      });
      expect(fault.trace.slice(-3)).toEqual(["BEGIN", `FAULT:${code}`, "ROLLBACK"]);
      const state = await persistedState(pool);
      expect(state.signals).toHaveLength(3);
      expect((await signalRows()).rows).toEqual(baseline);
      expect(state.headers).toEqual([{ outcome_kind: "recorded" }]);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).not.toMatch(/C12_SYNTHETIC_LISTING_SECRET|C12_SYNTHETIC_CHECK_FAILURE/);
      for (const table of [
        "pricing_external_sale_observations",
        "pricing_external_weekly_sale_buckets",
        "pricing_external_listing_snapshots",
        "pricing_external_listing_ask_depth",
      ]) {
        expect((await pool.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
      }
      expect(state.cursor).toEqual([{ generation: "1" }]);
      const cursor = await pool.query<{ after_external_key: string }>(
        "SELECT after_external_key FROM pricing_external_market_capture_cursors",
      );
      expect(cursor.rows).toEqual([{ after_external_key: "product:7001" }]);
      const prefix = (
        await pool.query<{ capture_id: string }>(
          "SELECT * FROM pricing_external_market_captures WHERE external_key = 'product:7001'",
        )
      ).rows[0]!;
      events.length = 0;
      await expect(run(pool, laterClock())).resolves.toMatchObject({ status: "completed", capturesCommitted: 3 });
      expect(events[0]).toBe("price-points:9002,9003,9001");
      const recovered = await pool.query<{ external_key: string }>(
        "SELECT external_key FROM pricing_external_market_captures ORDER BY capture_started_at",
      );
      expect(recovered.rows.map((row) => row.external_key)).toEqual([
        "product:7001",
        "product:7002",
        "product:7003",
        "product:7001",
      ]);
      expect(artifacts).toHaveLength(4);
      const durable = JSON.stringify({
        artifacts,
        headers: (await pool.query("SELECT row_to_json(t) FROM pricing_external_market_captures t")).rows,
        sales: (await pool.query("SELECT row_to_json(t) FROM pricing_external_sale_observations t")).rows,
      });
      expect(durable).not.toMatch(/C12_SYNTHETIC_LISTING_SECRET|C12_SYNTHETIC_CHECK_FAILURE/);
      expect(
        (await pool.query("SELECT * FROM pricing_external_market_captures WHERE capture_id = $1", [prefix.capture_id]))
          .rows,
      ).toEqual([prefix]);
      expect(
        (
          await pool.query<{ generation: string }>(
            "SELECT generation::text FROM pricing_external_market_capture_cursors",
          )
        ).rows,
      ).toEqual([{ generation: "4" }]);
    },
  );
});

class HeaderFailingPool implements PgTransactionalPool {
  readonly trace: string[] = [];
  constructor(
    private readonly delegate: PgTransactionalPool,
    private readonly product?: string,
    private readonly code?: string,
  ) {}

  query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
    return this.delegate.query<Row>(sql, params);
  }

  async connect(): Promise<PgPoolClient> {
    const client = await this.delegate.connect();
    return {
      ...client,
      query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        if (sql.trim() === "BEGIN" || sql.trim() === "ROLLBACK" || sql.trim() === "COMMIT") this.trace.push(sql.trim());
        if (
          sql.includes("INSERT INTO pricing_external_market_captures") &&
          (!this.product || params?.[3] === this.product)
        ) {
          this.trace.push(`FAULT:${this.code ?? "synthetic"}`);
          throw Object.assign(new Error("C12_SYNTHETIC_CHECK_FAILURE"), {
            code: this.code ?? "23514",
            constraint: "synthetic_provider_observation_check",
          });
        }
        return client.query<Row>(sql, params);
      },
      release: () => client.release(),
    };
  }
}

function transport(
  events: string[],
  options: Readonly<{ malformedSecondary?: boolean; allProducts?: boolean; validSecondary?: boolean }> = {},
): TcgplayerMarketTransport {
  return {
    mpGateway: {
      post: async <T>(_path: string, body?: unknown) => {
        const { skuIds } = body as { skuIds: number[] };
        events.push(`price-points:${skuIds.join(",")}`);
        return (options.allProducts ? [9001, 9002, 9003] : [9001]).map(pricePoint) as T;
      },
    },
    mpApi: {
      post: async <T>() => {
        events.push("sales");
        if (options.malformedSecondary) return { data: "not-an-array" } as T;
        if (options.validSecondary)
          return {
            previousPage: "",
            nextPage: "",
            resultCount: 1,
            totalResults: 1,
            data: [
              {
                condition: "Near Mint",
                variant: "Normal",
                language: "English",
                quantity: 1,
                title: "synthetic",
                listingType: "All",
                customListingId: "C12_SYNTHETIC_LISTING_SECRET",
                purchasePrice: 5,
                shippingPrice: 0,
                orderDate: "2026-08-31T12:00:00.000Z",
              },
            ],
          } as T;
        throw new Error("secondary-call-must-not-run");
      },
    },
    mpSearchApi: {
      post: async <T>() => {
        events.push("listings");
        if (options.malformedSecondary) return { results: [] } as T;
        if (options.validSecondary)
          return {
            errors: [],
            results: [
              {
                totalResults: 1,
                resultId: "synthetic",
                aggregations: {},
                results: [
                  {
                    directProduct: false,
                    goldSeller: false,
                    listingId: 1,
                    channelId: 0,
                    conditionId: 1,
                    verifiedSeller: true,
                    directInventory: 0,
                    rankedShippingPrice: 0,
                    productId: 7001,
                    printing: "Normal",
                    languageAbbreviation: "EN",
                    sellerName: "synthetic",
                    forwardFreight: false,
                    sellerShippingPrice: 0,
                    language: "English",
                    shippingPrice: 0,
                    condition: "Near Mint",
                    languageId: 1,
                    score: 0,
                    directSeller: false,
                    productConditionId: 1,
                    sellerId: "synthetic-seller",
                    listingType: "standard",
                    sellerRating: 100,
                    sellerSales: "1",
                    quantity: 1,
                    sellerKey: "synthetic-seller",
                    price: 5,
                    customData: { images: [] },
                  },
                ],
              },
            ],
          } as T;
        throw new Error("secondary-call-must-not-run");
      },
    },
    infiniteApi: {
      get: async <T>(path: string) => {
        events.push("history");
        if (options.malformedSecondary) return { result: "not-an-array" } as T;
        if (options.validSecondary)
          return {
            count: 1,
            result: [
              {
                skuId: path.includes("/7002/") ? "9002" : path.includes("/7003/") ? "9003" : "9001",
                variant: "Normal",
                language: "English",
                condition: "Near Mint",
                averageDailyQuantitySold: "1",
                averageDailyTransactionCount: "1",
                totalQuantitySold: "1",
                totalTransactionCount: "1",
                trendingMarketPricePercentages: {},
                buckets: [
                  {
                    marketPrice: "10.00",
                    quantitySold: "1",
                    lowSalePrice: "5.00",
                    lowSalePriceWithShipping: "5.00",
                    highSalePrice: "5.00",
                    highSalePriceWithShipping: "5.00",
                    transactionCount: "1",
                    bucketStartDate: "2026-08-25T00:00:00.000Z",
                  },
                ],
              },
            ],
          } as T;
        throw new Error("secondary-call-must-not-run");
      },
    },
  };
}

function pricePoint(skuId: number) {
  return {
    skuId,
    marketPrice: 10,
    lowestPrice: 9,
    highestPrice: 11,
    priceCount: 3,
    calculatedAt: "2026-09-01T15:00:00.000Z",
  };
}

async function seedMoreMappings(pool: PgTransactionalPool) {
  for (const index of [2, 3]) {
    await pool.query(
      `INSERT INTO pricing_external_catalog_item_reference_inputs
      (provider_key, external_key, catalog_item_id, updated_at) VALUES ($1,$2,$3,$4)`,
      ["tcgplayer", `product:${7000 + index}`, `cat_synthetic_${index}`, "2026-09-01T14:00:00.000Z"],
    );
    await pool.query(
      `INSERT INTO pricing_external_product_reference_inputs
      (provider_key, external_key, catalog_item_id, catalog_product_key, selected_options, updated_at)
      VALUES ($1,$2,$3,$4,'[]',$5)`,
      [
        "tcgplayer",
        `sku:${9000 + index}`,
        `cat_synthetic_${index}`,
        `cat_synthetic_${index}::`,
        "2026-09-01T14:00:00.000Z",
      ],
    );
  }
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
    pool.query<{ source_payload: Record<string, unknown> }>(
      "SELECT source_payload FROM pricing_tcgplayer_price_signals",
    ),
    pool.query<{ outcome_kind: string }>("SELECT outcome_kind FROM pricing_external_market_captures"),
    pool.query<{ generation: string }>("SELECT generation::text FROM pricing_external_market_capture_cursors"),
  ]);
  return { signals: signals.rows, headers: headers.rows, cursor: cursor.rows };
}

function clock() {
  let value = Date.parse("2026-09-01T14:59:59.000Z");
  return () => new Date((value += 1_000)).toISOString();
}

function laterClock() {
  let value = Date.parse("2026-09-02T14:59:59.000Z");
  return () => new Date((value += 1_000)).toISOString();
}
