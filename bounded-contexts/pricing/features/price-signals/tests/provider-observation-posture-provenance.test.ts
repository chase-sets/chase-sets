import { describe, expect, it } from "vitest";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { executedPosture, reducedObservationInput } from "./reduced-observation-test-support";
import { expectSourceMutantRed } from "./source-mutant-test-support";

type MapperModule = typeof import("../domain/provider-observation-mapper");

describe("provider observation executed posture provenance", () => {
  it("records P1 separately from frozen R2, omits the timeout, and does not claim seller exclusion", () => {
    assertProvenance(mapProviderObservationCapture);
  });

  it("rejects restoring policy-derived posture with only that seam changed", async () => {
    await expectSourceMutantRed<MapperModule>(
      {
        id: "reduced-posture-from-policy",
        defect: "records frozen policy settings instead of the executed posture",
        mutations: [
          {
            file: "domain/provider-observation-mapper.ts",
            find: "      requestPosture: withoutTimeout(executedPosture),",
            replace: `      requestPosture: {
        salesOffset: 0,
        salesLimit: input.observationPolicy.value.sales.limit,
        salesPageSize: input.observationPolicy.value.sales.pageSize,
        salesPageBudget: input.observationPolicy.value.sales.pageBudget,
        salesConditions: input.observationPolicy.value.sales.conditions,
        salesLanguages: input.observationPolicy.value.sales.languages,
        salesVariants: input.observationPolicy.value.sales.variants,
        salesListingType: input.observationPolicy.value.sales.listingType,
        listingsVerifiedOnly: input.observationPolicy.value.listings.verifiedSellersOnly,
        listingsPageSize: input.observationPolicy.value.listings.pageSize,
        listingsPageBudget: input.observationPolicy.value.listings.pageBudget,
        listingsDeliveredCeiling: input.observationPolicy.value.listings.deliveredCeiling,
        historyRange: "annual",
      },`,
          },
        ],
      },
      "domain/provider-observation-mapper.ts",
      ["AC2"],
      async (module) => assertProvenance(module.mapProviderObservationCapture),
    );
  });

  it.each([
    ["include", "omit", null],
    ["omit", "include", null],
    [null, "omit", "include"],
    ["omit", "omit", "omit"],
    [null, null, null],
  ] as const)("derives authentication from sales=%s, listings=%s, history=%s", (sales, listings, history) => {
    const input = reducedObservationInput();
    const capture = mapProviderObservationCapture({
      ...input,
      observation: {
        ...input.observation,
        sales: { ...input.observation.sales, credentialsMode: sales },
        listings: { ...input.observation.listings, credentialsMode: listings },
        history: { ...input.observation.history, credentialsMode: history },
      },
    });
    expect(capture.header.authenticatedRequest).toBe([sales, listings, history].includes("include"));
    expect(capture.header.listings?.ownSellerExclusionApplied).toBe(false);
  });
});

function assertProvenance(map: MapperModule["mapProviderObservationCapture"]) {
  const input = reducedObservationInput();
  const capture = map({
    ...input,
    observationPolicy: {
      revisionId: "frozen-policy-r2",
      value: { ...input.observationPolicy.value, capturesPerPass: 3, currency: "eur" },
    },
  });
  const { timeoutMs: _timeoutMs, ...expectedPosture } = executedPosture;
  expect(capture.header.requestPosture, "AC2:executed-posture-not-policy").toEqual(expectedPosture);
  expect(capture.header.requestPosture).not.toHaveProperty("timeoutMs");
  expect(capture.header.observationPolicyRevisionId).toBe("frozen-policy-r2");
  expect(capture.header.capturesPerPass).toBe(3);
  expect(capture.header.currency).toBe("eur");
  expect(capture.header.listings?.ownSellerExclusionApplied).toBe(false);
}
