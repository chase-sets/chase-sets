import type { CatalogAttentionQueueReadModel } from "./contracts";
import { summarizeCatalogAttentionItems, type CatalogAttentionItem } from "../read-model/attention-item";

// Serialized attention read models as the daily route loader receives them from
// the API — the shape `assembleCatalogAttentionQueue` produces, built directly so
// loader and render tests can express exact items without the six source-row
// fixtures. Counts and freshness are derived from the items the same way the
// assembler derives them, so a fixture is internally consistent by construction.

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
      intent: "accept",
      mode: "command",
      labelKey: "catalog.features.attentionQueue.action.acceptAlias",
      fields: { aliasHash: "h1", targetKind: "catalog-item", targetId: "i1" },
    },
    secondaryResolutions: [
      {
        intent: "reject",
        mode: "command",
        labelKey: "catalog.features.attentionQueue.action.rejectAlias",
        fields: { aliasHash: "h1", targetKind: "catalog-item", targetId: "i1" },
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

export function catalogAttentionQueueReadModelFixture(
  items: readonly CatalogAttentionItem[] = [catalogAttentionProviderHealthItem(), catalogAttentionAliasCandidateItem()],
  generatedAt: string = CATALOG_ATTENTION_FIXTURE_GENERATED_AT,
): CatalogAttentionQueueReadModel {
  const observedAts = items.map((item) => item.observedAt).sort((left, right) => left.localeCompare(right));
  return {
    generatedAt,
    empty: items.length === 0,
    items,
    counts: summarizeCatalogAttentionItems(items),
    freshness: {
      generatedAt,
      oldestObservedAt: observedAts[0] ?? null,
      newestObservedAt: observedAts.at(-1) ?? null,
    },
  };
}
