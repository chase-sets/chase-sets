import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  providerScopeMappingStreamId,
  type ProviderScopeMappingCommand,
  type ProviderScopeMappingEvent,
  type ProviderScopeMappingState,
} from "../../provider-scope-mapping/domain/domain";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../../source-observations/api/provider-integration-profiles";
import type { CatalogProviderOptionQueryPage } from "../../source-observations/api/provider-option-query-cache";
import { listProviderScopeDiscoveryTargets, type ProviderScopeDiscoveryTarget } from "./discovery-targets";
import {
  getProviderRefreshCadence,
  PROVIDER_REFRESH_CADENCE_CONFIG,
  type ProviderRefreshCadenceConfig,
} from "./provider-refresh-cadence";
import {
  claimDueProviderRefreshes,
  getProviderRefreshSchedule,
  listProviderRefreshSchedules,
  listProviderScopeObservations,
  reconcileProviderRefreshSchedules,
  recordProviderRefreshRun,
  setProviderRefreshPaused,
  upsertProviderScopeObservations,
  type ProviderRefreshScheduleRecord,
  type ProviderScopeObservationInput,
  type ProviderScopeObservationRecord,
} from "./refresh-schedule-store";
import {
  listCanonicalScopeRecordProposals,
  type CanonicalScopeRecordProposalRecord,
  type CanonicalScopeRecordProposalReviewStatus,
} from "./scope-record-proposal-store";
import {
  classifyProviderScopeDiscoveryTarget,
  matchScopeObservationsToScopeRecords,
  resolveProviderScopeDiscoveryCascadeParent,
} from "./scope-observation-matcher";

export type ProviderScopeRefreshProviderResult = Readonly<{
  providerKey: string;
  status: "succeeded" | "failed" | "skipped-no-targets";
  observationCount: number;
  newObservationCount: number;
  mappingsProposed: number;
  errorMessage: string | null;
}>;

export type ProviderScopeRefreshSummary = Readonly<{
  scanId: string;
  providersDue: number;
  providers: readonly ProviderScopeRefreshProviderResult[];
  observationsRecorded: number;
  mappingsProposed: number;
  failures: number;
}>;

export type ProviderScopeDiscoveryPorts = Readonly<{
  listProfileVersions: () => Promise<readonly CatalogProviderIntegrationProfileVersionRecord[]>;
  queryIntegrationOptions: (input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
    cursor?: string | null;
    limit?: number | null;
    forceRefresh?: boolean | null;
    cacheOnly?: boolean | null;
  }) => Promise<CatalogProviderOptionQueryPage>;
  providerScopeMappingCommandHandler: CommandHandler<
    ProviderScopeMappingCommand,
    ProviderScopeMappingState,
    ProviderScopeMappingEvent
  >;
}>;

export type ProviderScopeDiscoveryServices = Readonly<{
  processScheduledRefresh: (input: {
    context: EventStoreContext;
    now?: Date;
    triggeredBy?: string;
  }) => Promise<ProviderScopeRefreshSummary>;
  runProviderRefreshNow: (input: {
    providerKey: string;
    context: EventStoreContext;
    triggeredBy?: string;
  }) => Promise<ProviderScopeRefreshProviderResult>;
  listRefreshSchedules: () => Promise<readonly ProviderRefreshScheduleRecord[]>;
  setRefreshPaused: (input: {
    providerKey: string;
    paused: boolean;
    actor: string;
    reason?: string | null;
  }) => Promise<ProviderRefreshScheduleRecord | null>;
  listScopeObservations: (
    input?: Readonly<{
      providerKey?: string | null;
      unitKey?: string | null;
      scopeKind?: ProviderScopeObservationRecord["scopeKind"] | null;
      limit?: number;
    }>,
  ) => Promise<readonly ProviderScopeObservationRecord[]>;
  listCanonicalScopeRecordProposals: (
    input?: Readonly<{
      reviewStatus?: CanonicalScopeRecordProposalReviewStatus | null;
      productDomain?: CanonicalScopeRecordProposalRecord["productDomain"] | null;
      limit?: number;
    }>,
  ) => Promise<readonly CanonicalScopeRecordProposalRecord[]>;
}>;

