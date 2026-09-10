import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const manualSyncRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "channels_manual_sync_clamp_status",
    owner: "channels",
    reason:
      "The latest per-run clamp outcome is durable recovery evidence and must remain while the corresponding Channel Sync Run can require conservative operator attention.",
  },
];
