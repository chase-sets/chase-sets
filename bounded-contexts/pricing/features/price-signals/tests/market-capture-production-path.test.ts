import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("provider market-capture production caller closure", () => {
  it("connects the scheduled runner to the real Pricing runtime and signal writer", () => {
    const scheduled = source("../../../../../deployables/platform-worker/src/scheduled-runners.ts");
    const runtime = source("../api/runtime.ts");
    const capture = source("../api/market-capture.ts");
    expect(scheduled).toContain("pricing.tcgplayer-market-capture");
    expect(scheduled).toContain("runTcgplayerMarketCapture()");
    expect(runtime).toContain("createTcgplayerMarketCapture");
    expect(capture).toContain("recordTcgplayerPriceSignal");
    expect(() =>
      assertProductionPath(scheduled.replace("runTcgplayerMarketCapture()", "0"), runtime, capture),
    ).toThrow();
  });

  it("imports the real PricingHostPorts and supplies the raw four-client transport without a bridge cast", () => {
    const main = source("../../../../../deployables/platform-worker/src/main.ts");
    expect(main).toMatch(/import\s*\{[^}]*\btype PricingHostPorts\b[^}]*\}\s*from "@chase-sets\/pricing\/server";/);
    expect(main).toContain("tcgplayerMarketTransport: tcgplayerAutomationHttpClients");
    expect(main).not.toMatch(/tcgplayerMarketTransport:[^\n]+\bas\b/);
  });
});

function assertProductionPath(scheduled: string, runtime: string, capture: string) {
  if (
    !scheduled.includes("runTcgplayerMarketCapture()") ||
    !runtime.includes("createTcgplayerMarketCapture") ||
    !capture.includes("recordTcgplayerPriceSignal")
  ) {
    throw new Error("zero-production-caller");
  }
}

function source(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}
