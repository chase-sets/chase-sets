import { createHash } from "node:crypto";
import type { EventStoreContext, GlobalPosition, StoredEvent } from "@chase-sets/event-core/storage";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  accountBlockBudgetStreamId,
  accountBlockPairStreamId,
  encodeAccountBlockTransition,
  type AccountBlockOperation,
  type AccountBlockPair,
  type AccountBlockTransitionId,
} from "../domain/events";

// Synthetic identities only; none of these belongs to a real tenant, Account or User.
export const syntheticTenantId = "tnt_01ARZ3NDEKTSV4RRFFQ69G5FAY" as TenantId;
export const blockingAccountId = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV" as AccountId;
export const blockedAccountId = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAW" as AccountId;
export const otherBlockedAccountId = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAX" as AccountId;
export const initiatingUserId = "usr_01ARZ3NDEKTSV4RRFFQ69G5FAZ" as UserId;

export const syntheticPair: AccountBlockPair = {
  tenantId: syntheticTenantId,
  blockingAccountId,
  blockedAccountId,
};

export function syntheticTransitionId(label: string): AccountBlockTransitionId {
  return `abt_${createHash("sha256").update(`synthetic-transition:${label}`, "utf8").digest("hex")}`;
}

export function instant(milliseconds: number): IsoUtcTimestamp {
  return new Date(milliseconds).toISOString() as IsoUtcTimestamp;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function syntheticContext(
  overrides: Partial<{ userId: UserId; accountId: AccountId; traceId: string }> = {},
): EventStoreContext {
  return {
    tenantId: syntheticTenantId,
    audit: {
      performedByUserId: overrides.userId ?? initiatingUserId,
      forAccountId: overrides.accountId ?? blockingAccountId,
    },
    ...(overrides.traceId ? { trace: { traceId: overrides.traceId as never } } : {}),
  };
}

export type SyntheticStep = Readonly<{
  transitionId: AccountBlockTransitionId;
  operation: AccountBlockOperation;
  effectiveAt: IsoUtcTimestamp;
  blockedAccountId?: AccountId;
}>;

/** Alternating Block/Unblock steps starting from the inactive state, one per given instant. */
export function alternatingSteps(
  label: string,
  instants: readonly IsoUtcTimestamp[],
  blocked: AccountId = blockedAccountId,
): readonly SyntheticStep[] {
  return instants.map((effectiveAt, index) => ({
    transitionId: syntheticTransitionId(`${label}:${index}`),
    operation: index % 2 === 0 ? "block" : "unblock",
    effectiveAt,
    blockedAccountId: blocked,
  }));
}

export type SyntheticHistory = Readonly<{
  pairEvents: readonly StoredEvent[];
  budgetEvents: readonly StoredEvent[];
}>;

/**
 * Builds a complete valid retained history for one blocking Account. Steps for other
 * blocked Accounts land only in the budget stream. Envelope times are the given process
 * clock values, so a replay that read them instead of `effectiveAt` would diverge.
 */
export function buildSyntheticHistory(
  steps: readonly SyntheticStep[],
  options: Readonly<{ recordedAt?: IsoUtcTimestamp; pair?: AccountBlockPair }> = {},
): SyntheticHistory {
  const pair = options.pair ?? syntheticPair;
  const recordedAt = options.recordedAt ?? instant(0);
  const pairStreamId = accountBlockPairStreamId(pair);
  const budgetStreamId = accountBlockBudgetStreamId(pair.tenantId, pair.blockingAccountId);
  const pairEvents: StoredEvent[] = [];
  const budgetEvents: StoredEvent[] = [];
  let globalPosition = 0;
  const stored = (streamId: string, streamVersion: number, record: ReturnType<typeof toRecord>): StoredEvent => ({
    ...record,
    streamId,
    streamVersion,
    globalPosition: String((globalPosition += 1)) as GlobalPosition,
    tenantId: pair.tenantId,
    metadata: {},
    occurredAt: recordedAt,
    recordedAt,
    performedByUserId: initiatingUserId,
    forAccountId: pair.blockingAccountId,
  });

  for (const step of steps) {
    const stepPair = { ...pair, blockedAccountId: step.blockedAccountId ?? pair.blockedAccountId };
    const encoded = encodeAccountBlockTransition(stepPair, step.transitionId, step.operation, step.effectiveAt);
    budgetEvents.push(stored(budgetStreamId, budgetEvents.length + 1, toRecord(encoded.budgetEvent)));
    if (stepPair.blockedAccountId !== pair.blockedAccountId) continue;
    pairEvents.push(stored(pairStreamId, pairEvents.length + 1, toRecord(encoded.pairEvents[0])));
    pairEvents.push(stored(pairStreamId, pairEvents.length + 1, toRecord(encoded.pairEvents[1])));
  }

  return { pairEvents, budgetEvents };
}

function toRecord(event: ReturnType<typeof encodeAccountBlockTransition>["budgetEvent"]) {
  if (!event.eventId) throw new Error("Synthetic Account Block events always carry their deterministic identity.");
  return { eventId: event.eventId, eventType: event.eventType, payload: event.payload };
}

/** Rewrites stream positions after a test edits the event list, keeping everything else verbatim. */
export function renumber(events: readonly StoredEvent[]): readonly StoredEvent[] {
  return events.map((event, index) => ({ ...event, streamVersion: index + 1 }));
}
