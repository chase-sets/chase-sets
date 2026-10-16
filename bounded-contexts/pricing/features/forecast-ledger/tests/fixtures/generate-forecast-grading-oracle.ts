import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

/**
 * Records the parity app's `buildCohort`, `gradeForecast`, buyer-choice, and
 * condition-rate forecasts over the committed inputs below; it never imports
 * a Chase Sets forecast. Run it from a read-only checkout of the pinned commit
 * with LF line endings, so each source hashes to its pinned git blob,
 * resolving the app's `~/` alias through its own tsconfig:
 *
 *   APP_ROOT=<checkout> pnpm exec tsx --tsconfig <checkout>/tsconfig.json generate-forecast-grading-oracle.ts [--check]
 *
 * `--check` regenerates in memory and fails unless the committed oracle is byte-identical. The oracle is
 * written in the repository's Prettier format, so formatting the fixtures never invalidates it.
 */

const sourceRepository = "todd-skelton/tcgplayer-automation-app";
const sourceCommit = "bdeffa0190be035084abccb464716aaaa2541a59";
/** The graded functions' import closure. */
const sourceBlobs = {
  "app/features/pricing/domain/forecastGrading.ts": "155e487f5d59e6980fa71bd86fb6ea7e222121d3",
  "app/features/pricing/algorithms/buyerChoiceSellTime.ts": "248d66d7fdb943066ddf9847cc08d5a10dc573a1",
  "app/features/pricing/algorithms/conditionSaleRate.ts": "e372e4d3a58f41e8ecebcb8cf62b47d813bb7860",
  "app/features/pricing/domain/pricingPolicy.ts": "36f40f8096ba9657118096b20e705c53fedfb7b8",
  "app/core/types/pricingPolicy.ts": "aa652940720ea8a923c3e7a9507e44ce0664bc2e",
  "app/features/pricing/domain/maximize.ts": "3e6b75f9b9a3dc67d135262bf3ae361ef81eaacd",
  "app/features/pricing/domain/horizonValueCurve.ts": "1d6ccccfa59b9a53876df4f41722bfe6355f7e87",
} as const;

const oracleFile = "app-recorded-forecast-grading-oracle.json";
const DAY_MS = 24 * 60 * 60 * 1000;

type Forecasts = Record<string, number>;
const entry = (sku: number, day: number, quantity: number, forecasts: Forecasts = { curve: 10, choice: 20 }) => ({
  sku,
  day,
  quantity,
  forecasts,
});

/**
 * The app's own forecastGrading test records (SKUs 1-8), extended with a
 * restock, a restock then a sale, both sides of the grace boundary, a SKU that
 * joins once back in stock, one that joins exactly one horizon before the
 * data ends, a drop on the horizon's last day, a SKU priced once, and a drop
 * against an entry priced before the SKU joined.
 */
const records = [
  entry(1, 0, 2),
  entry(1, 5, 1),
  entry(1, 30, 1),
  ...[0, 10, 20, 30].map((day) => entry(2, day, 1)),
  entry(3, 0, 1),
  entry(3, 3, 1),
  entry(4, 0, 1),
  entry(4, 3, 1),
  entry(5, 20, 1),
  entry(5, 30, 1),
  entry(6, 0, 1, { curve: 10 }),
  entry(6, 2, 1),
  entry(6, 30, 1),
  entry(7, 0, 3, { curve: 40, choice: 20 }),
  entry(7, 25, 2, { curve: 40, choice: 20 }),
  entry(7, 30, 2, { curve: 40, choice: 20 }),
  entry(8, 0, 1),
  entry(8, 20, 1),
  entry(9, 0, 1, { curve: 5, choice: 7 }),
  entry(9, 4, 3, { curve: 5, choice: 7 }),
  entry(9, 10, 3),
  entry(9, 30, 3),
  entry(10, 0, 1, { curve: 8, choice: 9 }),
  entry(10, 3, 2),
  entry(10, 8, 1),
  entry(10, 30, 1),
  entry(11, 0, 1, { curve: 12, choice: 6 }),
  entry(11, 19, 1),
  entry(12, 0, 1, { curve: 15, choice: 30 }),
  entry(12, 18.5, 1),
  entry(13, 0, 1, { curve: 3, choice: 4 }),
  entry(13, 18.5, 1),
  entry(14, 0, 0, { curve: 25, choice: 25 }),
  entry(14, 1, 1, { curve: 25, choice: 25 }),
  entry(14, 30, 1, { curve: 25, choice: 25 }),
  entry(15, 9, 1, { curve: 60, choice: 14 }),
  entry(15, 30, 1, { curve: 60, choice: 14 }),
  entry(16, 0, 2, { curve: 21, choice: 21 }),
  entry(16, 21, 1, { curve: 21, choice: 21 }),
  entry(16, 30, 1, { curve: 21, choice: 21 }),
  entry(17, 0, 1, { curve: 2, choice: 50 }),
  entry(18, 0, 3, { curve: 10 }),
  entry(18, 2, 2, { curve: 18, choice: 11 }),
  entry(18, 30, 2, { curve: 18, choice: 11 }),
];
const inStockSkus = [2, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18];
const horizonsDays = [14, 21, 28];
const forecastNames = ["curve", "choice"];

