import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Records the parity app's `selectPricingDecision` over the committed goal
 * parity curve; it never imports a Chase Sets goal solver. Run it from a
 * read-only checkout of the pinned commit with LF line endings, so each source
 * hashes to its pinned git blob (for example `git -c core.autocrlf=false
 * archive`), resolving the app's `~/` alias through its own tsconfig:
 *
 *   APP_ROOT=<checkout> pnpm exec tsx --tsconfig <checkout>/tsconfig.json generate-goal-oracle.ts [--check]
 *
 * `--check` regenerates in memory and fails unless the committed oracle is byte-identical.
 */

const sourceRepository = "todd-skelton/tcgplayer-automation-app";
const sourceCommit = "bdeffa0190be035084abccb464716aaaa2541a59";
/** The solver's import closure, plus `pricingService.ts`, which the brief's probe also pins. */
const sourceBlobs = {
  "app/features/pricing/domain/pricingPolicy.ts": "36f40f8096ba9657118096b20e705c53fedfb7b8",
  "app/core/types/pricingPolicy.ts": "aa652940720ea8a923c3e7a9507e44ce0664bc2e",
  "app/features/pricing/domain/maximize.ts": "3e6b75f9b9a3dc67d135262bf3ae361ef81eaacd",
  "app/features/pricing/services/pricingService.ts": "72acf472e76c1603dd71b22b627270172e847cab",
  "app/core/types/pricing.ts": "8d72572cce52b4c504e50785e89750a952b803cd",
  "app/features/pricing/domain/horizonValueCurve.ts": "1d6ccccfa59b9a53876df4f41722bfe6355f7e87",
} as const;

const fixtureFile = "goal-parity-curve.json";
const oracleFile = "app-recorded-goal-oracle.json";

const grid = {
  percentiles: Array.from({ length: 19 }, (_, index) => (index + 1) * 5),
  horizonDays: [7, 14, 30, 60, 90, 180],
  dailyReturnHurdles: [0.001, 0.005, 0.01, 0.02],
};

/** Uncapped Economics overhead terms; the app's flat overhead coincides with them only without caps. */
const feeTermSets = {
  typical: {
    platformFeeRelativeBps: 1_075,
    platformFeeFixedPerUnitAmount: "0.30",
    platformFeeCapPerUnitAmount: null,
    sellerHandlingRelativeBps: 250,
    sellerHandlingFixedPerUnitAmount: "0.20",
    sellerHandlingCapPerUnitAmount: null,
  },
  "loss-at-low-prices": {
    platformFeeRelativeBps: 1_075,
    platformFeeFixedPerUnitAmount: "6.00",
    platformFeeCapPerUnitAmount: null,
    sellerHandlingRelativeBps: 0,
    sellerHandlingFixedPerUnitAmount: "0.50",
    sellerHandlingCapPerUnitAmount: null,
  },
  "loss-at-every-price": {
    platformFeeRelativeBps: 1_075,
    platformFeeFixedPerUnitAmount: "25.00",
    platformFeeCapPerUnitAmount: null,
    sellerHandlingRelativeBps: 0,
    sellerHandlingFixedPerUnitAmount: "0.00",
    sellerHandlingCapPerUnitAmount: null,
  },
} as const;

type FixturePoint = {
  percentile: number;
  priceAmount: string;
  buyerArrivalIntervalDays: number | null;
  competingSellerCount: number | null;
  storeWinShare: number | null;
  medianSellDays: number | null;
  qualifyingSaleCount: number;
  historyCapped: boolean;
  supplyStatus: string;
};

type AppDecision = {
  selectedPrice: number;
  unconstrainedPrice?: number;
  equivalentPercentile?: number;
  estimatedMedianSellDays?: number;
  unprofitable?: boolean;
  forecastStatus: string;
};

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

