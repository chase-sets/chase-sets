import type { BcRetentionExemption } from "@chase-sets/bounded-context-module";

export const identityRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "identity_invitations",
    owner: "identity",
    reason: "Invitation rows are durable identity history projected from the event store, not ephemeral tokens.",
  },
];
