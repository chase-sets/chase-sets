import type { HelpArticleBlock } from "./article-model";

/**
 * Machine-readable degraded-state contract for public policy values (#6115).
 * These are locale-independent DOM markers derived from the `policy-value-unavailable`
 * domain discriminant — a health check must read these attributes, never rendered prose,
 * because the visible copy is a translatable string that any locale edit can change.
 */
export const POLICY_VALUE_STATE_ATTRIBUTE = "data-policy-value-state";
export const POLICY_VALUE_UNAVAILABLE_STATE = "unavailable";
export const POLICY_VALUE_KEY_ATTRIBUTE = "data-policy-value-key";

/** Page-level aggregate marker, present if and only if the page rendered at least one unresolved value. */
export const POLICY_VALUES_AGGREGATE_STATE_ATTRIBUTE = "data-policy-values-state";
export const POLICY_VALUES_DEGRADED_STATE = "degraded";
export const POLICY_VALUES_AGGREGATE_KEYS_ATTRIBUTE = "data-policy-value-keys";
export const POLICY_VALUE_KEYS_SEPARATOR = ",";

/** Every unresolved occurrence's key, with repeats — an article can cite the same key more than once, and each occurrence renders (and must mark) its own node. */
export function collectUnresolvedPolicyValueOccurrences(blocks: readonly HelpArticleBlock[]): readonly string[] {
  const keys: string[] = [];
  for (const block of blocks) {
    const inlineLists = block.type === "list" ? block.items : [block.content];
    for (const inlines of inlineLists) {
      for (const inline of inlines) {
        if (inline.type === "policy-value-unavailable") keys.push(inline.key);
      }
    }
  }
  return keys.sort();
}

/** Derives the exact unresolved key set from an article's compiled blocks — the single chokepoint every renderer of `HelpArticle`-shaped blocks shares, so the aggregate can never be computed separately from what actually rendered. */
export function collectUnresolvedPolicyValueKeys(blocks: readonly HelpArticleBlock[]): readonly string[] {
  return [...new Set(collectUnresolvedPolicyValueOccurrences(blocks))].sort();
}

export function formatPolicyValueKeys(keys: readonly string[]): string {
  return keys.join(POLICY_VALUE_KEYS_SEPARATOR);
}

export function parsePolicyValueKeys(value: string): readonly string[] {
  return value.length === 0 ? [] : value.split(POLICY_VALUE_KEYS_SEPARATOR);
}