const buyerChoiceCases = [
  {
    curve: [
      { percentile: 10, buyerArrivalIntervalDays: null, competingSellerCount: 4 },
      { percentile: 25, buyerArrivalIntervalDays: 3.5, competingSellerCount: 9 },
      { percentile: 50, buyerArrivalIntervalDays: 6, competingSellerCount: 12 },
    ],
    prices: [0.25, 1, 4.99, 27.5],
  },
  {
    curve: [{ percentile: 50, buyerArrivalIntervalDays: 40, competingSellerCount: 0 }],
    prices: [120],
  },
  { curve: [{ percentile: 50, buyerArrivalIntervalDays: 2, competingSellerCount: null }], prices: [3] },
];

const asOf = "2026-08-12T15:00:00.000Z";
const weeks = (count: number, transactionCount: (index: number) => number) =>
  Array.from({ length: count }, (_, index) => ({
    weekStart: new Date(Date.parse("2026-08-10T00:00:00.000Z") - index * 7 * DAY_MS).toISOString().slice(0, 10),
    transactionCount: transactionCount(index),
  })).reverse();
const conditionRateCases = [
  { asOf, buckets: weeks(53, (index) => (index % 3 === 0 ? 2 : 1)), storeWinShares: [0.05, 0.4, 1] },
  { asOf, buckets: weeks(20, (index) => (index < 4 ? 3 : 0)), storeWinShares: [0.25] },
  { asOf, buckets: weeks(53, () => 0), storeWinShares: [0.5] },
];

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Fails closed unless every pinned source on disk is byte-for-byte its pinned blob. */
function verifyPinnedSources(appRoot: string): void {
  for (const [path, expected] of Object.entries(sourceBlobs)) {
    const actual = gitBlobSha(readFileSync(resolve(appRoot, path)));
    if (actual !== expected)
      throw new Error(`${path} hashes to blob ${actual}, not ${expected} at ${sourceCommit}; use an LF checkout.`);
  }
}

async function renderForecastGradingOracle(appRoot: string): Promise<string> {
  verifyPinnedSources(appRoot);
  const load = (path: string) => import(pathToFileURL(resolve(appRoot, path)).href);
  const grading = await load("app/features/pricing/domain/forecastGrading.ts");
  const buyerChoice = await load("app/features/pricing/algorithms/buyerChoiceSellTime.ts");
  const conditionRate = await load("app/features/pricing/algorithms/conditionSaleRate.ts");

  const appRecords = records.map(({ sku, day, quantity, forecasts }) => ({
    sku,
    pricedAt: day * DAY_MS,
    quantity,
    forecasts,
  }));
  const cohorts = horizonsDays.map((horizonDays) => {
    const cohort = grading.buildCohort(appRecords, forecastNames, new Set(inStockSkus), horizonDays);
    return {
      horizonDays,
      members: cohort.map((member: { sku: number; sold: boolean }) => ({ sku: member.sku, sold: member.sold })),
      grades: Object.fromEntries(forecastNames.map((name) => [name, grading.gradeForecast(cohort, name, horizonDays)])),
    };
  });

  const buyerChoiceForecasts = buyerChoiceCases.map(({ curve, prices }) => ({
    curve,
    forecasts: prices.map((price) => ({
      price,
      forecast:
        buyerChoice.forecastBuyerChoice(
          curve.map((point) => ({
            percentile: point.percentile,
            buyerIntervalDays: point.buyerArrivalIntervalDays ?? undefined,
            listingsCount: point.competingSellerCount ?? undefined,
          })),
          price,
        ) ?? null,
    })),
  }));

  const conditionRateForecasts = conditionRateCases.map(({ asOf: at, buckets, storeWinShares }) => {
    const rate = conditionRate.estimateConditionSaleRate(
      buckets.map((bucket) => ({ bucketStartDate: bucket.weekStart, transactionCount: bucket.transactionCount })),
      { asOfTimestamp: Date.parse(at) },
    );
    return {
      asOf: at,
      buckets,
      intervalDays: rate?.intervalDays ?? null,
      forecasts: storeWinShares.map((storeWinShare) => ({
        storeWinShare,
        medianSellDays: conditionRate.forecastConditionRate(rate, storeWinShare)?.medianSellDays ?? null,
      })),
    };
  });

  const oracle = {
    status: "app-recorded-synthetic-not-live",
    sourceRepository,
    sourceCommit,
    sourceBlobs,
    cohort: { records, inStockSkus, forecastNames, cohorts },
    buyerChoice: buyerChoiceForecasts,
    conditionRate: conditionRateForecasts,
  };
  const output = fileURLToPath(new URL(`./${oracleFile}`, import.meta.url));
  return format(JSON.stringify(oracle, null, 2), { ...(await resolveConfig(output)), parser: "json" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appRoot = process.env.APP_ROOT;
  if (!appRoot) throw new Error("APP_ROOT must point to the pinned read-only app checkout.");
  const output = new URL(`./${oracleFile}`, import.meta.url);
  const rendered = await renderForecastGradingOracle(appRoot);
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== rendered) throw new Error(`${oracleFile} differs from its regeneration.`);
  } else {
    writeFileSync(output, rendered);
  }
}
