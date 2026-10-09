import { describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import { module as marketplaceModule } from "../../../index";
import { opportunitySourceProjections } from "../integrations/opportunity-publication/source-proof";

describe("Review opportunity source inventory", () => {
  it("binds all eight proof tuples and revisions to factory-resolved runners, including both local v1 subscriptions", () => {
    const pool: PgTransactionalPool = {
      async query() {
        throw new Error("Inventory must not read the database");
      },
      async connect() {
        throw new Error("Inventory must not read the database");
      },
    };
    const services = marketplaceModule.createServices(pool, {});
    const active: MountedContextRuntimeEntry = {
      contextName: "marketplace",
      module: marketplaceModule,
      services,
      pool,
      projectionHandlerSets: marketplaceModule.projectionHandlerSets!(services),
    };
    const sources = new Set(marketplaceModule.buildSubscriptions!(services).map((item) => item.sourceContextName));
    const mounted = [
      active,
      ...[...sources]
        .filter((name) => name !== "marketplace")
        .map((contextName) => ({
          ...active,
          contextName,
          mountRole: "source-only" as const,
          projectionHandlerSets: [],
        })),
    ];
    const runners = resolveModuleSubscriptions(mounted);
    const groups = resolveModuleProjectionGroups(mounted, runners);
    expect(opportunitySourceProjections).toEqual([
      ["marketplace-review-order-source-projection", "ordering", 1],
      ["marketplace-review-shipment-source-projection", "fulfillment", 1],
      ["marketplace-review-support-source-projection", "platform-operations", 2],
      ["marketplace-review-hold-reaction", "platform-operations", 1],
      ["marketplace-review-scoring-reaction", "platform-operations", 1],
      ["marketplace-review-moderation-reaction", "platform-operations", 1],
      ["marketplace-review-projection", "marketplace", 1],
      ["marketplace-review-hold-projection", "marketplace", 1],
    ]);
    for (const [name, source, version] of opportunitySourceProjections) {
      expect(runners.filter((runner) => runner.checkpointKey === `${name}:${source}:v${version}`)).toHaveLength(1);
      expect(
        groups.find((group) => group.targetContextName === "marketplace" && group.projectionName === name),
      ).toMatchObject({ projectionRevision: name === "marketplace-review-projection" ? 2 : 1 });
    }
    // This pin is inventory only. The DB suite executes the proof SQL against native subscription authority.
  });
});
