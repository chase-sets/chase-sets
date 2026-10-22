import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  portfolioFixture,
  portfolioFixtureBytes,
  portfolioFixtureFile,
  portfolioScenario,
  type PortfolioFixtureListing,
  type PortfolioScenarioName,
} from "./portfolio-parity";

/**
 * Records the parity app's `resolveValueMatchedPortfolioPlan`, horizon value
 * curve fit and best capital cycle over the committed portfolio fixture; it
 * never imports a Chase Sets solver. Run it from a read-only checkout of the
 * pinned commit with LF line endings, so each source hashes to its pinned git
 * blob (for example `git -c core.autocrlf=false archive`), resolving the app's
 * `~/` alias through its own tsconfig:
 *
 *   APP_ROOT=<checkout> pnpm exec tsx --tsconfig <checkout>/tsconfig.json generate-portfolio-oracle.ts [--check]
 *
 * `--check` regenerates in memory and fails unless the committed oracle is byte-identical.
 */

const sourceRepository = "todd-skelton/tcgplayer-automation-app";
const sourceCommit = "bdeffa0190be035084abccb464716aaaa2541a59";
/** The import closure of the three recorded app functions. */
const sourceBlobs = {
  "app/features/pricing/domain/pricingPolicy.ts": "36f40f8096ba9657118096b20e705c53fedfb7b8",
  "app/core/types/pricingPolicy.ts": "aa652940720ea8a923c3e7a9507e44ce0664bc2e",
  "app/core/types/pricing.ts": "8d72572cce52b4c504e50785e89750a952b803cd",
  "app/features/pricing/domain/maximize.ts": "3e6b75f9b9a3dc67d135262bf3ae361ef81eaacd",
  "app/features/pricing/domain/horizonValueCurve.ts": "1d6ccccfa59b9a53876df4f41722bfe6355f7e87",
  "app/features/pricing/domain/capitalCycle.ts": "1fc6c9b93c190ccafd008c46c542ead58222cd9a",
} as const;

const oracleFile = "app-recorded-portfolio-oracle.json";
const scenarioNames: readonly PortfolioScenarioName[] = [
  "matched",
  "boundary-high",
  "boundary-low",
  "infeasible",
  "one-listing",
];
/** The app's horizon model samples its value curve at this many log-spaced horizons (`HORIZON_FIT_SAMPLE_COUNT`). */
const horizonFitSampleCount = 24;

type AppDecision = { selectedPrice: number };
type AppItem = Readonly<{
  sku: number;
  currentPrice?: number;
  curve: unknown;
  constraintIdentity?: string;
  applyConstraint?: (price: number) => { price: number; constraint: string };
}>;

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

const roundCurrency = (value: number): number => Math.round(value * 100) / 100;

export async function renderPortfolioOracle(appRoot: string): Promise<string> {
  verifyPinnedSources(appRoot);
  const domain = (file: string) =>
    import(pathToFileURL(resolve(appRoot, `app/features/pricing/domain/${file}.ts`)).href);
  const [policy, horizon, cycle] = await Promise.all([
    domain("pricingPolicy"),
    domain("horizonValueCurve"),
    domain("capitalCycle"),
  ]);

  const toItem = (listing: PortfolioFixtureListing): AppItem => {
    const floor = listing.floorAmount === null ? null : Number(listing.floorAmount);
    return {
      sku: listing.sku,
      ...(listing.currentPriceAmount === null ? {} : { currentPrice: Number(listing.currentPriceAmount) }),
      curve: policy.toPricingCurve(
        listing.curve.points.map((point) => ({
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
      ),
      ...(floor === null
        ? {}
        : {
            constraintIdentity: `floor:${listing.floorAmount}`,
            applyConstraint: (price: number) =>
              price < floor ? { price: floor, constraint: "floor" } : { price, constraint: "none" },
          }),
    };
  };
  const listingIdBySku = new Map(portfolioFixture.listings.map((listing) => [listing.sku, listing.listingId]));

  const scenarios = Object.fromEntries(
    scenarioNames.map((name) => {
      const resolved = policy.resolveValueMatchedPortfolioPlan(portfolioScenario(name).map(toItem), {
        createdAt: new Date(0),
      });
      const { id, modelVersion, createdAt, inventorySnapshotId, ...plan } = resolved.plan;
      const decisions = Object.fromEntries(
        [...(resolved.decisionsBySku as Map<number, AppDecision>)]
          .map(([sku, decision]) => [listingIdBySku.get(sku)!, decision.selectedPrice] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      return [name, { plan, decisions }];
    }),
  );

  // The app's `evaluateHorizonValue` at one copy per listing, over the listings that have a current price.
  const baseline = portfolioScenario("matched")
    .filter((listing) => listing.currentPriceAmount !== null)
    .map(toItem);
  const range = policy.observedHorizonRange(baseline);
  const samples = (
    horizon.logSpacedHorizons(range.minimumDays, range.maximumDays, horizonFitSampleCount) as number[]
  ).map((horizonDays) => {
    const decisions = policy.portfolioDecisions(baseline, { method: "target-horizon", horizonDays }) as Map<
      number,
      AppDecision
    >;
    return {
      horizonDays,
      value: roundCurrency([...decisions.values()].reduce((sum, decision) => sum + decision.selectedPrice, 0)),
    };
  });
  const curve = horizon.fitHorizonValueCurve(samples, samples[0]!.value, samples.at(-1)!.value);
  const kneeDays = horizon.horizonKneeDays(curve);
  const portfolio = {
    marketValue: roundCurrency(baseline.reduce((sum, item) => sum + item.currentPrice!, 0)),
    unitCount: baseline.length,
  };
  const { economics } = portfolioFixture.capitalCycle;

  const oracle = {
    status: "app-recorded-synthetic-not-live",
    sourceRepository,
    sourceCommit,
    sourceBlobs,
    fixture: { file: portfolioFixtureFile, sha256: createHash("sha256").update(portfolioFixtureBytes).digest("hex") },
    scenarios,
    horizonModel: {
      range,
      samples,
      curve,
      kneeDays,
      marginalValuePerDayAtKnee: horizon.horizonMarginalValuePerDay(curve, kneeDays),
      gainElasticityAtKnee: horizon.horizonGainElasticity(curve, kneeDays),
    },
    bestCapitalCycle: {
      portfolio,
      economics,
      cycle: cycle.bestCapitalCycle(curve, portfolio, economics, {
        minimumHorizonDays: range.minimumDays,
        maximumHorizonDays: range.maximumDays,
      }),
    },
  };
  return `${JSON.stringify(oracle, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appRoot = process.env.APP_ROOT;
  if (!appRoot) throw new Error("APP_ROOT must point to the pinned read-only app checkout.");
  const output = new URL(`./${oracleFile}`, import.meta.url);
  const rendered = await renderPortfolioOracle(appRoot);
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== rendered) throw new Error(`${oracleFile} differs from its regeneration.`);
  } else {
    writeFileSync(output, rendered);
  }
}
