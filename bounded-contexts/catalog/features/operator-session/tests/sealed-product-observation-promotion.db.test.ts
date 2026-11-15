import { expect, it } from "vitest";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { evolveCatalogItem, initialCatalogItemState, type CatalogItemEvent } from "../../catalog-items/domain/domain";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateEvent,
} from "../../source-observations/domain/catalog-merge-candidate";
import { applyCatalogMergeCandidatePromotion } from "../../source-observations/api/promotion/catalog-merge-candidate-application";
import { createPostgresPromotionTargetExclusion } from "../../source-observations/api/promotion/promotion-target-exclusion";
import { createCatalogIntegrationRolloutControlPolicyFromEnv } from "../../source-observations/api/governance/catalog-integration-rollout-controls";
import { catalogMergeCandidateStreamId } from "../../source-observations/api/source-observation-stream-identity";
import { describeDb, useOperatorSessionDatabase } from "./db-fixture";
import { composeSealedProducts, acceptSealedMapping } from "./sealed-product-db-fixture";
import { salvage, sealedPost } from "./sealed-product-observation-fixture";
import { testContext } from "./set-name-observation-fixture";

describeDb("extension sealed product promotion", () => {
  const db = useOperatorSessionDatabase("sealed_product_observation_promotion");
  it.each(salvage.cases.slice(0, 2))(
    "uses the accepted sealed mapping and promotes $unitKey to a draft",
    async (entry) => {
      const pool = db();
      const { post, services, store } = await composeSealedProducts(pool);
      const scopeRecordId = await acceptSealedMapping(
        pool,
        entry.unitKey,
        entry.detail.setName,
        entry.detail.productLineId,
      );
      const response = await post({ ...sealedPost(), products: [entry.detail] });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ candidateCount: 1, exclusions: [] });
      const candidates = await pool.query<{
        stream_id: string;
        payload: { snapshot: { identity: { scopeRecordId: string } } };
      }>("SELECT stream_id, payload FROM event_store_events WHERE event_type = 'catalog.merge-candidate.created'");
      expect(candidates.rows).toHaveLength(1);
      expect(candidates.rows[0]!.payload.snapshot.identity.scopeRecordId).toBe(scopeRecordId);
      const candidateId = candidates.rows[0]!.stream_id.slice("catalog.merge-candidate-".length);
      const commands = createAggregateCommandHandler({
        eventStore: store,
        codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
        initialState: () => initialCatalogMergeCandidateState,
        evolve: evolveCatalogMergeCandidate,
        decide: decideCatalogMergeCandidate,
      });
      const result = await applyCatalogMergeCandidatePromotion(
        {
          deps: {
            db: pool,
            eventStore: store,
            checkpointStore: createPostgresProjectionStore({ db: pool }),
            promotionTargetExclusion: createPostgresPromotionTargetExclusion({ pool, eventStore: store }),
          },
          referenceData: services.referenceData,
          profileVersions: services.providerIntegrationProfiles,
          rolloutControlPolicy: createCatalogIntegrationRolloutControlPolicyFromEnv({}),
          applyCandidateCommandAtVersion: async ({ candidateId, command, expectedVersion, context }) =>
            (
              await commands.commandHandler({
                streamId: catalogMergeCandidateStreamId(candidateId),
                command,
                expectedVersion,
                context,
              })
            ).state,
        },
        {
          candidateId,
          jobId: "job_sealed_extension",
          unitId: candidateId,
          approvalReason: "Reviewed synthetic sealed product.",
          context: testContext,
        },
      );
      expect(result).toMatchObject({ status: "promoted", appliedMode: "create" });
      const item = (await readCompleteStream(store, { streamId: `catalog.item-${result.appliedCatalogItemId}` }))
        .map(createPassthroughDomainEventCodec<CatalogItemEvent>().decode)
        .reduce(evolveCatalogItem, initialCatalogItemState);
      expect(item.status).toBe("draft");
      expect(item.externalCatalogItemReferences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ providerKey: "tcgplayer", externalKey: `product:${entry.detail.productId}` }),
        ]),
      );
    },
  );
  it("does not borrow a single-card mapping for a sealed observation", async () => {
    const pool = db();
    const { post } = await composeSealedProducts(pool);
    const entry = salvage.cases[0]!;
    await acceptSealedMapping(
      pool,
      entry.unitKey.replace(":sealed-product:", ":single-card:"),
      entry.detail.setName,
      entry.detail.productLineId,
    );
    expect(await (await post()).json()).toMatchObject({
      candidateCount: 0,
      exclusions: [{ productId: entry.detail.productId, code: "unmapped-provider-scope" }],
    });
    expect(
      (await pool.query("SELECT event_id FROM event_store_events WHERE stream_id LIKE 'catalog.merge-candidate-%'"))
        .rows,
    ).toEqual([]);
  });
});
