import { describe, expect, it, vi } from "vitest";
import {
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext as context } from "../../../support/seed-support/context";
import { usePromotionTargetExclusionFixture } from "./promotion-target-exclusion-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for promotion target exclusion DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("promotion target exclusion through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  const { record, retainedPlan, itemCreations, acquire } = usePromotionTargetExclusionFixture(
    async () => {
      const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "promotion_target_exclusion");
      await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
      return createMultiContextTestPools(urls).catalog;
    },
    (fresh) => {
      ({ pool, services } = fresh);
    },
  );

  it.each(Array.from({ length: 14 }, (_, index) => index + 1))(
    "resumes a real guarded promotion after command commit %s, including effects before marker",
    async (commandNumber) => {
      const retained = await retainedPlan("crash-A");
      expect(retained.plan.commands).toHaveLength(14);
      const connect = pool.connect.bind(pool);
      let commits = 0;
      let interrupted = false;
      const spy = vi.spyOn(pool, "connect").mockImplementation((...args: unknown[]) => {
        if (typeof args[0] === "function") return Reflect.apply(connect, pool, args);
        return connect().then((client) => {
          let promotion = false;
          const originalQuery = client.query.bind(client);
          let query: typeof client.query = async <Row = Record<string, unknown>>(
            sql: string,
            values?: readonly unknown[],
          ) => {
            if (sql === "LOCK TABLE catalog_provider_integration_profile_versions IN SHARE MODE") promotion = true;
            const result = await originalQuery<Row>(sql, values);
            // Acquire and preparePlan bind first; each following COMMIT is one
            // atomic command, including commands whose domain result is empty.
            if (sql === "COMMIT" && promotion && ++commits === commandNumber + 2) {
              interrupted = true;
              throw new Error("synthetic-after-command-commit");
            }
            return result;
          };
          return new Proxy(client, {
            get(target, key) {
              if (key === "query") return query;
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
            // Projection transactions temporarily wrap query. Keep that wrapper
            // visible without mutating the pooled client's underlying method.
            set(target, key, value) {
              if (key === "query") {
                query = value;
                return true;
              }
              return Reflect.set(target, key, value, target);
            },
          });
        });
      });
      try {
        await expect(
          services.sourceObservations.promoteObservation({ observationId: "crash-A", context }),
        ).rejects.toThrow("synthetic-after-command-commit");
      } finally {
        spy.mockRestore();
      }
      expect(interrupted).toBe(true);
      const store = createPostgresEventStore({ pool });
      const prefix = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      await expect(
        createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "crash-A", context }),
      ).resolves.toMatchObject({ catalogItemId: retained.targetId });
      const resumed = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      expect(resumed.slice(0, prefix.length)).toEqual(prefix);
      expect(resumed.filter((event) => event.eventType === "catalog.catalog-item.created")).toHaveLength(1);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it("allocates once for a legacy-only shared-port member set", async () => {
    await record("legacy-A");
    await record("legacy-B");
    const keys = [
      { level: "member", observationId: "legacy-A" },
      { level: "member", observationId: "legacy-B" },
    ] as const;
    const session = await acquire("cat_candidate_legacy", keys);
    expect(session.evidence.keys.has(JSON.stringify(["item", "tcgplayer", "product:synthetic-493958"]))).toBe(true);
    await expect(acquire("cat_candidate_other", [...keys].reverse())).rejects.toThrow(
      "promotion-target-bound-elsewhere",
    );
    await session.append({
      streamId: "catalog.item-cat_candidate_legacy",
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: {
            itemId: "cat_candidate_legacy",
            languageCode: "en",
            title: { defaultLocale: "en", values: { en: "Synthetic candidate" } },
            subtitle: null,
            description: null,
          },
        },
      ],
    });
    expect(await itemCreations()).toHaveLength(1);
  });

  it.each([13, 14])("shared-port consumers cannot bypass retained application boundary %s", async (boundary) => {
    const retained = await retainedPlan("shared-port-retained-A");
    for (const command of retained.plan.commands.slice(0, boundary))
      await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
    await record("shared-port-incoming-B");
    await expect(
      acquire("cat_candidate_attempted_fork", [{ level: "member", observationId: "shared-port-incoming-B" }]),
    ).rejects.toThrow("promotion-target-bound-elsewhere");
    expect(await itemCreations()).toHaveLength(1);
  });
});
