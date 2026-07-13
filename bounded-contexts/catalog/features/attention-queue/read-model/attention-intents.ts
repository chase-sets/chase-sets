// Daily-surface form intents the attention queue POSTs. Every attention intent
// resolves on the import-to-promotion (daily) surface, so acting on a queue item
// never navigates to a different surface (AC: zero returnPath-style detours).
export const CATALOG_ATTENTION_DISMISS_INTENT = "dismiss-attention-item";
export const CATALOG_ATTENTION_DEFER_INTENT = "defer-attention-item";
export const CATALOG_ATTENTION_RESTORE_INTENT = "restore-attention-item";

export const CATALOG_ATTENTION_COMMAND_INTENTS = [
  CATALOG_ATTENTION_DISMISS_INTENT,
  CATALOG_ATTENTION_DEFER_INTENT,
  CATALOG_ATTENTION_RESTORE_INTENT,
] as const;

export type CatalogAttentionCommandIntent = (typeof CATALOG_ATTENTION_COMMAND_INTENTS)[number];

export function isCatalogAttentionCommandIntent(intent: string): intent is CatalogAttentionCommandIntent {
  return (CATALOG_ATTENTION_COMMAND_INTENTS as readonly string[]).includes(intent);
}
