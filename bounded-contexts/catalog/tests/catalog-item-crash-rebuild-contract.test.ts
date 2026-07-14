import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalogUnloggedProjectionExclusions } from "../support/runtime-support/unlogged-projection-migrations";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

type CatalogContext = Readonly<{
  projectionGroups: readonly Readonly<{
    projectionName: string;
    sourceContextNames: readonly string[];
    ownedTables: readonly string[];
    requiredDuringBootstrap: boolean;
    resetStrategy: string;
  }>[];
}>;

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("Catalog Item crash-rebuild contract", () => {
  it("declares replay from Catalog events for every table written by the base projector", () => {
    const context = JSON.parse(readRepoFile("bounded-contexts/catalog/context.json")) as CatalogContext;
    const group = context.projectionGroups.find(({ projectionName }) => projectionName === "catalog-item-projection");

    expect(group).toEqual({
      projectionName: "catalog-item-projection",
      sourceContextNames: ["catalog"],
      ownedTables: [
        "catalog_items",
        "catalog_external_catalog_item_references",
        "catalog_external_product_references",
        "catalog_item_gtins",
      ],
      requiredDuringBootstrap: false,
      resetStrategy: "replay-only",
    });
  });

  it("documents replay convergence and no longer misclassifies Catalog Items as authoring state", () => {
    const catalogReadme = readRepoFile("bounded-contexts/catalog/README.md");
    const exclusion = catalogUnloggedProjectionExclusions.find(({ tableName }) => tableName === "catalog_items");

    expect(catalogReadme).toContain(
      "replaying Catalog Item events from checkpoint zero over empty or previously projected `catalog_items`",
    );
    expect(catalogReadme).toContain("must deterministically converge without duplicate facts");
    expect(exclusion?.reason).toContain("Event-projected");
    expect(exclusion?.reason).toContain("FK-coupled to API-computed catalog_resolved_product_contents");
    expect(exclusion?.reason).not.toContain("Canonical Catalog authoring state");
  });
});
