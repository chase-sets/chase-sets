import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { t } from "@chase-sets/localization";
import {
  catalogSyncAcceptedScopeMappingFromRow,
  type CatalogSyncAcceptedScopeMapping,
  type CatalogSyncProviderParticipationPreview,
  type CatalogSyncScope,
} from "../../source-observations/api/catalog-sync-scope-planner";
import type { CatalogScopeRecordRow } from "../../scope-registry/read-model/queries";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import {
  buildScopeSyncBatchPreview,
  normalizeScopeSyncBatchSelection,
  type ScopeSyncBatchBlocker,
  type ScopeSyncBatchBudget,
  type ScopeSyncBatchPlannedScope,
  type ScopeSyncBatchPreview,
  type ScopeSyncBatchSelection,
} from "../domain/batch";

export type ScopeSyncBatchPlanner = ReturnType<typeof createScopeSyncBatchPlanner>;

export function createScopeSyncBatchPlanner(deps: {
  db: PgQueryable;
  previewCatalogSyncScope: (input: {
    scope: CatalogSyncScope;
    context: EventStoreContext;
    includeOperationalGates?: boolean;
    acceptedScopeMappings?: readonly CatalogSyncAcceptedScopeMapping[];
  }) => Promise<CatalogSyncProviderParticipationPreview>;
  now?: () => string;
}) {
  async function resolve(input: {
    selection: ScopeSyncBatchSelection;
    budget?: Partial<ScopeSyncBatchBudget> | null;
    context: EventStoreContext;
  }): Promise<{ preview: ScopeSyncBatchPreview; plans: readonly ScopeSyncBatchPlannedScope[] }> {
    const selection = normalizeScopeSyncBatchSelection(input.selection);
    const scopeRecords = await resolveScopeRecords(deps.db, selection);
    const mappings = await resolveAcceptedMappings(
      deps.db,
      scopeRecords.map((record) => record.scope_record_id),
    );
    const mappingsByScope = groupMappingsByScope(mappings);
    const plans: ScopeSyncBatchPlannedScope[] = [];

    for (const record of scopeRecords) {
      const scopeMappings = mappingsByScope.get(record.scope_record_id) ?? [];
      const scope = catalogSyncScopeFromRecord(record, scopeMappings, selection);
      const participationPreview = await deps.previewCatalogSyncScope({
        scope,
        context: input.context,
        includeOperationalGates: true,
        acceptedScopeMappings: scopeMappings.map(catalogSyncAcceptedScopeMappingFromRow),
      });
      const blockers = scopePlanBlockers(record, scopeMappings, participationPreview);
      const selectedUnits = participationPreview.units.filter((unit) => unit.selected);
      const providerKeys = [...new Set(selectedUnits.map((unit) => unit.providerKey))].sort();
      const creditedProviderRequestEstimates: Record<string, number | null> = {};
      for (const unit of selectedUnits.filter((candidate) => candidate.providerKey === "scrydex")) {
        creditedProviderRequestEstimates[unit.providerKey] = addNullableEstimate(
          creditedProviderRequestEstimates[unit.providerKey],
          unit.estimate.estimatedRequestCount,
        );
        if (unit.estimate.usageCheckState !== "checked") {
          blockers.push({
            code: "credited-provider-estimate-unavailable",
            scopeRecordId: record.scope_record_id,
            providerKey: unit.providerKey,
            message: t("catalog.features.scopeSyncBatches.api.planner.scrydex.credit.readiness.not.checked"),
          });
        }
      }

      plans.push({
        scopeRecordId: record.scope_record_id,
        scopeRecordVersion: record.updated_at,
        mappingVersions: scopeMappings.map((mapping) => ({
          mappingId: mapping.mapping_id,
          version: mapping.updated_at,
          reviewStatus: mapping.review_status,
        })),
        profileVersions: selectedUnits.map((unit) => ({
          providerKey: unit.providerKey,
          unitKey: unit.unitKey,
          profileKey: unit.profileKey,
          profileVersion: unit.profileVersion,
        })),
        providerKeys,
        providerUnitCount: selectedUnits.length,
        estimatedRequestCount: participationPreview.estimate.totalEstimatedRequestCount,
        creditedProviderRequestEstimates,
        scope,
        participationPreview,
        blockers,
      });
    }

    return {
      preview: buildScopeSyncBatchPreview({
        selection,
        budget: input.budget,
        plans,
        resolvedAt: deps.now?.() ?? new Date().toISOString(),
      }),
      plans,
    };
  }

  return { resolve };
}