const SCHEDULED_ACTOR = "system:scheduled-provider-scope-refresh";
const MAX_OPTION_PAGES_PER_TARGET = 25;

export function createProviderScopeDiscoveryRuntime(
  deps: CatalogRuntimeDeps,
  ports: ProviderScopeDiscoveryPorts,
  cadenceConfig: readonly ProviderRefreshCadenceConfig[] = PROVIDER_REFRESH_CADENCE_CONFIG,
): ProviderScopeDiscoveryServices {
  const db = deps.db;

  async function refreshProvider(input: {
    providerKey: string;
    targets: readonly ProviderScopeDiscoveryTarget[];
    scanId: string;
    context: EventStoreContext;
    triggeredBy: string;
    now: Date;
  }): Promise<ProviderScopeRefreshProviderResult> {
    if (input.targets.length === 0) {
      await recordProviderRefreshRun(db, {
        providerKey: input.providerKey,
        status: "skipped-no-targets",
        observationCount: 0,
        triggeredBy: input.triggeredBy,
      });
      return {
        providerKey: input.providerKey,
        status: "skipped-no-targets",
        observationCount: 0,
        newObservationCount: 0,
        mappingsProposed: 0,
        errorMessage: null,
      };
    }

    try {
      let observationCount = 0;
      let newObservationCount = 0;
      let mappingsProposed = 0;
      const currentScanObservations = new Map<string, ProviderScopeObservationRecord[]>();
      const pendingTargets: Array<
        Readonly<{
          target: ProviderScopeDiscoveryTarget;
          observations: readonly ProviderScopeObservationInput[];
        }>
      > = [];
      const durableObservationIdentities = new Set<string>();

      for (const target of input.targets) {
        let parentValue: string | null = null;
        if (target.parentRequired) {
          const parentObservations = target.parentScope
            ? (currentScanObservations.get(currentScanKey(target, target.parentScope)) ?? [])
            : [];
          const parent = await resolveProviderScopeDiscoveryCascadeParent(db, { target, parentObservations });
          if (!parent) {
            continue;
          }
          parentValue = parent.parentValue;
        }

        const options = await collectTargetOptions(ports, target, parentValue);
        assertUniqueDurableObservationIdentities(options, durableObservationIdentities);
        pendingTargets.push({ target, observations: options });
        const scanKey = currentScanKey(target, target.providerScope);
        currentScanObservations.set(scanKey, [
          ...(currentScanObservations.get(scanKey) ?? []),
          ...options.map((option) => stagedObservationRecord(option, input.scanId, input.now)),
        ]);
      }

      for (const pending of pendingTargets) {
        const written = await upsertProviderScopeObservations(db, {
          scanId: input.scanId,
          scannedAt: input.now,
          observations: pending.observations,
        });
        observationCount += written.length;
        newObservationCount += written.filter((record) => record.newlyObserved).length;
        mappingsProposed += await proposeMappingsForTarget({
          db,
          ports,
          target: pending.target,
          written,
          scanId: input.scanId,
          context: input.context,
        });
      }

      await recordProviderRefreshRun(db, {
        providerKey: input.providerKey,
        status: "succeeded",
        observationCount,
        triggeredBy: input.triggeredBy,
      });
      return {
        providerKey: input.providerKey,
        status: "succeeded",
        observationCount,
        newObservationCount,
        mappingsProposed,
        errorMessage: null,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Provider scope refresh failed.";
      await recordProviderRefreshRun(db, {
        providerKey: input.providerKey,
        status: "failed",
        observationCount: 0,
        errorMessage,
        triggeredBy: input.triggeredBy,
      });
      return {
        providerKey: input.providerKey,
        status: "failed",
        observationCount: 0,
        newObservationCount: 0,
        mappingsProposed: 0,
        errorMessage,
      };
    }
  }

  return {
    async processScheduledRefresh(input) {
      const now = input.now ?? new Date();
      const triggeredBy = input.triggeredBy ?? "schedule";
      const scanId = createId("job");

      await reconcileProviderRefreshSchedules(db, cadenceConfig);
      const due = await claimDueProviderRefreshes(db, { now });
      if (due.length === 0) {
        return {
          scanId,
          providersDue: 0,
          providers: [],
          observationsRecorded: 0,
          mappingsProposed: 0,
          failures: 0,
        };
      }

      const targetsByProvider = groupTargetsByProvider(await ports.listProfileVersions());
      const providers: ProviderScopeRefreshProviderResult[] = [];
      for (const schedule of due) {
        providers.push(
          await refreshProvider({
            providerKey: schedule.providerKey,
            targets: targetsByProvider.get(schedule.providerKey) ?? [],
            scanId,
            context: input.context,
            triggeredBy,
            now,
          }),
        );
      }

      return {
        scanId,
        providersDue: due.length,
        providers,
        observationsRecorded: providers.reduce((sum, provider) => sum + provider.observationCount, 0),
        mappingsProposed: providers.reduce((sum, provider) => sum + provider.mappingsProposed, 0),
        failures: providers.filter((provider) => provider.status === "failed").length,
      };
    },

    async runProviderRefreshNow(input) {
      const providerKey = input.providerKey.trim().toLowerCase();
      const now = new Date();
      const scanId = createId("job");
      await reconcileProviderRefreshSchedules(db, cadenceConfig);

      const targetsByProvider = groupTargetsByProvider(await ports.listProfileVersions());
      const result = await refreshProvider({
        providerKey,
        targets: targetsByProvider.get(providerKey) ?? [],
        scanId,
        context: input.context,
        triggeredBy: input.triggeredBy ?? "manual",
        now,
      });

      // A manual run also settles the next scheduled slot so an operator
      // kicking a provider does not cause a double pull moments later.
      const cadence = getProviderRefreshCadence(providerKey, cadenceConfig);
      await db.query(
        `UPDATE catalog_provider_refresh_schedule
         SET next_run_at = $2::timestamptz + make_interval(secs => $3 / 1000.0),
             last_run_started_at = $2::timestamptz,
             updated_at = now()
         WHERE provider_key = $1`,
        [providerKey, now.toISOString(), cadence.intervalMs],
      );

      return result;
    },

    listRefreshSchedules: async () => {
      await reconcileProviderRefreshSchedules(db, cadenceConfig);
      return listProviderRefreshSchedules(db);
    },

    setRefreshPaused: async (input) => {
      await reconcileProviderRefreshSchedules(db, cadenceConfig);
      const existing = await getProviderRefreshSchedule(db, input.providerKey);
      if (!existing) {
        return null;
      }
      return setProviderRefreshPaused(db, input);
    },

    listScopeObservations: (input = {}) => listProviderScopeObservations(db, input),
    listCanonicalScopeRecordProposals: (input = {}) => listCanonicalScopeRecordProposals(db, input),
  };
}

function groupTargetsByProvider(
  profileVersions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): ReadonlyMap<string, readonly ProviderScopeDiscoveryTarget[]> {
  const grouped = new Map<string, ProviderScopeDiscoveryTarget[]>();
  for (const target of listProviderScopeDiscoveryTargets(profileVersions, classifyProviderScopeDiscoveryTarget)) {
    const bucket = grouped.get(target.providerKey);
    if (bucket) {
      bucket.push(target);
    } else {
      grouped.set(target.providerKey, [target]);
    }
  }
  return grouped;
}

async function collectTargetOptions(
  ports: ProviderScopeDiscoveryPorts,
  target: ProviderScopeDiscoveryTarget,
  parentValue: string | null,
): Promise<readonly ProviderScopeObservationInput[]> {
  const observations: ProviderScopeObservationInput[] = [];
  let cursor: string | null = null;

  for (let pageIndex = 0; pageIndex < MAX_OPTION_PAGES_PER_TARGET; pageIndex += 1) {
    const page = await ports.queryIntegrationOptions({
      providerKey: target.providerKey,
      profileKey: target.profileKey,
      ingestionUnitKey: target.ingestionUnitKey,
      queryKind: target.queryKind,
      languageCode: target.languageCode,
      parentValue,
      cursor,
      forceRefresh: pageIndex === 0,
    });

    for (const item of page.items) {
      if (target.parentRequired && item.parentValue && item.parentValue !== parentValue) {
        continue;
      }
      observations.push({
        providerKey: target.providerKey,
        unitKey: target.ingestionUnitKey,
        scopeKind: target.scopeKind,
        sourceQueryKind: target.queryKind,
        languageCode: target.languageCode,
        externalId: item.value,
        label: item.label,
        parents: target.parentRequired && parentValue ? [parentValue] : item.parentValue ? [item.parentValue] : [],
        imageUrl: item.imageUrl,
        metadata: item.metadata,
      });
    }

    if (!page.page.hasMore || !page.page.nextCursor) {
      break;
    }
    cursor = page.page.nextCursor;
  }

  return observations;
}

function assertUniqueDurableObservationIdentities(
  observations: readonly ProviderScopeObservationInput[],
  seenIdentities: Set<string>,
): void {
  for (const observation of observations) {
    const identity = durableObservationIdentity(observation);
    if (seenIdentities.has(identity)) {
      throw new Error(`Duplicate Provider Scope Observation identity '${identity}'.`);
    }
    seenIdentities.add(identity);
  }
}

function durableObservationIdentity(observation: ProviderScopeObservationInput): string {
  return JSON.stringify(normalizedDurableObservationIdentity(observation));
}

function normalizedDurableObservationIdentity(
  observation: ProviderScopeObservationInput,
): readonly [string, string, ProviderScopeObservationInput["scopeKind"], string, string] {
  return [
    observation.providerKey.trim().toLowerCase(),
    observation.unitKey.trim().toLowerCase(),
    observation.scopeKind,
    observation.languageCode.trim().toLowerCase(),
    observation.externalId.trim(),
  ];
}

function stagedObservationRecord(
  observation: ProviderScopeObservationInput,
  scanId: string,
  scannedAt: Date,
): ProviderScopeObservationRecord {
  const [providerKey, unitKey, scopeKind, languageCode, externalId] = normalizedDurableObservationIdentity(observation);
  const timestamp = scannedAt.toISOString();
  return {
    ...observation,
    providerKey,
    unitKey,
    scopeKind,
    languageCode,
    externalId,
    scanId,
    scannedAt: timestamp,
    firstObservedAt: timestamp,
    observationHash: "unpersisted-current-scan-observation",
    newlyObserved: false,
    changed: false,
  };
}

function currentScanKey(
  target: Pick<ProviderScopeDiscoveryTarget, "providerKey" | "ingestionUnitKey">,
  providerScope: ProviderScopeDiscoveryTarget["providerScope"],
): string {
  return `${target.providerKey}:${target.ingestionUnitKey}:${providerScope}`;
}

async function proposeMappingsForTarget(input: {
  db: CatalogRuntimeDeps["db"];
  ports: ProviderScopeDiscoveryPorts;
  target: ProviderScopeDiscoveryTarget;
  written: readonly ProviderScopeObservationRecord[];
  scanId: string;
  context: EventStoreContext;
}): Promise<number> {
  const candidates = await matchScopeObservationsToScopeRecords(input.db, {
    target: input.target,
    observations: input.written,
    scanId: input.scanId,
  });

  let proposed = 0;
  for (const { candidate } of candidates) {
    const result = await input.ports.providerScopeMappingCommandHandler({
      streamId: providerScopeMappingStreamId(candidate),
      command: { type: "ProposeProviderScopeMapping", candidate, actor: SCHEDULED_ACTOR },
      context: input.context,
    });
    proposed += result.newEvents.length;
  }
  return proposed;
}
