import { buildCatalogAttentionQueueReadModel, type CatalogAttentionQueueReadModel } from "./contracts";
import {
  CATALOG_ATTENTION_KIND_SEVERITIES,
  CATALOG_ATTENTION_SUMMARY_WINDOW,
  catalogAttentionKindRecord,
  catalogAttentionSeverityRecord,
  type CatalogAttentionItem,
  type CatalogAttentionItemKind,
  type CatalogAttentionQueueWindow,
  type CatalogAttentionTotalKind,
} from "../read-model/attention-item";

// Serialized attention read models as the daily route loader receives them from
// the API — the shape `assembleCatalogAttentionQueue` produces, built directly so
// loader and render tests can express exact items without the six source-row
// fixtures. Counts, coverage and freshness come from the same derivation the
// assembler uses, so a fixture is internally consistent by construction.

export const CATALOG_ATTENTION_FIXTURE_GENERATED_AT = "2026-07-09T12:00:00.000Z";

// An alias candidate: one-click accept plus a reason-bearing secondary reject —
// the richest resolution shape the queue carries.
export function catalogAttentionAliasCandidateItem(
  overrides: Partial<CatalogAttentionItem> = {},
): CatalogAttentionItem {
  return {
    itemKey: "alias-candidate:h1",
    kind: "alias-candidate",
    severity: "info",
    titleKey: "catalog.features.attentionQueue.item.aliasCandidate.title",
    titleParams: { alias: "Lightning Bolt (alt)" },
    detailKey: "catalog.features.attentionQueue.item.aliasCandidate.detail",
    detailParams: { provider: "scryfall", type: "catalog-item", confidence: 0.92 },
    providerKey: "scryfall",
    unitKey: null,
    observedAt: "2026-07-05T00:00:00.000Z",
    resolution: {
      intent: "alias.accept",
      mode: "command",
      labelKey: "catalog.features.attentionQueue.action.acceptAlias",
      fields: { aliasHashes: "h1", targetKind: "catalog-item", targetId: "i1", targetKey: "name" },
    },
    secondaryResolutions: [
      {
        intent: "alias.reject",
        mode: "command",
        labelKey: "catalog.features.attentionQueue.action.rejectAlias",
        fields: { aliasHashes: "h1", targetKind: "catalog-item", targetId: "i1", targetKey: "name" },
        requiresReason: true,
      },
    ],
    ...overrides,
  };
}

// A blocked provider unit: critical severity with a drawer-only resolution.
export function catalogAttentionProviderHealthItem(
  overrides: Partial<CatalogAttentionItem> = {},
): CatalogAttentionItem {
  return {
    itemKey: "provider-health:tcgplayer:pokemon:single-card:source-observation-import",
    kind: "provider-health",
    severity: "critical",
    titleKey: "catalog.features.attentionQueue.item.providerHealth.title",
    titleParams: { unit: "tcgplayer:pokemon:single-card:source-observation-import", provider: "tcgplayer" },
    detailKey: "catalog.features.attentionQueue.item.providerHealth.detail",
    detailParams: { blocker: "credential", code: "cred.expired" },
    providerKey: "tcgplayer",
    unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
    observedAt: "2026-07-01T00:00:00.000Z",
    resolution: {
      intent: "review-provider-health",
      mode: "drawer",
      labelKey: "catalog.features.attentionQueue.action.reviewHealth",
      fields: { unitKey: "tcgplayer:pokemon:single-card:source-observation-import" },
    },
    secondaryResolutions: [],
    ...overrides,
  };
}

// Per-kind cohort overrides: `total` adds unreturned work beyond the window (to
// the kind's first severity) and `totalKind` marks a lower bound.
export type CatalogAttentionFixtureCohort = Readonly<{
  total?: number;
  totalKind?: CatalogAttentionTotalKind;
}>;

export function catalogAttentionQueueReadModelFixture(
  items: readonly CatalogAttentionItem[] = [catalogAttentionProviderHealthItem(), catalogAttentionAliasCandidateItem()],
  generatedAt: string = CATALOG_ATTENTION_FIXTURE_GENERATED_AT,
  options: Readonly<{
    window?: CatalogAttentionQueueWindow;
    cohorts?: Partial<Record<CatalogAttentionItemKind, CatalogAttentionFixtureCohort>>;
  }> = {},
): CatalogAttentionQueueReadModel {
  return buildCatalogAttentionQueueReadModel({
    generatedAt,
    window: options.window ?? CATALOG_ATTENTION_SUMMARY_WINDOW,
    slices: catalogAttentionKindRecord((kind) => {
      const kindItems = items.filter((item) => item.kind === kind);
      const cohort = options.cohorts?.[kind] ?? {};
      const unreturned = Math.max(0, (cohort.total ?? kindItems.length) - kindItems.length);
      const primarySeverity = CATALOG_ATTENTION_KIND_SEVERITIES[kind][0];
      return {
        bySeverity: catalogAttentionSeverityRecord(
          (severity) =>
            kindItems.filter((item) => item.severity === severity).length +
            (severity === primarySeverity ? unreturned : 0),
        ),
        totalKind: cohort.totalKind ?? "exact",
        items: kindItems,
      };
    }),
  });
}
