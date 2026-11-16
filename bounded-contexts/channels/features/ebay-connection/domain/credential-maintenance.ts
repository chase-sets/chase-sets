import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { ChannelOAuthTokenSet } from "../../credentials/domain/contracts";
import { closed, EbayConnectionError } from "./oauth";

// Controller-owned engineering policy, not an eBay limit or token lifetime.
const tuple = Object.freeze({
  sweepSeconds: 450,
  refreshLeadSeconds: 1800,
  retryBackoffSeconds: Object.freeze([60, 300, 1800, 7200, 21600]),
  maxAttempts: 6,
});
export const ebayCredentialMaintenancePolicy = definePolicy({
  policyKey: "channels.ebay-credential-maintenance",
  contextName: "channels",
  schemaSummary: "channels.ebay-credential-maintenance/v1: fixed sweep, lead, retry backoff and attempt budget",
  defaultValue: tuple,
  decodeValue(raw) {
    closed(raw, ["sweepSeconds", "refreshLeadSeconds", "retryBackoffSeconds", "maxAttempts"]);
    if (
      raw.sweepSeconds !== tuple.sweepSeconds ||
      raw.refreshLeadSeconds !== tuple.refreshLeadSeconds ||
      raw.maxAttempts !== tuple.maxAttempts ||
      JSON.stringify(raw.retryBackoffSeconds) !== JSON.stringify(tuple.retryBackoffSeconds)
    )
      throw new EbayConnectionError("invalid-request");
    return tuple;
  },
});
export const ebayMaintenanceRevision = "channels.ebay-credential-maintenance/v1";

export function admitsCredentialLifetime(tokens: ChannelOAuthTokenSet): boolean {
  const lifetime = Date.parse(tokens.accessExpiresAt ?? "") - Date.parse(tokens.issuedAt);
  return Number.isSafeInteger(lifetime) && lifetime > (tuple.refreshLeadSeconds + tuple.sweepSeconds) * 1000;
}

export function credentialDueAt(tokens: ChannelOAuthTokenSet, completedAt: Date): Date | null {
  if (!admitsCredentialLifetime(tokens)) return null;
  const due = Date.parse(tokens.accessExpiresAt!) - tuple.refreshLeadSeconds * 1000;
  // Delayed responses cannot create a due-now loop even if their original lifetime was admissible.
  return due > completedAt.getTime() ? new Date(due) : null;
}
