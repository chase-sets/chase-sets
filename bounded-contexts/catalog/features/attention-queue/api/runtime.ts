import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { listSourceObservationAliasCandidates } from "../../alias-equivalence/read-model/queries";
import { listProposedProviderScopeMappings } from "../../provider-scope-mapping/read-model/queries";
import { listStaleActiveCatalogScopeRecords } from "../../scope-registry/read-model/queries";
import { listCatalogMergeCandidates } from "../../source-observations/read-model/queries";
import { buildCatalogIntegrationControlPlaneOverview } from "../../source-observations/api/admin-control-plane-overview";
import type {
  CatalogIntegrationControlPlaneReadiness,
  SourceObservationIntegrationJob,
} from "../../source-observations/api/runtime";
import {
  decideCatalogAttentionDismissal,
  evolveCatalogAttentionDismissal,
  initialCatalogAttentionDismissalState,
  type CatalogAttentionDismissalCommand,
  type CatalogAttentionDismissalEvent,
  type CatalogAttentionDismissalState,
} from "../domain/dismissal";
import { buildCatalogAttentionDismissalProjectionHandlers } from "../read-model/dismissal-projection";
import { listActiveAttentionDismissalKeys } from "../read-model/dismissal-queries";
import { assembleCatalogAttentionQueue, type CatalogAttentionQueueReadModel } from "./contracts";

// The freshness window after which an unrefreshed active scope record counts as a
// stale provider sync. Two weeks keeps steady-state catalogs quiet while flagging
// genuinely abandoned syncs. Superseded by the scope-sync-state model.
export const CATALOG_ATTENTION_STALE_SCOPE_SYNC_MS = 14 * 24 * 60 * 60 * 1000;

// The already-computed control-plane inputs the attention queue folds in for its
// health and import-job sources. Injected from the source-observations runtime so
// the queue and the health-triage surface read the same readiness facts.
export type CatalogAttentionControlPlaneSources = Readonly<{
  getReadiness: () => Promise<CatalogIntegrationControlPlaneReadiness>;
  listActiveJobs: (input: { context: EventStoreContext }) => Promise<readonly SourceObservationIntegrationJob[]>;
}>;

export type CatalogAttentionQueueServices = Readonly<{
  catalogAttentionDismissalCommandHandler: CommandHandler<
    CatalogAttentionDismissalCommand,
    CatalogAttentionDismissalState,
    CatalogAttentionDismissalEvent
  >;
  getCatalogAttentionQueueReadModel: (input: {
    context: EventStoreContext;
    generatedAt?: string;
  }) => Promise<CatalogAttentionQueueReadModel>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCatalogAttentionQueueRuntime(
  deps: CatalogRuntimeDeps,
  controlPlane: CatalogAttentionControlPlaneSources,
): CatalogAttentionQueueServices {
  const { commandHandler: catalogAttentionDismissalCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CatalogAttentionDismissalEvent>(),
    initialState: () => initialCatalogAttentionDismissalState,
    evolve: evolveCatalogAttentionDismissal,
    decide: decideCatalogAttentionDismissal,
  });

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "catalog-attention-dismissal-projection",
      handlers: buildCatalogAttentionDismissalProjectionHandlers(deps.db),
    }),
  ];

  return {
    catalogAttentionDismissalCommandHandler,
    getCatalogAttentionQueueReadModel: async ({ context, generatedAt }) => {
      const now = generatedAt ?? new Date().toISOString();
      const staleBefore = new Date(Date.parse(now) - CATALOG_ATTENTION_STALE_SCOPE_SYNC_MS).toISOString();

      const [
        readiness,
        activeJobs,
        proposedScopeMappings,
        conflictCandidates,
        staleCandidates,
        pendingAliasCandidates,
        staleScopeRecords,
        dismissedItemKeys,
      ] = await Promise.all([
        controlPlane.getReadiness(),
        controlPlane.listActiveJobs({ context }),
        listProposedProviderScopeMappings(deps.db),
        listCatalogMergeCandidates(deps.db, { status: "has-conflicts", limit: 200 }),
        listCatalogMergeCandidates(deps.db, { status: "stale", limit: 200 }),
        listSourceObservationAliasCandidates(deps.db, { reviewStatuses: ["pending"], limit: 200 }),
        listStaleActiveCatalogScopeRecords(deps.db, { before: staleBefore }),
        listActiveAttentionDismissalKeys(deps.db, { now }),
      ]);

      const overview = buildCatalogIntegrationControlPlaneOverview({
        readiness,
        profiles: [],
        activeJobs,
        generatedAt: now,
        audience: "daily",
      });

      return assembleCatalogAttentionQueue(
        {
          proposedScopeMappings,
          mergeCandidates: [...conflictCandidates.items, ...staleCandidates.items],
          unitReadiness: readiness.units,
          unitActivity: overview.unitActivity.units,
          pendingAliasCandidates,
          staleScopeRecords,
        },
        { generatedAt: now, dismissedItemKeys },
      );
    },
    projectors,
  };
}
