import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import { module as marketplaceModule } from "../../../index";
import { opportunitySourceProjections } from "../integrations/opportunity-publication/source-proof";

describe("Review opportunity runtime identity inventory", () => {
  it("binds all eight proof tuples to declared or synthesized runners and runtime revisions", () => {
    const pool: PgTransactionalPool = {
      query: async () => {
        throw new Error("Inventory must not query storage");
      },
      connect: async () => {
        throw new Error("Inventory must not connect to storage");
      },
    };
    const services = marketplaceModule.createServices(pool, {});
    const entry: MountedContextRuntimeEntry = {
      contextName: "marketplace",
      module: marketplaceModule,
      services,
      pool,
      projectionHandlerSets: marketplaceModule.projectionHandlerSets!(services),
    };
    const declared = marketplaceModule.buildSubscriptions!(services);
    const sources = [...new Set(declared.map((subscription) => subscription.sourceContextName))];
    const mountedContexts: MountedContextRuntimeEntry[] = [
      entry,
      ...sources
        .filter((source) => source !== "marketplace")
        .map((contextName) => ({
          ...entry,
          contextName,
          mountRole: "source-only" as const,
          projectionHandlerSets: [],
        })),
    ];
    const runners = resolveModuleSubscriptions(mountedContexts);
    const groups = resolveModuleProjectionGroups(mountedContexts, runners);
    for (const [name, source, version] of opportunitySourceProjections) {
      const matching = runners.filter((runner) => runner.projectionName === name);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject({
        targetContextName: "marketplace",
        sourceContextName: source,
        subscriptionVersion: version,
        checkpointKey: `${name}:${source}:v${version}`,
      });
      const group = groups.find((candidate) => candidate.projectionName === name)!;
      expect(group.subscriptionRunners).toEqual(matching);
      expect(group.projectionRevision).toBe(name === "marketplace-review-projection" ? 2 : 1);
      if (source === "marketplace") {
        expect(declared.some((subscription) => subscription.projectionName === name)).toBe(false);
        expect(entry.projectionHandlerSets.some((set) => set.projectionName === name)).toBe(true);
      }
    }
    // This inventory alone does not distinguish the stopped #9095 proof query.
    // The persistent publication tests must execute the query against runner-written checkpoints.
    expect(opportunitySourceProjections).toHaveLength(8);
  });
});
