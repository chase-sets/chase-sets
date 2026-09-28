import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const identityRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "identity_listing_credential_mutations",
    owner: "identity",
    reason:
      "Durable credential mutation receipts prevent delayed retries from restoring obsolete key or delegation authority.",
  },
  {
    tableName: "identity_invitations",
    owner: "identity",
    reason: "Invitation rows are durable identity history projected from the event store, not ephemeral tokens.",
  },
];
