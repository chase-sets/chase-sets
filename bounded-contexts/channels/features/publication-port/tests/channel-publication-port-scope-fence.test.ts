import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../../context.json" with { type: "json" };
import packageJson from "../../../package.json" with { type: "json" };
import { collectPublicationCallerEvidence, listTrackedProductionSources, repoRoot } from "./source-evidence";

describe("channel-publication-port-scope-fence", () => {
  it("ships only domain, api, and tests with no provider, host-port, export-subpath, or mutable registry surface", () => {
    const sliceRoot = path.resolve(import.meta.dirname, "..");
    const relativeFiles = listFiles(sliceRoot);
    expect([...new Set(relativeFiles.map((file) => file.split("/")[0]))].sort()).toEqual(["api", "domain", "tests"]);
    expect(manifest.slices).toEqual(["connections", "publication-port", "listing-composition", "outbound-sync"]);
    expect(manifest.hostPorts).toEqual([]);
    expect(manifest.allowedSupportDirectories).toEqual(["request-support"]);
    expect(manifest.publicExports).toEqual([".", "./context", "./server", "./routes/*"]);
    expect(packageJson.exports).toEqual({
      ".": "./index.ts",
      "./context": "./context.json",
      "./server": "./server.ts",
      "./routes/*": "./routes/*.tsx",
    });

    const contracts = readFileSync(path.join(sliceRoot, "domain/contracts.ts"), "utf8");
    const registry = readFileSync(path.join(sliceRoot, "api/registry.ts"), "utf8");
    expect(contracts).not.toMatch(/\b(?:register|add|set|remove|clear)\s*\(/);
    expect(registry).toContain(
      "const productionChannelProviderDescriptors: readonly ChannelProviderDescriptor[] = Object.freeze([",
    );
    expect(registry).toContain("...tcgplayerProviderDescriptors");
    expect(registry).not.toMatch(/export\s+(?:const|\{[^}]*\})\s*productionChannelProviderDescriptors/);
    expect(registry).not.toMatch(/\bebay\b/i);
    expect(relativeFiles.some((file) => /(?:ui|integrations|read-model|runtime-support)\//.test(file))).toBe(false);
  });

  it("finds exactly one production construction call and one exported singleton while allowing test fixtures", () => {
    const files = listTrackedProductionSources();
    const productionSource = [...files.values()].join("\n");
    expect(countConstructionCalls(productionSource)).toBe(1);
    expect([...productionSource.matchAll(/export const channelProviderRegistry\b/g)]).toHaveLength(1);
    expect([...productionSource.matchAll(/const productionChannelProviderDescriptors\b/g)]).toHaveLength(1);
    expect(collectPublicationCallerEvidence(files).violations).toEqual([]);

    const secondInstanceMutant = `${productionSource}\nconst secondRegistry = createChannelProviderRegistry([]);\n`;
    expect(countConstructionCalls(secondInstanceMutant)).toBe(2);
  });

  it("keeps forbidden claimed-lifecycle and provider-specific surfaces absent", () => {
    const productionFiles = listTrackedProductionSources();
    const sliceProduction = [...productionFiles]
      .filter(([relativePath]) => relativePath.startsWith("bounded-contexts/channels/features/publication-port/"))
      .map(([, source]) => source)
      .join("\n");
    for (const forbidden of [
      "claimedOperation",
      "resultReport",
      "claimGeneration",
      "leaseId",
      "retryPolicy",
      "healthCheck",
      "providerMessage",
      "registerProvider",
    ]) {
      expect(sliceProduction, forbidden).not.toContain(forbidden);
    }
    expect(sliceProduction).not.toMatch(/\b(?:fetch|playwright|webdriver|oauth|credentialReference)\s*\(/i);
    expect(readFileSync(path.join(repoRoot, "bounded-contexts/channels/index.ts"), "utf8")).toContain(
      "ports?.setupResolver ?? channelProviderRegistry.setupResolver",
    );
  });
});

function countConstructionCalls(source: string): number {
  const withoutDeclaration = source.replaceAll(/export function createChannelProviderRegistry\s*\(/g, "declaration(");
  return [...withoutDeclaration.matchAll(/\bcreateChannelProviderRegistry\s*\(/g)].length;
}

function listFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, absolute) : [path.relative(root, absolute).replaceAll("\\", "/")];
  });
}
