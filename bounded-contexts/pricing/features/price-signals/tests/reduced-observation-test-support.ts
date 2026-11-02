import { readFileSync } from "node:fs";
import type { SecondaryProduct, TcgplayerMarketObservationPosture } from "@chase-sets/tcgplayer-market-observations";
import type {
  ProviderObservationCapture,
  ProviderObservationMappingInput,
} from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";

export const reducedParityFixture = JSON.parse(
  readFileSync(new URL("./fixtures/provider-observations/salvage-reduced-parity.json", import.meta.url), "utf8"),
) as {
  sourceCommit: string;
  status: string;
  observation: SecondaryProduct;
  expected: Pick<ProviderObservationCapture, "sales" | "weekly" | "snapshots" | "askDepth">;
};

export const executedPosture: TcgplayerMarketObservationPosture = {
  salesOffset: 0,
  salesLimit: 3,
  salesPageSize: 3,
  salesPageBudget: 1,
  salesConditions: [1],
  salesLanguages: [1],
  salesVariants: [1],
  salesListingType: "All",
  listingsVerifiedOnly: false,
  listingsPageSize: 6,
  listingsPageBudget: 1,
  listingsDeliveredCeiling: "100.00",
  historyRange: "annual",
  timeoutMs: 777,
};

export function reducedObservationInput(
  overrides: Partial<ProviderObservationMappingInput> = {},
): ProviderObservationMappingInput {
  return {
    providerKey: "tcgplayer",
    catalogItemId: "cat_synthetic",
    productExternalKey: "product:7001",
    catalogProductKeysBySku: new Map([[9001, "cat_synthetic::condition:near-mint"]]),
    signalPassStartedAt: "2026-09-01T00:00:00.000Z",
    signalPolicy: { revisionId: "signal-r1", value: { productsPerPass: 1 } },
    captureStartedAt: "2026-09-01T00:00:00.000Z",
    captureCompletedAt: "2026-09-01T00:00:02.000Z",
    observationPolicy: { revisionId: "frozen-policy-r2", value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE },
    statHygienePolicyRevisionId: "stat-r1",
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    executedPosture,
    observation: reducedParityFixture.observation,
    ...overrides,
  };
}
