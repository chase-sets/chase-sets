import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const featureRoot = path.resolve(import.meta.dirname, "..");

describe("channel-reconciliation-artifact-secret-scan", () => {
  it("keeps retained health and metric payloads on bounded safe fields", () => {
    const production = productionFiles(featureRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const forbidden of [
      "credentialReference",
      "accessToken",
      "refreshToken",
      "rawProviderResponse",
      "exceptionMessage",
      "sellerIdentity",
      "nextPageUrl",
    ]) {
      expect(production, forbidden).not.toContain(forbidden);
    }
    expect(production).toContain('reasonCode: "drift"');
    expect(production).toContain("ChannelReconciliationCounts");
  });
});

function productionFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (name === "tests") return [];
    return statSync(file).isDirectory() ? productionFiles(file) : file.endsWith(".ts") ? [file] : [];
  });
}
