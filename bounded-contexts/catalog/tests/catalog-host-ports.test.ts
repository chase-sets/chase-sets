import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

type CatalogContextManifest = Readonly<{
  hostPorts?: readonly Readonly<{ portName: string; providedBy?: string; purpose?: string }>[];
}>;

describe("catalog host ports", () => {
  it("declares the deployable-provided ports required by Catalog services", () => {
    const context = JSON.parse(readFileSync(resolve(repoRoot, "bounded-contexts/catalog/context.json"), "utf8")) as
      CatalogContextManifest;
    const hostPorts = new Set((context.hostPorts ?? []).map((entry) => entry.portName));

    expect(hostPorts).toEqual(
      new Set(["catalogAssetStorage", "sourceObservationTelemetry", "tcgplayerAutomationCatalogClient"]),
    );
  });
});
