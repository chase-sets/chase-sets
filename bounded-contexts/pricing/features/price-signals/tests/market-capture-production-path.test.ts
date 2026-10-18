import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("provider market-capture production caller closure", () => {
  it("retires the scheduled runner and server transport", () => {
    const scheduled = source("../../../../../deployables/platform-worker/src/scheduled-runners.ts");
    const runtime = source("../api/runtime.ts");
    expect(scheduled).not.toContain("pricing.tcgplayer-market-capture");
    expect(runtime).not.toContain("createTcgplayerMarketCapture");
  });

  it("imports the real PricingHostPorts and supplies the raw four-client transport without a bridge cast", () => {
    const main = source("../../../../../deployables/platform-worker/src/main.ts");
    expect(main).toMatch(/import\s*\{[^}]*\btype PricingHostPorts\b[^}]*\}\s*from "@chase-sets\/pricing\/server";/);
    expect(main).not.toContain("pricingTcgplayerAutomationHttpClients");
    expect(main).not.toContain("createTcgplayerAutomationRuntime");
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
