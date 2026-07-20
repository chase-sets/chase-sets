import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  accountLinkageStreamId,
  decideAccountLinkage,
  evolveAccountLinkage,
  initialAccountLinkageState,
  type AccountLinkageCommand,
  type AccountLinkageEvent,
} from "../domain/account-linkage";
import {
  ACCOUNT_LINKAGE_FLAG_LAUNCH_POLICY_VALUE,
  accountLinkageFlagPolicy,
  type AccountLinkageFlagPolicyValue,
} from "../domain/account-linkage-policy";
import {
  getAccountLinkageCloserCursor,
  listAccountLinkageClusterCandidates,
  saveAccountLinkageCloserCursor,
} from "../integrations/account-risk-source/account-linkage-queries";

const ACCOUNT_LINKAGE_SYSTEM_CONTEXT: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: { performedByUserId: "usr_settlement_system" as never, forAccountId: "acc_settlement_system" as never },
};
const DEFAULT_CLOSER_LIMIT = 500;
const MAX_CONCURRENCY_RETRIES = 4;

export type AccountLinkageCloserResult = Readonly<{
  clustersConsidered: number;
  flagsPublished: number;
  unchanged: number;
}>;

export type AccountLinkageServices = Readonly<{
  runAccountLinkageCloser: (params?: Readonly<{ limit?: number }>) => Promise<AccountLinkageCloserResult>;
  clearAccountLinkage: (clusterHash: string, context: EventStoreContext) => Promise<"cleared" | "noop">;
}>;

type AccountLinkageRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  policies: Readonly<{
    resolvePolicy: (
      definition: typeof accountLinkageFlagPolicy,
    ) => Promise<Readonly<{ value: AccountLinkageFlagPolicyValue }>>;
  }>;
}>;

export function accountLinkageClusterHash(signalKind: string, clusterKey: string): string {
  return createHash("sha256").update(signalKind, "utf8").update("\0").update(clusterKey, "utf8").digest("hex");
}

export function createAccountLinkageRuntime(deps: AccountLinkageRuntimeDeps): AccountLinkageServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<AccountLinkageEvent>(),
    initialState: () => initialAccountLinkageState,
    evolve: evolveAccountLinkage,
    decide: decideAccountLinkage,
  });

  async function resolvePolicy(): Promise<AccountLinkageFlagPolicyValue> {
    try {
      return (await deps.policies.resolvePolicy(accountLinkageFlagPolicy)).value;
    } catch {
      return ACCOUNT_LINKAGE_FLAG_LAUNCH_POLICY_VALUE;
    }
  }

  async function runCommand(
    clusterHash: string,
    command: AccountLinkageCommand,
    context: EventStoreContext,
  ): Promise<readonly AccountLinkageEvent[]> {
    for (let attempt = 0; attempt < MAX_CONCURRENCY_RETRIES; attempt += 1) {
      try {
        return (await commandHandler({ streamId: accountLinkageStreamId(clusterHash), command, context })).newEvents;
      } catch (error) {
        if (!isConcurrencyConflict(error)) throw error;
      }
    }
    throw new Error("Account-linkage command could not be serialized after repeated concurrent writes.");
  }

  return {
    runAccountLinkageCloser: async (params = {}) => {
      const policy = await resolvePolicy();
      const limit = positiveLimit(params.limit ?? DEFAULT_CLOSER_LIMIT);
      const after = await getAccountLinkageCloserCursor(deps.db);
      const candidates = await listAccountLinkageClusterCandidates(deps.db, policy, { after, limit });
      let flagsPublished = 0;
      let unchanged = 0;

      for (const candidate of candidates) {
        const clusterHash = accountLinkageClusterHash(candidate.signalKind, candidate.clusterKey);
        const events = await runCommand(
          clusterHash,
          {
            type: "FlagAccountLinkage",
            clusterHash,
            signalKind: candidate.signalKind,
            accountIds: candidate.accountIds,
          },
          ACCOUNT_LINKAGE_SYSTEM_CONTEXT,
        );
        if (events.length > 0) flagsPublished += 1;
        else unchanged += 1;
      }

      const last = candidates[candidates.length - 1];
      await saveAccountLinkageCloserCursor(
        deps.db,
        candidates.length < limit || !last ? null : { signalKind: last.signalKind, clusterKey: last.clusterKey },
        new Date().toISOString(),
      );
      return { clustersConsidered: candidates.length, flagsPublished, unchanged };
    },
    clearAccountLinkage: async (clusterHash, context) => {
      const events = await runCommand(clusterHash, { type: "ClearAccountLinkage", clusterHash }, context);
      return events.length > 0 ? "cleared" : "noop";
    },
  };
}

function positiveLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error("Account-linkage closer limit must be a positive integer.");
  return value;
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "concurrency_conflict";
}
