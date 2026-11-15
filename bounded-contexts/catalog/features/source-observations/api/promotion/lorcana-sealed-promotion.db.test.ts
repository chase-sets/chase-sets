import { expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import {
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
} from "../../../catalog-items/domain/domain";
import {
  decideCatalogMergeCandidate,
  evolveCatalogMergeCandidate,
  initialCatalogMergeCandidateState,
  type CatalogMergeCandidateEvent,
} from "../../domain/catalog-merge-candidate";
import { applyCatalogMergeCandidatePromotion, loadCandidateApplication } from "./catalog-merge-candidate-application";
import { createPostgresPromotionTargetExclusion } from "./promotion-target-exclusion";
import { createCatalogIntegrationRolloutControlPolicyFromEnv } from "../governance/catalog-integration-rollout-controls";
import { catalogMergeCandidateStreamId } from "../source-observation-stream-identity";
import { createCatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import {
  TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_PRIOR_PROFILE_VERSION,
} from "../providers/tcgplayer/executable-mapping-contract";
import { describeDb, useOperatorSessionDatabase } from "../../../operator-session/tests/db-fixture";
import { composeSealedProducts, acceptSealedMapping } from "../../../operator-session/tests/sealed-product-db-fixture";
import { salvage, sealedPost } from "../../../operator-session/tests/sealed-product-observation-fixture";
import { testContext } from "../../../operator-session/tests/set-name-observation-fixture";

describeDb("TCGplayer Lorcana sealed promotion", () => {
  const db = useOperatorSessionDatabase("lorcana_sealed_promotion");

  it.each(["current", "prior"])(
    "applies the %s version's promotion eligibility to a real merge candidate",
    async (version) => {
      const pool = db();
      const { post, services, store } = await composeSealedProducts(pool);
      const entry = salvage.cases.find(
        (candidate) => candidate.unitKey === "tcgplayer:lorcana:sealed-product:source-observation-import",
      )!;
      const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
      if (version === "prior") {
        await profiles.activateProfileVersion("tcgplayer", TCGPLAYER_LORCANA_SEALED_PRODUCT_PRIOR_PROFILE_VERSION, {
          ingestionUnitKey: entry.unitKey,
        });
      }
      await acceptSealedMapping(pool, entry.unitKey, entry.detail.setName, entry.detail.productLineId);
      const response = await post({ ...sealedPost(), products: [entry.detail] });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ candidateCount: 1, exclusions: [] });
      const candidates = await pool.query<{ stream_id: string }>(
        "SELECT stream_id FROM event_store_events WHERE event_type = 'catalog.merge-candidate.created'",
      );
      expect(candidates.rows).toHaveLength(1);
      const candidateId = candidates.rows[0]!.stream_id.slice("catalog.merge-candidate-".length);
      const before = await loadCandidateApplication(store, candidateId);
      expect(before.state.snapshot?.membership[0]?.sourceProfileVersion).toBe(
        version === "prior"
          ? TCGPLAYER_LORCANA_SEALED_PRODUCT_PRIOR_PROFILE_VERSION
          : TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
      );
      if (version === "prior") await profiles.seedProfileVersions();
      const commands = createAggregateCommandHandler({
        eventStore: store,
        codec: createPassthroughDomainEventCodec<CatalogMergeCandidateEvent>(),
        initialState: () => initialCatalogMergeCandidateState,
        evolve: evolveCatalogMergeCandidate,
        decide: decideCatalogMergeCandidate,
      });
      const apply = () =>
        applyCatalogMergeCandidatePromotion(
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
            jobId: "job_lorcana_sealed",
            unitId: candidateId,
            approvalReason: "Reviewed synthetic Lorcana sealed product.",
            context: testContext,
          },
        );
      if (version === "prior") {
        await expect(apply()).rejects.toMatchObject({ code: "promotion-application-profile-revoked" });
        expect(await loadCandidateApplication(store, candidateId)).toEqual(before);
        expect(
          (await pool.query("SELECT event_id FROM event_store_events WHERE stream_id LIKE 'catalog.item-%'")).rows,
        ).toEqual([]);
        return;
      }
      const result = await apply();
      expect(result).toMatchObject({ status: "promoted", appliedMode: "create" });
      const item = (await readCompleteStream(store, { streamId: `catalog.item-${result.appliedCatalogItemId}` }))
        .map(createPassthroughDomainEventCodec<CatalogItemEvent>().decode)
        .reduce(evolveCatalogItem, initialCatalogItemState);
      expect(item).toMatchObject({
        status: "draft",
        blueprintId: catalogSeedIds.blueprints.lorcanaSealedProduct,
        categoryIds: [catalogSeedIds.categories.lorcanaSealedProducts],
      });
      expect(item.externalCatalogItemReferences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ providerKey: "tcgplayer", externalKey: `product:${entry.detail.productId}` }),
        ]),
      );
    },
  );
});
