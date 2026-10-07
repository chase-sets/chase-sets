import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { liquidityEstimatedEventType } from "../read-model/demand-curve-writes";

describe("LiquidityEstimated producer guard", () => {
  it("has a production caller on the existing scheduled rollup ride", () => {
    const services = readFileSync(new URL("../../../support/runtime-support/services.ts", import.meta.url), "utf8");
    const worker = readFileSync(
      new URL("../../../../../deployables/platform-worker/src/scheduled-runners.ts", import.meta.url),
      "utf8",
    );
    expect(services).toContain("await demandCurves.runDemandCurveCloser(");
    expect(worker).toContain('"pricing.market-rollups-closer"');
  });

  it("no Marketplace or Inventory-writing context subscribes to the summary", () => {
    for (const context of ["marketplace", "inventory"]) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../../../../${context}/context.json`, import.meta.url), "utf8"),
      ) as {
        eventSubscriptions: readonly { eventTypes: readonly string[] }[];
        eventReactions?: readonly { eventTypes: readonly string[] }[];
      };
      expect(
        manifest.eventSubscriptions.some((subscription) =>
          subscription.eventTypes.includes(liquidityEstimatedEventType),
        ),
      ).toBe(false);
      expect(
        (manifest.eventReactions ?? []).some((reaction) => reaction.eventTypes.includes(liquidityEstimatedEventType)),
      ).toBe(false);
    }
  });
});
