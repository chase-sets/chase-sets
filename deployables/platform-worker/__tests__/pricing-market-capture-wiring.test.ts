import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pricingContext from "@chase-sets/pricing/context" with { type: "json" };

describe("Pricing market-capture worker wiring", () => {
  it("mounts the declared typed transport and schedules the real service without casts or a bridge", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const runners = readFileSync(new URL("../src/scheduled-runners.ts", import.meta.url), "utf8");
    expect(pricingContext.hostPorts).toContainEqual(expect.objectContaining({ portName: "tcgplayerMarketTransport" }));
    expect(main).toContain("const pricingHostPorts: PricingHostPorts");
    expect(main).toContain("tcgplayerMarketTransport: tcgplayerAutomationHttpClients");
    expect(main).not.toMatch(/tcgplayerMarketTransport[^\n]+\bas\b/);
    expect(runners).toContain("pricing?.priceSignals.runTcgplayerMarketCapture");
    expect(runners).toContain("const pricingCandidate = services.pricing;");
    expect(runners).toContain("const pricing = isPricingServices(pricingCandidate) ? pricingCandidate : undefined;");
    expect(runners).not.toContain("const pricing = services.pricing as PricingServices");
  });
});
