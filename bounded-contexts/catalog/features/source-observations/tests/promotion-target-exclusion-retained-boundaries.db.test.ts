import { describe, expect, it } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext as context } from "../../../support/seed-support/context";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import { sourceObservationTargetId } from "../api/promotion/promotion-target-identity";
import {
  locatePromotionReferenceStreams,
  requirePromotionTargetIndexes,
} from "../api/promotion/promotion-reference-locator";
import { usePromotionTargetExclusionFixture } from "./promotion-target-exclusion-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for promotion target exclusion DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("promotion target exclusion through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  const { record, retainedPlan, itemCreations, acquire } = usePromotionTargetExclusionFixture(
    databaseBaseUrl,
    (fresh) => {
      ({ pool, services } = fresh);
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])(
    "retained mapper-derived create boundary %s never creates a second target",
    async (boundary) => {
      const retained = await retainedPlan("retained-A", boundary >= 13 ? "PRODUCT:SYNTHETIC-493958" : undefined);
      expect(retained.plan.commands).toHaveLength(14);
      expect(retained.plan.commands[13].type).toBe("LinkExternalCatalogItemReference");
      for (const command of retained.plan.commands.slice(0, boundary))
        await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
      await record("incoming-B");
      const locator = await locatePromotionReferenceStreams(pool, {
        level: "item",
        providerKey: "tcgplayer",
        externalKey: "product:synthetic-493958",
      });
      expect(locator).toContain("catalog.source-observation-retained-A");
      if (boundary === 13) expect(locator).not.toContain(`catalog.item-${retained.targetId}`);
      const attempt = services.sourceObservations.promoteObservation({ observationId: "incoming-B", context });
      if (boundary > 0 && boundary < retained.plan.commands.length) {
        await expect(attempt).rejects.toThrow("promotion-target-retained-prefix");
        await expect(
          services.sourceObservations.promoteObservation({ observationId: "retained-A", context }),
        ).resolves.toMatchObject({ catalogItemId: retained.targetId });
      } else {
        const result = await attempt;
        if (boundary > 0) expect(result.catalogItemId).toBe(retained.targetId);
        await expect(
          createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "retained-A", context }),
        ).resolves.toMatchObject({ catalogItemId: result.catalogItemId });
      }
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it("refuses missing indexes without item effects", async () => {
    await record("missing-index");
    await pool.query("DROP INDEX catalog_promotion_source_reference_pairs_v1_idx");
    await expect(requirePromotionTargetIndexes(pool)).rejects.toThrow("promotion-target-access-paths-unavailable");
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "missing-index", context }),
    ).rejects.toThrow("promotion-target-access-paths-unavailable");
    expect(await itemCreations()).toHaveLength(0);
  });

  it.each(["observed", "deferred", "rejected"] as const)(
    "retains both reference revisions after an unattempted source is %s",
    async (status) => {
      await record("history-A", "product:old");
      await record("history-A", "product:new", {
        catalogHashMaterial: { ...fixture.catalogHashMaterial, name: "Synthetic revised hash material" },
      });
      if (status !== "observed")
        await services.sourceObservations.commandHandler({
          streamId: "catalog.source-observation-history-A",
          command:
            status === "rejected"
              ? { type: "RejectSourceObservation", reason: "Synthetic retained history" }
              : {
                  type: "DeferSourceObservation",
                  reason: "Synthetic retained history",
                  deferredAt: "2026-10-10T00:00:00.000Z",
                },
          context,
        });
      await record("history-B", "product:old");
      const winner = await services.sourceObservations.promoteObservation({ observationId: "history-B", context });
      if (!winner.catalogItemId) throw new Error("Expected an item promotion");
      const session = await acquire(winner.catalogItemId, [{ level: "member", observationId: "history-B" }]);
      expect(session.evidence.keys.has(JSON.stringify(["item", "tcgplayer", "product:new"]))).toBe(true);
      expect(
        session.evidence.sources
          .get("history-A")!
          .revisions.some((revision) =>
            revision.normalized?.externalCatalogItemReferences?.some(
              (reference) => reference.externalKey === "product:old",
            ),
          ),
      ).toBe(true);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it("refuses an identity-poisoned retained stream instead of treating it as absence", async () => {
    const retained = await retainedPlan("poisoned-A");
    const store = createPostgresEventStore({ pool });
    await store.appendToStream({
      streamId: `catalog.item-${retained.targetId}`,
      expectedVersion: 0,
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: {
            itemId: "different-identity",
            languageCode: "en",
            title: { defaultLocale: "en", values: { en: "Synthetic poison" } },
          },
        },
      ],
    });
    await record("poisoned-B");
    await expect(
      services.sourceObservations.promoteObservation({ observationId: "poisoned-B", context }),
    ).rejects.toThrow("promotion-target-conflicting-item-identity");
    expect(
      await readCompleteStream(store, { streamId: `catalog.item-${sourceObservationTargetId("poisoned-B")}` }),
    ).toEqual([]);
  });
});
