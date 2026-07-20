import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import {
  accountLinkageFactTypes,
  normalizeAccountLinkageClusterHash,
  normalizeAccountLinkageFlaggedPayload,
  type AccountLinkageClearedPayload,
  type AccountLinkageFlaggedPayload,
  type AccountLinkageSignalKind,
} from "@chase-sets/event-core/account-linkage-facts";

/**
 * One Account Linkage aggregate per opaque Settlement risk-cluster reference.
 * The stream, not the risk read model, owns publication state so replay and
 * command idempotency remain event-sourced.
 */
export type AccountLinkageState = Readonly<{
  clusterHash: string | null;
  signalKind: AccountLinkageSignalKind | null;
  accountIds: readonly string[];
  flagged: boolean;
}>;

export const initialAccountLinkageState: AccountLinkageState = {
  clusterHash: null,
  signalKind: null,
  accountIds: [],
  flagged: false,
};

export type FlagAccountLinkageCommand = Readonly<{
  type: "FlagAccountLinkage";
  clusterHash: string;
  signalKind: AccountLinkageSignalKind;
  accountIds: readonly string[];
}>;

export type ClearAccountLinkageCommand = Readonly<{
  type: "ClearAccountLinkage";
  clusterHash: string;
}>;

export type AccountLinkageCommand = FlagAccountLinkageCommand | ClearAccountLinkageCommand;

export type AccountLinkageFlaggedEvent = DomainEvent<
  typeof accountLinkageFactTypes.flagged,
  AccountLinkageFlaggedPayload
>;
export type AccountLinkageClearedEvent = DomainEvent<
  typeof accountLinkageFactTypes.cleared,
  AccountLinkageClearedPayload
>;
export type AccountLinkageEvent = AccountLinkageFlaggedEvent | AccountLinkageClearedEvent;

export const decideAccountLinkage: AggregateDecider<AccountLinkageState, AccountLinkageCommand, AccountLinkageEvent> = (
  state,
  command,
) => {
  if (command.type === "ClearAccountLinkage") {
    const clusterHash = normalizeAccountLinkageClusterHash(command.clusterHash);
    assertSameCluster(state, clusterHash);
    if (!state.flagged) return [];
    if (state.signalKind === null) throw new Error("A flagged account-linkage stream requires a signal kind.");
    const data = normalizeAccountLinkageFlaggedPayload({
      clusterHash,
      signalKind: state.signalKind,
      accountIds: state.accountIds,
    });
    return [{ type: accountLinkageFactTypes.cleared, data }];
  }

  const data = normalizeAccountLinkageFlaggedPayload(command);
  assertSameCluster(state, data.clusterHash);
  if (state.signalKind !== null && state.signalKind !== data.signalKind) {
    throw new Error("An account-linkage stream cannot change signal kind.");
  }
  if (state.flagged && sameAccountSet(state.accountIds, data.accountIds)) {
    return [];
  }
  return [{ type: accountLinkageFactTypes.flagged, data }];
};

export const evolveAccountLinkage: AggregateEvolver<AccountLinkageState, AccountLinkageEvent> = (state, event) => {
  switch (event.type) {
    case accountLinkageFactTypes.flagged:
      return {
        clusterHash: event.data.clusterHash,
        signalKind: event.data.signalKind,
        accountIds: event.data.accountIds,
        flagged: true,
      };
    case accountLinkageFactTypes.cleared:
      return { ...state, clusterHash: event.data.clusterHash, flagged: false };
  }
};

function assertSameCluster(state: AccountLinkageState, clusterHash: string): void {
  if (state.clusterHash !== null && state.clusterHash !== clusterHash) {
    throw new Error("An account-linkage stream cannot change clusterHash.");
  }
}

function sameAccountSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((accountId, index) => accountId === right[index]);
}

export function accountLinkageStreamId(clusterHash: string): string {
  return `settlement.account-linkage-${normalizeAccountLinkageClusterHash(clusterHash)}`;
}
