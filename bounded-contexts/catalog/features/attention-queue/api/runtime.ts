import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { readPendingAliasCandidateAttentionWindow } from "../../alias-equivalence/read-model/queries";
import { readProposedProviderScopeMappingAttentionWindow } from "../../provider-scope-mapping/read-model/queries";
import { readStaleActiveCatalogScopeRecordAttentionWindow } from "../../scope-registry/read-model/queries";
import { CATALOG_SCOPE_STALE_SYNC_MS } from "../../scope-registry/domain/scope-row-status";
import { readCatalogMergeCandidateAttentionWindow } from "../../source-observations/read-model/queries";
import { buildCatalogIntegrationUnitActivity } from "../../source-observations/api/admin-control-plane-overview";
import type { CatalogIntegrationEngineServices, IntegrationJobServices } from "../../source-observations/api/runtime";
import {
  decideCatalogAttentionDismissal,
  evolveCatalogAttentionDismissal,
  initialCatalogAttentionDismissalState,
  type CatalogAttentionDismissalCommand,
  type CatalogAttentionDismissalEvent,
  type CatalogAttentionDismissalState,
} from "../domain/dismissal";
import {
  CATALOG_ATTENTION_SUMMARY_WINDOW,
  catalogAttentionKindWindow,
  type CatalogAttentionItemKind,
  type CatalogAttentionQueueWindow,
} from "../read-model/attention-item";
import { collectImportJobItems, collectProviderHealthItems } from "../read-model/collectors";
import { buildCatalogAttentionDismissalProjectionHandlers } from "../read-model/dismissal-projection";
import { listActiveAttentionDismissalKeys } from "../read-model/dismissal-queries";
import { assembleCatalogAttentionQueue, type CatalogAttentionQueueReadModel } from "./contracts";

// The freshness window after which an unrefreshed active scope record counts as a
// stale provider sync: the same window the Scope Record rows report as stale.
export const CATALOG_ATTENTION_STALE_SCOPE_SYNC_MS = CATALOG_SCOPE_STALE_SYNC_MS;

// The control-plane inputs the attention queue folds in for its health and
// import-job sources, injected from the source-observations runtime so the queue
// and the health-triage surface read the same readiness facts. The job source is
// the active-job snapshot with its completeness: the job store caps it, so an
// incomplete snapshot can only support a lower-bound job count.
export type CatalogAttentionControlPlaneSources = Readonly<{
  getReadiness: CatalogIntegrationEngineServices["getCatalogIntegrationControlPlaneReadiness"];
  listActiveJobSnapshot: NonNullable<IntegrationJobServices["listActiveIntegrationJobSnapshot"]>;
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
    window?: CatalogAttentionQueueWindow;
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

  // Readiness and the active-job snapshot, with the parked keys among the items
  // they produce. Only these items are observed in memory; every other source
  // excludes parked rows in SQL.
  async function readObservedControlPlane(context: EventStoreContext, now: string) {
    const [readiness, jobSnapshot] = await Promise.all([
      controlPlane.getReadiness(),
      controlPlane.listActiveJobSnapshot({ context }),
    ]);
    const unitActivity = buildCatalogIntegrationUnitActivity(readiness.units, jobSnapshot.items);
    const observedItemKeys = [
      ...collectProviderHealthItems(readiness.units, { generatedAt: now }),
      ...collectImportJobItems(unitActivity),
    ].map((item) => item.itemKey);
    const parkedObservedItemKeys = await listActiveAttentionDismissalKeys(deps.db, {
      now,
      itemKeys: observedItemKeys,
    });
    return { readiness, unitActivity, completeness: jobSnapshot.completeness, parkedObservedItemKeys };
  }

  return {
    catalogAttentionDismissalCommandHandler,
    getCatalogAttentionQueueReadModel: async ({ context, generatedAt, window = CATALOG_ATTENTION_SUMMARY_WINDOW }) => {
      const now = generatedAt ?? new Date().toISOString();
      const staleBefore = new Date(Date.parse(now) - CATALOG_ATTENTION_STALE_SCOPE_SYNC_MS).toISOString();
      const sourceWindow = (kind: CatalogAttentionItemKind) => ({ now, ...catalogAttentionKindWindow(window, kind) });

      const [observed, proposedScopeMappings, mergeCandidates, pendingAliasCandidates, staleScopeRecords] =
        await Promise.all([
          readObservedControlPlane(context, now),
          readProposedProviderScopeMappingAttentionWindow(deps.db, sourceWindow("unmapped-scope")),
          readCatalogMergeCandidateAttentionWindow(deps.db, sourceWindow("merge-conflict")),
          readPendingAliasCandidateAttentionWindow(deps.db, sourceWindow("alias-candidate")),
          readStaleActiveCatalogScopeRecordAttentionWindow(deps.db, {
            ...sourceWindow("stale-scope-sync"),
            before: staleBefore,
          }),
        ]);

      return assembleCatalogAttentionQueue(
        {
          proposedScopeMappings,
          mergeCandidates,
          unitReadiness: observed.readiness.units,
          importJobs: { unitActivity: observed.unitActivity, completeness: observed.completeness },
          pendingAliasCandidates,
          staleScopeRecords,
        },
        { generatedAt: now, parkedObservedItemKeys: observed.parkedObservedItemKeys, window },
      );
    },
    projectors,
  };
}
