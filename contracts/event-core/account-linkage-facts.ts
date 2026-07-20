import type { AccountId } from "../primitives/typed-ids";

/** Ratified Settlement facts consumed by pair-scoped market-integrity projections. */
export const accountLinkageFactTypes = {
  flagged: "settlement.account-linkage.flagged",
  cleared: "settlement.account-linkage.cleared",
} as const;

export const accountLinkageSignalKinds = ["shared-instrument", "shared-address"] as const;
export type AccountLinkageSignalKind = (typeof accountLinkageSignalKinds)[number];

/**
 * Privacy-minimal linkage fact. `clusterHash` is a lowercase SHA-256 digest of
 * the Settlement-owned signal kind and raw cluster key; raw payment-instrument
 * or address material never crosses the context boundary.
 */
export type AccountLinkageFlaggedPayload = Readonly<{
  clusterHash: string;
  signalKind: AccountLinkageSignalKind;
  accountIds: readonly AccountId[];
}>;

/** A clear retains the last flagged set so the reversal is self-describing. */
export type AccountLinkageClearedPayload = AccountLinkageFlaggedPayload;

export function normalizeAccountLinkageClusterHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Account-linkage fact requires a lowercase SHA-256 clusterHash.");
  }
  return value;
}

function normalizeSignalKind(value: unknown): AccountLinkageSignalKind {
  if (!accountLinkageSignalKinds.includes(value as AccountLinkageSignalKind)) {
    throw new Error("Account-linkage fact signalKind is invalid.");
  }
  return value as AccountLinkageSignalKind;
}

function normalizeAccountIds(value: unknown): readonly AccountId[] {
  if (!Array.isArray(value)) {
    throw new Error("Account-linkage fact accountIds must be an array.");
  }
  const accountIds = [...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim() : "")))].sort();
  if (accountIds.length < 2 || accountIds.some((accountId) => accountId.length === 0)) {
    throw new Error("Account-linkage fact requires at least two distinct accountIds.");
  }
  return accountIds as AccountId[];
}

export function normalizeAccountLinkageFlaggedPayload(input: unknown): AccountLinkageFlaggedPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Account-linkage flagged fact payload is required.");
  }
  const candidate = input as Record<string, unknown>;
  return {
    clusterHash: normalizeAccountLinkageClusterHash(candidate.clusterHash),
    signalKind: normalizeSignalKind(candidate.signalKind),
    accountIds: normalizeAccountIds(candidate.accountIds),
  };
}

export function normalizeAccountLinkageClearedPayload(input: unknown): AccountLinkageClearedPayload {
  return normalizeAccountLinkageFlaggedPayload(input);
}
