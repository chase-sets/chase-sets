import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mcpServiceCatalog } from "@chase-sets/platform-runtime/mcp-contracts";
import { describe, expect, it } from "vitest";

/**
 * Membership partition between the `catalog/` directory and the aggregate.
 *
 * A service module that exists on disk but is never composed into
 * `mcpServiceCatalog` is invisible to every other guard in this slice: the
 * catalog serialization, `validateMcpServiceCatalog`, and the composition guard
 * all read the aggregate, so a forgotten shard simply disappears. This is the
 * only check that reads the filesystem instead.
 */
export function findCatalogMembershipGaps(partition: {
  moduleNames: readonly string[];
  composedServiceIds: readonly string[];
}) {
  const composed = new Set(partition.composedServiceIds);
  const modules = new Set(partition.moduleNames);

  return {
    uncomposedModules: partition.moduleNames.filter((moduleName) => !composed.has(moduleName)).sort(),
    moduleLessServices: partition.composedServiceIds.filter((serviceId) => !modules.has(serviceId)).sort(),
  };
}

const catalogDirectory = fileURLToPath(new URL("./catalog", import.meta.url));
const aggregatePath = fileURLToPath(new URL("../mcp-contracts.ts", import.meta.url));

const moduleNames = readdirSync(catalogDirectory)
  .filter((entry) => entry.endsWith(".ts"))
  .map((entry) => entry.slice(0, -".ts".length));

/** Catalog module names the aggregate imports, in composition order. */
const importedModuleNames = [
  ...readFileSync(aggregatePath, "utf8").matchAll(
    /from "@chase-sets\/platform-runtime\/mcp-contracts\/catalog\/(.+)"/g,
  ),
].map(([, moduleName]) => moduleName);

const composedServiceIds = mcpServiceCatalog.map((service) => service.serviceId);

describe("mcp catalog membership partition", () => {
  it("composes every catalog module exactly once and leaves no service without a module", () => {
    expect(findCatalogMembershipGaps({ moduleNames, composedServiceIds })).toEqual({
      uncomposedModules: [],
      moduleLessServices: [],
    });
    expect([...moduleNames].sort()).toEqual([...new Set(moduleNames)].sort());
    expect([...composedServiceIds].sort()).toEqual([...new Set(composedServiceIds)].sort());
    expect(moduleNames).toHaveLength(composedServiceIds.length);
  });

  it("binds each catalog module to the service it is named for", () => {
    // Positional, not set-based: it catches two modules swapping their exports,
    // which a name-set comparison passes.
    expect(importedModuleNames).toEqual(composedServiceIds);
  });

  it("reports a catalog module that the aggregate never composes", () => {
    expect(
      findCatalogMembershipGaps({
        moduleNames: [...moduleNames, "orphaned-service"],
        composedServiceIds,
      }),
    ).toEqual({ uncomposedModules: ["orphaned-service"], moduleLessServices: [] });
  });

  it("reports a composed service with no catalog module", () => {
    expect(
      findCatalogMembershipGaps({
        moduleNames: moduleNames.filter((moduleName) => moduleName !== "settlement"),
        composedServiceIds,
      }),
    ).toEqual({ uncomposedModules: [], moduleLessServices: ["settlement"] });
  });
});

describe("mcp catalog shard hygiene", () => {
  it("keeps the shared service builder unforked", () => {
    // A forked `service()` with a drifted default is invisible to the catalog
    // serialization while every catalog site overrides tools and resources, and
    // diverges the moment a new service relies on the defaults.
    const redefinitions = moduleNames.filter((moduleName) =>
      /^(export )?const service = /m.test(readFileSync(`${catalogDirectory}/${moduleName}.ts`, "utf8")),
    );

    expect(redefinitions).toEqual([]);
  });
});
