import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedCatalogDatabase } from "../../../support/authoring-support/seed";
import { seedContext as context } from "../../../support/seed-support/context";
import type { CatalogItemId } from "../../../ids";
import fixture from "../api/__fixtures__/tcgdex/normal.json";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "../api/promotion/provider-source-observation-normalizer";
import {
  loadCatalogItemPromotionProfile,
  previewCatalogItemPromotionPlan,
  requireCatalogPromotionProfileVersion,
  requireCatalogItemPromotionObservation,
  requireSourceObservationMappingContract,
} from "../api/source-observation-promotion-execution";
import { resolvePromotionReferenceHierarchy } from "../api/source-observation-promotion-reference-hierarchy";
import { sourceObservationTargetId, type PromotionTargetKey } from "../api/promotion/promotion-target-identity";
import {
  createPostgresPromotionTargetExclusion,
  type PromotionTargetAuthority,
} from "../api/promotion/promotion-target-exclusion";

/**
 * Database lifecycle and helpers for the promotion target exclusion DB suite.
 * The suite is split across sibling files so Vitest runs them in parallel; each file
 * provisions its own per-context database and calls this inside its suite to get the
 * unchanged per-test reset, bootstrap and catalog-integration-bootstrap seed.
 */
export function usePromotionTargetExclusionFixture(
  provisionPool: () => Promise<PgTransactionalPool>,
  bind: (fresh: { pool: PgTransactionalPool; services: CatalogServices }) => void,
) {
  let pool: PgTransactionalPool;
  let services: CatalogServices;
  beforeAll(async () => {
    pool = await provisionPool();
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    await seedCatalogDatabase(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    services = createCatalogServices(pool);
    bind({ pool, services });
  });
  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  async function persistedMappingContract() {
    const identity = tcgdexPokemonCardSourceObservationMappingContract;
    const version = await services.providerIntegrationProfiles.getProfileVersion(
      identity.providerKey,
      identity.profileVersion,
      { profileKey: identity.profileKey },
    );
    if (!version) throw new Error("Seeded executable mapping profile is missing");
    return requireSourceObservationMappingContract(version);
  }

  async function record(id: string, reference = "product:synthetic-493958", overrides: Partial<typeof fixture> = {}) {
    const mapped = normalizeCatalogProviderSourceObservation({
      contract: await persistedMappingContract(),
      payload: {
        ...fixture,
        ...overrides,
        observationId: id,
        externalKey: id,
        sourceUrl: `https://synthetic.invalid/source/${id}`,
        externalCatalogItemReferences: [{ providerKey: "tcgplayer", externalKey: reference }],
      },
      observedAt: "2026-10-10T00:00:00.000Z",
    });
    expect(mapped.diagnostics).toEqual([]);
    if (!mapped.observation) throw new Error("Executable mapper did not produce an observation");
    await services.sourceObservations.commandHandler({
      streamId: `catalog.source-observation-${id}`,
      command: { type: "RecordSourceObservation", ...mapped.observation },
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.sourceObservations.projectors);
    return mapped.observation;
  }

  async function retainedPlan(id: string, reference?: string) {
    const observation = await record(id, reference);
    const normalized = requireCatalogItemPromotionObservation(observation.normalized, observation.providerKey);
    const profile = await requireCatalogPromotionProfileVersion(
      services.providerIntegrationProfiles,
      observation.providerKey,
      normalized,
    );
    const deps = {
      db: pool,
      eventStore: createPostgresEventStore({ pool }),
      checkpointStore: createPostgresProjectionStore({ db: pool }),
    };
    await resolvePromotionReferenceHierarchy({
      deps,
      referenceData: services.referenceData,
      profile: profile.profile,
      normalized,
      context,
    });
    await drainLocalProjectionHandlerSets("catalog", pool, services.referenceData.projectors);
    const targetId = sourceObservationTargetId(id) as CatalogItemId;
    const planned = await previewCatalogItemPromotionPlan({
      deps,
      catalogItemId: targetId,
      mode: "create",
      normalized,
      providerKey: observation.providerKey,
      externalKey: observation.externalKey,
      providerProfile: profile.profile,
      providerProfileVersion: profile,
      catalogMapping: await loadCatalogItemPromotionProfile(deps, profile.profile),
      promoteAsDraft: false,
    });
    if (planned.status !== "planned") throw new Error(JSON.stringify(planned.diagnostics));
    return { targetId, plan: planned.plan, observation, normalized, profile, deps };
  }

  async function itemCreations() {
    return (
      await pool.query<{ stream_id: string }>(
        "SELECT stream_id FROM event_store_events WHERE event_type = 'catalog.catalog-item.created' ORDER BY stream_id",
      )
    ).rows;
  }

  function boundary() {
    return createPostgresPromotionTargetExclusion({ pool, eventStore: createPostgresEventStore({ pool }) });
  }

  function acquire(
    targetId: string,
    keys: readonly PromotionTargetKey[],
    validateAuthority: PromotionTargetAuthority = async () => undefined,
  ) {
    return boundary().acquire({
      keys,
      additionalTargetIds: [targetId],
      context,
      validateAuthority,
      selectTarget: async () => targetId,
    });
  }

  return { persistedMappingContract, record, retainedPlan, itemCreations, boundary, acquire };
}