async function renderGoalOracle(appRoot: string): Promise<string> {
  verifyPinnedSources(appRoot);
  const fixtureBytes = readFileSync(new URL(`./${fixtureFile}`, import.meta.url));
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
    curves: Record<string, { currencyCode: string; version: number; points: FixturePoint[] }>;
  };
  const app = await import(pathToFileURL(resolve(appRoot, "app/features/pricing/domain/pricingPolicy.ts")).href);
  const record = (decision: AppDecision | undefined) =>
    decision === undefined
      ? null
      : {
          selectedPrice: decision.selectedPrice,
          unconstrainedPrice: decision.unconstrainedPrice ?? null,
          equivalentPercentile: decision.equivalentPercentile ?? null,
          forecastStatus: decision.forecastStatus,
          unprofitable: decision.unprofitable === true,
          estimatedMedianSellDays: decision.estimatedMedianSellDays ?? null,
        };

  const cases = Object.entries(fixture.curves).flatMap(([curveName, curve]) => {
    const appCurve = app.toPricingCurve(
      curve.points.map((point) => ({
        percentile: point.percentile,
        suggestedPrice: Number(point.priceAmount),
        historicalSalesVelocityDays: point.buyerArrivalIntervalDays ?? undefined,
        estimatedTimeToSellDays: point.medianSellDays ?? undefined,
        salesCount: point.qualifyingSaleCount,
        historyCapped: point.historyCapped,
        listingsCount: point.competingSellerCount ?? undefined,
        storeWinShare: point.storeWinShare ?? undefined,
        supplyStatus: point.supplyStatus,
      })),
    );
    const decide = (policy: Record<string, unknown>) => record(app.selectPricingDecision(appCurve, policy));
    return [
      ...grid.percentiles.map((percentile) => ({
        curve: curveName,
        goalId: "fixed-percentile",
        parameters: { percentile },
        economics: null,
        appPolicy: { method: "percentile", percentile },
      })),
      ...grid.horizonDays.map((horizonDays) => ({
        curve: curveName,
        goalId: "target-horizon",
        parameters: { horizonDays },
        economics: null,
        appPolicy: { method: "target-horizon", horizonDays },
      })),
      ...Object.entries(feeTermSets).flatMap(([feeTerms, terms]) => {
        if (terms.platformFeeCapPerUnitAmount !== null || terms.sellerHandlingCapPerUnitAmount !== null)
          throw new Error(`Fee terms ${feeTerms} are capped; capped terms have no app parity.`);
        return grid.dailyReturnHurdles.map((dailyReturnHurdle) => ({
          curve: curveName,
          goalId: "profit-per-day",
          parameters: {},
          economics: { dailyReturnHurdle, feeTerms },
          appPolicy: {
            method: "profit-per-day",
            dailyReturnHurdle,
            relativeOverhead: (terms.platformFeeRelativeBps + terms.sellerHandlingRelativeBps) / 10_000,
            staticOverheadPerUnit:
              Number(terms.platformFeeFixedPerUnitAmount) + Number(terms.sellerHandlingFixedPerUnitAmount),
          },
        }));
      }),
    ].map((entry) => ({ ...entry, decision: decide(entry.appPolicy) }));
  });

  const oracle = {
    status: "app-recorded-synthetic-not-live",
    sourceRepository,
    sourceCommit,
    sourceBlobs,
    fixture: { file: fixtureFile, sha256: createHash("sha256").update(fixtureBytes).digest("hex") },
    feeTermSets,
    cases,
  };
  return `${JSON.stringify(oracle, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appRoot = process.env.APP_ROOT;
  if (!appRoot) throw new Error("APP_ROOT must point to the pinned read-only app checkout.");
  const output = new URL(`./${oracleFile}`, import.meta.url);
  const rendered = await renderGoalOracle(appRoot);
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== rendered) throw new Error(`${oracleFile} differs from its regeneration.`);
  } else {
    writeFileSync(output, rendered);
  }
}
