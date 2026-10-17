import { describe, expect, it } from "vitest";
import { drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext as context } from "../../../support/seed-support/context";
import type { BlueprintId, CatalogItemId, DimensionId, OptionId } from "../../../ids";
import { evolveBlueprint, initialBlueprintState, type BlueprintEvent } from "../../blueprints/domain/domain";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import productFixture from "../api/__fixtures__/tcgplayer-pokemon-sealed-product/normal.json";
import { tcgplayerPokemonSealedProductSourceObservationMappingContract } from "../api/providers/tcgplayer/executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
import { normalizeProductAssetSet } from "../api/seeding/product-asset-normalization";
import {
  loadCatalogItemPromotionProfile,
  previewCatalogItemPromotionPlan,
  requireCatalogPromotionProfileVersion,
  requireCatalogItemPromotionObservation,
  requireSourceObservationMappingContract,
} from "../api/source-observation-promotion-execution";
import { createPostgresPromotionTargetExclusion } from "../api/promotion/promotion-target-exclusion";
import { promotionTargetBindingStream } from "../api/promotion/promotion-target-identity";
import { trackPromotionProfileAuthority } from "../api/promotion/promotion-profile-authority";
import { createCatalogProviderIntegrationProfileVersionStore } from "../api/providers/provider-integration-profile-store";
import { resetCatalogIntegrationPreLaunchData } from "../api/governance/catalog-integration-data-migration-reset";
import { promotionCurrentItem } from "../api/promotion/source-observation-target-exclusion";
import { guardPromotionMaterial } from "../api/promotion/promotion-material-guards";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { usePromotionTargetExclusionFixture } from "./promotion-target-exclusion-fixture";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for promotion target exclusion DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("promotion target exclusion through real Catalog services", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  const { record, retainedPlan, itemCreations, boundary, acquire } = usePromotionTargetExclusionFixture(
    async () => {
      const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "promotion_target_exclusion");
      await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
      return createMultiContextTestPools(urls).catalog;
    },
    (fresh) => {
      ({ pool, services } = fresh);
    },
  );

  it.each(["edit", "revoke", "selection"])(
    "reads canonical profile %s after obtaining the write barrier",
    async (mutation) => {
      const observation = await record(`profile-${mutation}`);
      const normalized = requireCatalogItemPromotionObservation(observation.normalized, observation.providerKey);
      const selected = await requireCatalogPromotionProfileVersion(
        services.providerIntegrationProfiles,
        observation.providerKey,
        normalized,
      );
      const authority = trackPromotionProfileAuthority(services.providerIntegrationProfiles, selected, (reader) =>
        requireCatalogPromotionProfileVersion(reader, observation.providerKey, normalized),
      );
      const canonical = createCatalogProviderIntegrationProfileVersionStore(pool);
      if (mutation === "edit")
        await canonical.upsertProfileVersion({
          ...selected,
          profile: {
            ...selected.profile,
            catalogFieldMapping: {
              ...selected.profile.catalogFieldMapping,
              blueprintKey: "synthetic-changed-blueprint",
            },
          },
        });
      else if (mutation === "selection")
        await canonical.upsertProfileVersion({ ...selected, profileVersion: "synthetic-new-active-version" });
      else await canonical.upsertProfileVersion({ ...selected, active: false, lifecycle: "deprecated" });
      const pending = acquire(
        `cat_candidate_${mutation}`,
        [{ level: "item", providerKey: "synthetic", externalKey: mutation }],
        authority.validate,
      );
      await expect(pending).rejects.toThrow();
      expect(
        await readCompleteStream(createPostgresEventStore({ pool }), {
          streamId: `catalog.item-cat_candidate_${mutation}`,
        }),
      ).toEqual([]);
    },
  );

  it("holds the profile write barrier through guarded append and releases it at commit", async () => {
    await acquire(
      "cat_candidate_profile_barrier",
      [{ level: "item", providerKey: "synthetic", externalKey: "profile-barrier" }],
      async () => {
        const writer = await pool.connect();
        try {
          await writer.query("BEGIN");
          await expect(
            writer.query("LOCK TABLE catalog_provider_integration_profile_versions IN ROW EXCLUSIVE MODE NOWAIT"),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await writer.query("ROLLBACK");
          writer.release();
        }
      },
    );
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      await expect(
        writer.query("LOCK TABLE catalog_provider_integration_profile_versions IN ROW EXCLUSIVE MODE NOWAIT"),
      ).resolves.toBeDefined();
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
    }
  });

  it.each(["seed", "authoring", "reset"].flatMap((writer) => [false, true].map((rollback) => ({ writer, rollback }))))(
    "$writer waits for the real promotion SHARE fence, rollback=$rollback",
    async ({ writer, rollback }) => {
      const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
      const selected = (await profiles.listProfileVersions("tcgdex"))[0];
      let mutation: Promise<unknown> | undefined;
      let settled = false;
      const operation = acquire(
        "cat_candidate_barrier",
        [{ level: "item", providerKey: "synthetic", externalKey: "barrier" }],
        async (client) => {
          expect(
            (await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation")).rows[0]
              .transaction_isolation,
          ).toBe("read committed");
          mutation =
            writer === "seed"
              ? profiles.seedProfileVersions([selected])
              : writer === "authoring"
                ? profiles.upsertProfileVersion(selected)
                : resetCatalogIntegrationPreLaunchData(pool, { rebuildSeedProfiles: false });
          void mutation.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          const deadline = Date.now() + 30000;
          let blocked = false;
          while (Date.now() < deadline) {
            const locks = await pool.query<{ granted: boolean }>(
              "SELECT granted FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='catalog_provider_integration_profile_versions'::regclass AND mode='RowExclusiveLock' AND NOT granted",
            );
            if (locks.rows.length) {
              blocked = true;
              break;
            }
            if (settled) break;
          }
          expect(blocked).toBe(true);
          expect(settled).toBe(false);
          if (rollback) throw new Error("synthetic-profile-rollback");
        },
      );
      try {
        if (rollback) await expect(operation).rejects.toThrow("synthetic-profile-rollback");
        else await expect(operation).resolves.toMatchObject({ targetId: "cat_candidate_barrier" });
      } finally {
        await mutation;
      }
      expect(settled).toBe(true);
      if (rollback)
        expect(
          await readCompleteStream(createPostgresEventStore({ pool }), {
            streamId: promotionTargetBindingStream({ level: "item", providerKey: "synthetic", externalKey: "barrier" }),
          }),
        ).toEqual([]);
    },
  );

  it.each(["old-worker", "missing-method", "function-drift"])(
    "refuses activation for %s and preserves retained readers",
    async (skew) => {
      await record("activation-source");
      const eventStore = createPostgresEventStore({ pool });
      const before = await readCompleteStream(eventStore, { streamId: "catalog.source-observation-activation-source" });
      if (skew === "function-drift")
        await pool.query("ALTER FUNCTION catalog_promotion_reference_text_v1(text) VOLATILE");
      const oldStore =
        skew === "missing-method"
          ? new Proxy(eventStore, {
              get(target, key) {
                return key === "appendToStreamsInTransaction" ? undefined : Reflect.get(target, key, target);
              },
            })
          : eventStore;
      const port = createPostgresPromotionTargetExclusion({
        pool,
        eventStore: oldStore,
        writerProtocol: skew === "old-worker" ? "promotion-target/v1" : "promotion-target/v2",
      });
      await expect(
        port.acquire({
          keys: [{ level: "member", observationId: "activation-source" }],
          additionalTargetIds: ["cat_candidate_activation"],
          context,
          validateAuthority: async () => undefined,
          selectTarget: async () => "cat_candidate_activation",
        }),
      ).rejects.toThrow(
        skew === "old-worker"
          ? "promotion-target-writer-protocol-incompatible"
          : skew === "missing-method"
            ? "promotion-target-transaction-append-unavailable"
            : "promotion-target-access-paths-unavailable",
      );
      expect(
        await readCompleteStream(eventStore, { streamId: "catalog.source-observation-activation-source" }),
      ).toEqual(before);
      expect(await itemCreations()).toHaveLength(0);
    },
  );

  it.each(["A", "B"])(
    "independent runtimes preserve one target under frozen item projections, %s first",
    async (first) => {
      await record("A", "PRODUCT:SYNTHETIC-493958");
      await record("B");
      const other = createCatalogServices(pool);
      const winner = await services.sourceObservations.promoteObservation({ observationId: first, context });
      const reused = await other.sourceObservations.promoteObservation({
        observationId: first === "A" ? "B" : "A",
        context,
      });
      expect(reused.catalogItemId).toBe(winner.catalogItemId);
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each(["source", "shared-port"] as const)(
    "real Source Observation and shared-port consumers converge with %s first and frozen item projections",
    async (first) => {
      const retained = await retainedPlan("cross-source");
      const candidate = await record("cross-candidate");
      const normalized = requireCatalogItemPromotionObservation(candidate.normalized, candidate.providerKey);
      const mapping = await loadCatalogItemPromotionProfile(retained.deps, retained.profile.profile);
      const before = (await pool.query("SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id")).rows;
      const source = () =>
        createCatalogServices(pool).sourceObservations.promoteObservation({ observationId: "cross-source", context });
      const shared = async () => {
        const authority = trackPromotionProfileAuthority(
          services.providerIntegrationProfiles,
          retained.profile,
          (reader) => requireCatalogPromotionProfileVersion(reader, candidate.providerKey, normalized),
        );
        const session = await boundary().acquire({
          keys: [{ level: "member", observationId: "cross-candidate" }],
          additionalTargetIds: ["cat_candidate_cross"],
          context,
          validateAuthority: authority.validate,
          selectTarget: async (evidence) => {
            const owners = [
              ...new Set([...evidence.bindings.values()].flatMap((binding) => (binding ? [binding.targetId] : []))),
            ];
            if (owners.length > 1) throw new Error("synthetic-ambiguous-owner");
            return owners[0] ?? "cat_candidate_cross";
          },
        });
        await guardPromotionMaterial({
          deps: retained.deps,
          session,
          profile: retained.profile.profile,
          mapping,
          normalized,
        });
        const item = session.evidence.items.get(session.targetId)!;
        const plan = await previewCatalogItemPromotionPlan({
          deps: retained.deps,
          catalogItemId: session.targetId as CatalogItemId,
          mode: item.id ? "refresh" : "create",
          currentItem: promotionCurrentItem(item),
          normalized,
          providerKey: candidate.providerKey,
          externalKey: candidate.externalKey,
          providerProfile: retained.profile.profile,
          providerProfileVersion: retained.profile,
          catalogMapping: mapping,
          promoteAsDraft: false,
        });
        if (plan.status !== "planned") throw new Error(JSON.stringify(plan.diagnostics));
        const completed = await session.preparePlan(plan.plan);
        for (const command of plan.plan.commands.slice(completed))
          await session.commandHandler({ streamId: `catalog.item-${session.targetId}`, command, context });
        return { catalogItemId: session.targetId };
      };
      const winner = await (first === "source" ? source() : shared());
      const reused = await (first === "source" ? shared() : source());
      expect(reused.catalogItemId).toBe(winner.catalogItemId);
      expect(await itemCreations()).toHaveLength(1);
      expect((await pool.query("SELECT catalog_item_id FROM catalog_items ORDER BY catalog_item_id")).rows).toEqual(
        before,
      );
    },
  );

  it.each(["A", "B"].flatMap((first) => [false, true].map((conflict) => ({ first, conflict }))))(
    "promotable mapper Product Options, $first first, conflict=$conflict, with normally published draft blueprint",
    async ({ first, conflict }) => {
      const identity = tcgplayerPokemonSealedProductSourceObservationMappingContract;
      const seeded = await services.providerIntegrationProfiles.getProfileVersion(
        identity.providerKey,
        identity.profileVersion,
        { profileKey: identity.profileKey },
      );
      if (!seeded) throw new Error("Missing sealed-product profile");
      const store = createPostgresEventStore({ pool });
      const blueprint = (
        await readCompleteStream(store, {
          streamId: `catalog.blueprint-${catalogSeedIds.blueprints.pokemonSealedProduct}`,
        })
      )
        .map(createPassthroughDomainEventCodec<BlueprintEvent>().decode)
        .reduce(evolveBlueprint, initialBlueprintState);
      const blueprintId = "bpr_synthetic_promotion_options" as BlueprintId;
      const blueprintKey = "synthetic-promotion-options";
      const dimensionId = catalogSeedIds.dimensions.condition.dimensionId as DimensionId;
      const optionId = catalogSeedIds.dimensions.condition.optionIds.nearMint as OptionId;
      const otherOptionId = catalogSeedIds.dimensions.condition.optionIds.good as OptionId;
      const streamId = `catalog.blueprint-${blueprintId}`;
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: {
          type: "CreateBlueprint",
          blueprintId,
          key: blueprintKey,
          name: { defaultLocale: "en", values: { en: "Synthetic Options fixture" } },
        },
      });
      for (const componentId of blueprint.componentIds)
        await services.blueprints.commandHandler({
          streamId,
          context,
          command: { type: "AttachComponentToBlueprint", componentId },
        });
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: { type: "SetBlueprintFields", fieldRules: blueprint.fieldRules },
      });
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: {
          type: "SetBlueprintDimensions",
          dimensionRules: [
            ...blueprint.dimensionRules.filter((rule) => rule.dimensionId !== dimensionId),
            { dimensionId, required: false, allowedOptionIds: [optionId, otherOptionId] },
          ],
        },
      });
      await services.blueprints.commandHandler({
        streamId,
        context,
        command: {
          type: "SetBlueprintProductResolutionRules",
          canonicalDimensionOrder: [...blueprint.canonicalDimensionOrder, dimensionId],
        },
      });
      await services.blueprints.commandHandler({ streamId, context, command: { type: "PublishBlueprint" } });
      await drainLocalProjectionHandlerSets("catalog", pool, services.blueprints.projectors);
      const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
      const profileVersion = "synthetic-options-v1";
      await profiles.upsertProfileVersion({
        ...seeded,
        profileVersion,
        lifecycle: "draft",
        active: false,
        profile: { ...seeded.profile, catalogFieldMapping: { ...seeded.profile.catalogFieldMapping, blueprintKey } },
        executableMappingContract: {
          ...requireSourceObservationMappingContract(seeded),
          profileVersion,
          lifecycle: "draft",
        },
      });
      const profile = await profiles.activateProfileVersion(seeded.providerKey, profileVersion, {
        profileKey: seeded.profileKey,
      });
      for (const member of ["A", "B"]) {
        const externalKey = member === "A" ? "synthetic-800001" : "synthetic-800002";
        const selectedOptions = [{ dimensionId, optionId: conflict && member !== first ? otherOptionId : optionId }];
        const mapped = normalizeCatalogProviderSourceObservation({
          contract: requireSourceObservationMappingContract(profile),
          payload: {
            ...productFixture,
            observationId: `options-${member}`,
            externalKey,
            sourceUrl: `https://synthetic.invalid/options/${member}`,
            externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: `product:${externalKey}` }],
            externalProductReferences: [
              { providerKey: "tcgplayer", externalKey: "sku:synthetic-shared", selectedOptions },
            ],
          },
          observedAt: "2026-10-11T00:00:00.000Z",
        });
        expect(mapped.diagnostics).toEqual([]);
        if (!mapped.observation) throw new Error("Promotable Options fixture did not map");
        expect(
          requireCatalogItemPromotionObservation(mapped.observation.normalized, mapped.observation.providerKey)
            .externalProductReferences,
        ).toEqual([{ providerKey: "tcgplayer", externalKey: "sku:synthetic-shared", selectedOptions }]);
        await services.sourceObservations.commandHandler({
          streamId: `catalog.source-observation-options-${member}`,
          context,
          command: { type: "RecordSourceObservation", ...mapped.observation },
        });
      }
      await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
      const winner = await services.sourceObservations.promoteObservation({
        observationId: `options-${first}`,
        context,
        promoteAsDraft: true,
      });
      const before = await readCompleteStream(store, { streamId: `catalog.item-${winner.catalogItemId}` });
      const incoming = createCatalogServices(pool).sourceObservations.promoteObservation({
        observationId: `options-${first === "A" ? "B" : "A"}`,
        context,
        promoteAsDraft: true,
      });
      if (conflict) {
        await expect(incoming).rejects.toThrow("promotion-target-product-options-conflict");
        expect(await readCompleteStream(store, { streamId: `catalog.item-${winner.catalogItemId}` })).toEqual(before);
      } else await expect(incoming).resolves.toMatchObject({ catalogItemId: winner.catalogItemId });
      expect(await itemCreations()).toHaveLength(1);
    },
  );

  it.each(["asset", "multiple-profiles", "explicit-draft"] as const)(
    "reconstructs retained %s plans before reusing their target",
    async (scenario) => {
      const retained = await retainedPlan("reconstruction-A");
      const productAssetSet =
        scenario === "asset"
          ? await normalizeProductAssetSet({
              sourceBody: new Uint8Array(
                Buffer.from(
                  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAYAAADkOT91AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGMQCVjwHxkz0EIAAHp5MEltiCNbAAAAAElFTkSuQmCC",
                  "base64",
                ),
              ),
              sourceContentType: "image/png",
              sourceProviderKey: "tcgdex",
              sourceUrl: "https://synthetic.invalid/image.png",
              storageBaseKey: `synthetic/${retained.targetId}`,
              generatedAt: retained.observation.observedAt,
              assetStorage: { putObject: async ({ key }) => ({ key, publicUrl: `https://synthetic.invalid/${key}` }) },
            })
          : null;
      const result = await previewCatalogItemPromotionPlan({
        deps: retained.deps,
        catalogItemId: retained.targetId,
        mode: "create",
        normalized: retained.normalized,
        providerKey: retained.observation.providerKey,
        externalKey: retained.observation.externalKey,
        providerProfile: retained.profile.profile,
        providerProfileVersion: retained.profile,
        catalogMapping: await loadCatalogItemPromotionProfile(retained.deps, retained.profile.profile),
        productAssetSet,
        promoteAsDraft: scenario === "explicit-draft",
      });
      if (result.status !== "planned") throw new Error(JSON.stringify(result.diagnostics));
      for (const command of result.plan.commands)
        await services.items.commandHandler({ streamId: `catalog.item-${retained.targetId}`, command, context });
      await services.sourceObservations.commandHandler({
        streamId: "catalog.source-observation-reconstruction-A",
        context,
        command: {
          type: "PromoteSourceObservation",
          catalogItemId: retained.targetId,
          promotedAt: "2026-10-11T00:00:00.000Z",
          promotionProfileKey: retained.profile.profileKey,
          promotionProfileVersion: retained.profile.profileVersion,
          promotionPlanFingerprint: result.plan.planFingerprint,
        },
      });
      if (scenario === "multiple-profiles") {
        const profiles = createCatalogProviderIntegrationProfileVersionStore(pool);
        const profileVersion = "synthetic-next-version";
        await profiles.upsertProfileVersion({
          ...retained.profile,
          profileVersion,
          active: false,
          lifecycle: "draft",
          executableMappingContract: {
            ...requireSourceObservationMappingContract(retained.profile),
            profileVersion,
            lifecycle: "draft",
          },
        });
        await profiles.activateProfileVersion(retained.profile.providerKey, profileVersion, {
          profileKey: retained.profile.profileKey,
        });
      }
      await record("reconstruction-B");
      const store = createPostgresEventStore({ pool });
      const prefix = await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` });
      await expect(
        createCatalogServices(pool).sourceObservations.promoteObservation({
          observationId: "reconstruction-B",
          context,
        }),
      ).resolves.toMatchObject({ catalogItemId: retained.targetId });
      expect(
        (await readCompleteStream(store, { streamId: `catalog.item-${retained.targetId}` })).slice(0, prefix.length),
      ).toEqual(prefix);
      expect(await itemCreations()).toHaveLength(1);
    },
  );
});
