import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import { loadCatalogProviderSendWindowEnabled } from "@chase-sets/platform-runtime/config-schema";
import type { ProviderAdapter, ProviderImportScope } from "../provider-adapters/provider-adapter";
import type { SourceObservationServices } from "../source-observation-runtime-contracts";
import {
  createProviderSendAdmission,
  runCatalogProviderWork,
  runProviderSendRequest,
  providerSendProviders,
  ProviderSendStoppedError,
  currentProviderSendBinding,
  type ProviderSendBinding,
  type ProviderSendRequest,
} from "./provider-send-admission";
import { createPostgresProviderSendLedger } from "./provider-send-ledger";

export function createCatalogProviderSendRuntime(pool: PgTransactionalPool) {
  if (!loadCatalogProviderSendWindowEnabled()) return null;
  const ledger = createPostgresProviderSendLedger(pool);
  const admission = createProviderSendAdmission({ enabled: true, ledger });
  return { ledger, admission };
}
export type CatalogProviderSendRuntime = NonNullable<ReturnType<typeof createCatalogProviderSendRuntime>>;
export type ProviderSendWindowReadout = Awaited<ReturnType<typeof readProviderSendWindow>>;

export function bindCatalogProviderServices(
  services: SourceObservationServices,
  runtime: CatalogProviderSendRuntime | null,
): SourceObservationServices {
  if (!runtime) return services;
  const admission = runtime.admission;
  function bind<Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) {
    return (...args: Args) => runCatalogProviderWork(admission, () => work(...args));
  }
  return {
    ...services,
    listTcgdexLanguages: bind(services.listTcgdexLanguages),
    listTcgdexSeries: bind(services.listTcgdexSeries),
    listTcgdexExpansions: bind(services.listTcgdexExpansions),
    queryIntegrationOptions: bind(services.queryIntegrationOptions),
    listIntegrationOptions: bind(services.listIntegrationOptions),
    getCatalogIntegrationControlPlaneReadiness: bind(services.getCatalogIntegrationControlPlaneReadiness),
    importProviderAdapterForReplay: bind(services.importProviderAdapterForReplay),
    reconcilePromotedObservationForReplay: bind(services.reconcilePromotedObservationForReplay),
    promoteObservation: bind(services.promoteObservation),
    promoteObservations: bind(services.promoteObservations),
    promoteObservationScope: bind(services.promoteObservationScope),
    reapplyObservations: bind(services.reapplyObservations),
    reapplyObservationScope: bind(services.reapplyObservationScope),
    enqueueBulkReviewJob: bind(services.enqueueBulkReviewJob),
    processNextBulkReviewJob: bind(services.processNextBulkReviewJob),
    previewCatalogSyncScope: bind(services.previewCatalogSyncScope),
    enqueueCatalogSyncRun: bind(services.enqueueCatalogSyncRun),
    previewIntegrationImport: bind(services.previewIntegrationImport),
    enqueueIntegrationJob: bind(services.enqueueIntegrationJob),
    retryIntegrationJob: bind(services.retryIntegrationJob),
    resumeIntegrationJob: bind(services.resumeIntegrationJob),
    processNextIntegrationJob: bind(services.processNextIntegrationJob),
    promoteCatalogMergeCandidate: bind(services.promoteCatalogMergeCandidate),
  };
}

export async function retainProviderSendJobBinding(deps: CatalogRuntimeDeps, jobId: string): Promise<void> {
  if (!deps.providerSendRuntime) return;
  const binding = currentProviderSendBinding();
  await deps.db.query(
    "INSERT INTO catalog_provider_send_job_bindings (job_id, window_id, phase, pass) VALUES ($1,$2,$3,$4) ON CONFLICT (job_id) DO NOTHING",
    [jobId, binding?.windowId ?? null, binding?.phase ?? null, binding?.pass ?? null],
  );
}

export async function runProviderSendJob<T>(
  deps: CatalogRuntimeDeps,
  jobId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!deps.providerSendRuntime) return work();
  const result = await deps.db.query<{
    window_id: string | null;
    phase: "preflight" | "pass" | null;
    pass: number | null;
  }>("SELECT window_id, phase, pass FROM catalog_provider_send_job_bindings WHERE job_id = $1", [jobId]);
  const row = result.rows[0];
  if (!row) throw new ProviderSendStoppedError("stale-binding");
  let binding: ProviderSendBinding | null = null;
  if (row.window_id !== null) {
    if (row.phase === null || row.pass === null) throw new ProviderSendStoppedError("stale-binding");
    binding = { windowId: row.window_id, phase: row.phase, pass: row.pass };
  }
  return runCatalogProviderWork(deps.providerSendRuntime.admission, work, binding);
}

function scopeRequest(
  provider: ProviderSendRequest["provider"],
  scope: ProviderImportScope,
  category: ProviderSendRequest["category"],
): ProviderSendRequest {
  return {
    provider,
    category,
    unitKey: scope.unitKey,
    language: scope.values.languageCode ?? scope.values.language ?? "en",
    coordinate: scope.values.expansionId ?? scope.values.setId ?? scope.values.parentValue ?? scope.values.setName,
  };
}

export function bindProviderAdapter(adapter: ProviderAdapter): ProviderAdapter {
  const provider = providerSendProviders.find((candidate) => candidate === adapter.providerKey);
  if (!provider) return adapter;
  return {
    ...adapter,
    listOptions(input) {
      return runProviderSendRequest(
        {
          provider,
          category: provider === "scrydex" && ["cards", "card"].includes(input.optionKind) ? "card-force" : "discovery",
          unitKey: input.unitKey,
          language: input.parentValues?.languageCode ?? input.parentValues?.language ?? "en",
          coordinate: input.parentValues?.expansionId ?? input.parentValues?.setId ?? input.parentValues?.parentValue,
        },
        () => adapter.listOptions(input),
      );
    },
    planImport(scope) {
      return runProviderSendRequest(scopeRequest(provider, scope, "planning"), () => adapter.planImport(scope));
    },
    async *fetchPayloads(plan, options) {
      const request = scopeRequest(provider, plan.scope, "payload");
      const iterator = adapter.fetchPayloads(plan, options)[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await runProviderSendRequest(request, () => iterator.next());
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await runProviderSendRequest(request, () => iterator.return?.());
      }
    },
    getCredentialReadiness: () =>
      runProviderSendRequest({ provider, category: "baseline" }, () => adapter.getCredentialReadiness()),
    getTransportDiagnostics: () =>
      runProviderSendRequest({ provider, category: "baseline" }, () => adapter.getTransportDiagnostics()),
  };
}

export async function readProviderSendWindow(runtime: CatalogProviderSendRuntime | null) {
  if (!runtime) return { state: "disabled" as const };
  try {
    return await runtime.ledger.read();
  } catch {
    return { state: "unavailable" as const, refusal: "authority-unavailable" as const };
  }
}
