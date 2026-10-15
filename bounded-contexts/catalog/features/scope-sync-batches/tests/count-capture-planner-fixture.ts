import { vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  CatalogSyncProviderParticipationPreview,
  CatalogSyncProviderParticipationUnit,
} from "../../source-observations/api/catalog-sync-scope-planner";
import {
  cacheKeyForProviderOptionQuery,
  type CatalogProviderOptionQueryCacheRecord,
  type CatalogProviderOptionQueryCacheStore,
  type CatalogProviderOptionQueryRequest,
} from "../../source-observations/api/providers/provider-option-query-cache";
import { readScrydexCountSource, scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import type { ScrydexCountEvidence, ScrydexCountQuery, ScrydexCountSource } from "../domain/count-acquisition";
import { countCaptureKindUnitKeys, countCaptureUnitKeys, type CountCaptureKind } from "../domain/count-capture-plan";
import { createScopeSyncBatchPlanner } from "../api/planner";

// Synthetic capture-scope fixture: one One Piece OP01 English scope and its three
// Scrydex units, read through the real count reader at one fixed instant.
export const captureNow = "2026-10-13T08:04:10.000Z";
export const captureScopeRecordId = "scope-synthetic-op01";
export const captureContext: EventStoreContext = {
  tenantId: "tnt_synthetic_9584",
  audit: { performedByUserId: "usr_synthetic_9584", forAccountId: "acc_synthetic_9584" },
};
const profileKeys = {
  cards: "one-piece-card-print-source-observation",
  sealed: "one-piece-sealed-product-source-observation",
} as const satisfies Record<CountCaptureKind, string>;
const totals = { cards: 121, sealed: 7 } as const satisfies Record<CountCaptureKind, number>;

export function captureCountQuery(kind: CountCaptureKind): ScrydexCountQuery {
  return scrydexCountQuery({
    environment: "staging",
    accountRevision: "synthetic-revision",
    productDomain: "one-piece",
    profileKey: profileKeys[kind],
    profileVersion: "2026.06.22",
    unitKey: countCaptureKindUnitKeys[kind],
    kind,
    languageCode: "en",
    parentValue: "OP01",
  });
}

export function pageOneEvidence(kind: CountCaptureKind, overrides: Partial<ScrydexCountEvidence> = {}) {
  return {
    query: captureCountQuery(kind),
    validationKind: "page-1-count",
    sourceId: `synthetic-${kind}-debit`,
    totalCount: totals[kind],
    pageSize: 100,
    returnedPage: 1,
    returnedItemCount: Math.min(totals[kind], 100),
    observedAt: "2026-10-13T08:03:01.500Z",
    expiresAt: "2026-10-13T08:18:01.500Z",
    ...overrides,
  } satisfies ScrydexCountEvidence;
}

// An option-query cache record the reader accepts as complete for `kind`.
export function completeCacheRecord(kind: CountCaptureKind, fetchedAt: string): CatalogProviderOptionQueryCacheRecord {
  const query = captureCountQuery(kind);
  const request: CatalogProviderOptionQueryRequest = {
    providerKey: "scrydex",
    profileKey: query.profileKey,
    profileVersion: query.profileVersion,
    ingestionUnitKey: query.unitKey,
    queryKind: kind === "sealed" ? "sealed-products" : "cards",
    languageCode: "en",
    parentValue: "OP01",
  };
  const expiresAt = new Date(Date.parse(fetchedAt) + 900_000).toISOString();
  return {
    cacheKey: cacheKeyForProviderOptionQuery(request),
    providerKey: "scrydex",
    profileKey: query.profileKey,
    profileVersion: query.profileVersion,
    ingestionUnitKey: query.unitKey,
    queryKind: request.queryKind,
    languageCode: "en",
    parentValue: "OP01",
    items: Array.from({ length: totals[kind] }, (_, index) => ({
      providerKey: "scrydex",
      queryKind: request.queryKind,
      value: `synthetic-${index}`,
      label: "synthetic",
      description: null,
      parentValue: "OP01",
      imageUrl: null,
      aliases: [],
      metadata: {},
    })),
    fetchedAt,
    expiresAt,
    staleUntil: expiresAt,
    diagnosticCode: null,
    diagnosticText: null,
    itemCount: totals[kind],
    totalCount: totals[kind],
    pageSize: 100,
  };
}

// The real reader over synthetic count evidence and cache records. `read` lets a
// hostile case replace one unit's read; by default every unit reads once.
export function createCaptureReaderFixture(
  input: {
    counts?: Partial<Record<CountCaptureKind, unknown>>;
    caches?: Partial<Record<CountCaptureKind, CatalogProviderOptionQueryCacheRecord>>;
  } = {},
) {
  const counts = input.counts ?? { cards: pageOneEvidence("cards"), sealed: pageOneEvidence("sealed") };
  const now = vi.fn(() => new Date(captureNow));
  const countReader = { read: vi.fn(async (query: ScrydexCountQuery) => (counts[query.kind] ?? null) as never) };
  const cacheStore: CatalogProviderOptionQueryCacheStore = {
    read: vi.fn(async (request) => input.caches?.[request.queryKind === "cards" ? "cards" : "sealed"] ?? null),
    write: vi.fn(async () => {
      throw new Error("The capture reader fixture never writes.");
    }),
  };
  const options = { now, countReader, cacheStore };
  return { now, countReader, cacheStore, read: (query: ScrydexCountQuery) => readScrydexCountSource(query, options) };
}

type UnitRead = (kind: CountCaptureKind) => Promise<ScrydexCountSource | null>;

// The real batch planner over the capture scope. Its scope preview stands in for
// adapter planning and estimates each count unit from `readUnit`.
export function createCapturePlannerFixture(readUnit: UnitRead) {
  // node-postgres returns timestamptz columns as Date, whatever the row type says.
  const record = {
    scope_record_id: captureScopeRecordId,
    product_domain: "one-piece",
    scope_kind: "set",
    lifecycle_status: "active",
    updated_at: new Date("2026-10-13T07:00:00.000Z"),
  };
  const mappings = countCaptureUnitKeys.map((unitKey, index) => ({
    mapping_id: `mapping-synthetic-${index}`,
    scope_record_id: captureScopeRecordId,
    provider_key: "scrydex",
    unit_key: unitKey,
    product_line_id: null,
    series_id: null,
    set_id: "OP01",
    set_name: "Synthetic Romance Dawn",
    review_status: "accepted",
    updated_at: new Date("2026-10-13T07:00:00.000Z"),
  }));
  const db = {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes("catalog_scope_records") ? [record] : mappings,
    })),
  };
  const previewCatalogSyncScope = vi.fn(
    async ({ scope }: { scope: CatalogSyncProviderParticipationPreview["scope"] }) => {
      const units: CatalogSyncProviderParticipationUnit[] = [];
      for (const unitKey of countCaptureUnitKeys) {
        const kind = (Object.keys(countCaptureKindUnitKeys) as CountCaptureKind[]).find(
          (candidate) => countCaptureKindUnitKeys[candidate] === unitKey,
        );
        const source = kind ? await readUnit(kind) : null;
        const estimatedRequestCount = kind
          ? source
            ? Math.max(1, Math.ceil(source.totalCount / source.pageSize))
            : null
          : 1;
        units.push({
          providerKey: "scrydex",
          unitKey,
          profileKey: kind ? profileKeys[kind] : "one-piece-set-reference-data",
          profileVersion: "2026.06.22",
          displayName: "Synthetic unit",
          role: kind ? "primary-source-observation" : "reference-data",
          requirement: "required",
          eligibility: "eligible",
          defaultSelected: true,
          selected: true,
          childExecutionScope: null,
          estimate: {
            ...(source ? { countSource: source } : {}),
            targetCount: source?.totalCount ?? null,
            requestStrategy: "bulk-first",
            estimatedRequestCount,
            estimateState: estimatedRequestCount === null ? "estimate-unavailable" : "estimated",
            estimateReason: null,
            usageCheckState: "checked",
            transportSteps: [],
          },
          blockers: [],
          explanation: "synthetic-explanation-marker",
        });
      }
      return {
        previewVersion: "catalog-sync-provider-participation-preview-v1",
        scope,
        status: "ready",
        startAllowed: true,
        units,
        estimate: {
          totalEstimatedRequestCount: units.reduce(
            (total, unit) => total + (unit.estimate.estimatedRequestCount ?? 0),
            0,
          ),
          estimateState: "estimated",
          estimateReason: null,
          creditConsumingProviders: [],
        },
        blockers: [],
        explanation: "synthetic-explanation-marker",
      } satisfies CatalogSyncProviderParticipationPreview;
    },
  );
  const planner = createScopeSyncBatchPlanner({ db: db as never, previewCatalogSyncScope, now: () => captureNow });
  const input = {
    selection: { mode: "ids" as const, scopeRecordIds: [captureScopeRecordId] },
    budget: { creditedProviderRequestLimits: { scrydex: 10 } },
    context: captureContext,
  };
  return { planner, input, previewCatalogSyncScope };
}