async function resolveScopeRecords(
  db: PgQueryable,
  selection: ScopeSyncBatchSelection,
): Promise<readonly CatalogScopeRecordRow[]> {
  if (selection.mode === "ids") {
    if (selection.scopeRecordIds.length === 0) return [];
    const result = await db.query<CatalogScopeRecordRow>(
      `SELECT *
       FROM catalog_scope_records
       WHERE scope_record_id = ANY($1::text[])
       ORDER BY scope_record_id ASC
       LIMIT 5000`,
      [selection.scopeRecordIds],
    );
    return result.rows;
  }

  const values: unknown[] = [];
  const conditions = ["lifecycle_status = 'active'"];
  if (selection.query.productDomain) {
    values.push(selection.query.productDomain);
    conditions.push(`product_domain = $${values.length}`);
  }
  if (selection.query.scopeKind) {
    values.push(selection.query.scopeKind);
    conditions.push(`scope_kind = $${values.length}`);
  }
  const result = await db.query<CatalogScopeRecordRow>(
    `SELECT *
     FROM catalog_scope_records
     WHERE ${conditions.join(" AND ")}
     ORDER BY scope_record_id ASC
     LIMIT 5000`,
    values,
  );
  return result.rows;
}

async function resolveAcceptedMappings(
  db: PgQueryable,
  scopeRecordIds: readonly string[],
): Promise<readonly ProviderScopeMappingRow[]> {
  if (scopeRecordIds.length === 0) return [];
  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *
     FROM catalog_provider_scope_mappings
     WHERE scope_record_id = ANY($1::text[])
       AND review_status IN ('accepted', 'auto-accepted')
     ORDER BY scope_record_id ASC, provider_key ASC, unit_key ASC`,
    [scopeRecordIds],
  );
  return result.rows;
}

function groupMappingsByScope(
  mappings: readonly ProviderScopeMappingRow[],
): ReadonlyMap<string, readonly ProviderScopeMappingRow[]> {
  const grouped = new Map<string, ProviderScopeMappingRow[]>();
  for (const mapping of mappings) {
    const rows = grouped.get(mapping.scope_record_id) ?? [];
    rows.push(mapping);
    grouped.set(mapping.scope_record_id, rows);
  }
  return grouped;
}

function catalogSyncScopeFromRecord(
  record: CatalogScopeRecordRow,
  mappings: readonly ProviderScopeMappingRow[],
  selection: ScopeSyncBatchSelection,
): CatalogSyncScope {
  const languageCode = selection.mode === "matching-scope" ? selection.query.languageCode : null;
  return {
    scopeVersion: "catalog-sync-scope-v2",
    productDomain: record.product_domain,
    languageCode,
    reference: {
      kind: record.scope_kind,
      scopeRecordId: record.scope_record_id,
    },
    providerParticipation: {
      selectedUnitKeys: mappings.map((mapping) => mapping.unit_key),
    },
  };
}

function scopePlanBlockers(
  record: CatalogScopeRecordRow,
  mappings: readonly ProviderScopeMappingRow[],
  preview: CatalogSyncProviderParticipationPreview,
): ScopeSyncBatchBlocker[] {
  const blockers: ScopeSyncBatchBlocker[] = [];
  if (record.lifecycle_status !== "active") {
    blockers.push({
      code: "scope-inactive",
      scopeRecordId: record.scope_record_id,
      providerKey: null,
      message: t("catalog.features.scopeSyncBatches.api.planner.catalog.scope.record.not.active"),
    });
  }
  if (mappings.length === 0) {
    blockers.push({
      code: "mapping-missing",
      scopeRecordId: record.scope_record_id,
      providerKey: null,
      message: t("catalog.features.scopeSyncBatches.api.planner.accepted.provider.scope.mapping.missing"),
    });
  }
  const planningBlockers = [...preview.blockers, ...preview.units.flatMap((unit) => unit.blockers)].filter(
    (blocker, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.code === blocker.code &&
          candidate.message === blocker.message &&
          candidate.action === blocker.action,
      ) === index,
  );
  for (const blocker of planningBlockers) {
    blockers.push({
      code: "scope-planning-blocked",
      scopeRecordId: record.scope_record_id,
      providerKey:
        preview.units.find((unit) => unit.blockers.some((candidate) => candidate === blocker))?.providerKey ?? null,
      message: blocker.message,
    });
  }
  return blockers;
}

function addNullableEstimate(current: number | null | undefined, next: number | null): number | null {
  return current === null || next === null ? null : (current ?? 0) + next;
}
