import { isIdentityAccountBlockFactEventType } from "@chase-sets/event-core/public-event-payloads";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId, TenantId } from "@chase-sets/primitives/typed-ids";
import {
  AccountBlockAuthorityError,
  accountBlockBudgetEventId,
  accountBlockBudgetRecordedEventType,
  accountBlockBudgetStreamId,
  accountBlockEventIds,
  accountBlockFactEventType,
  accountBlockPairStreamId,
  accountBlockTransitionRecordedEventType,
  decodeAccountBlockBudgetRecorded,
  decodeAccountBlockFact,
  decodeAccountBlockTransitionRecorded,
  encodeAccountBlockTransition,
  parseAccountBlockEffectiveAt,
  type AccountBlockAuthorityErrorCode,
  type AccountBlockOperation,
  type AccountBlockPair,
  type AccountBlockRelation,
  type AccountBlockTransitionId,
  type EncodedAccountBlockTransition,
} from "./events";

/**
 * Versioned protection limits. Only effective transitions count; already-in-state and
 * duplicate commands consume nothing. There is no cap on active Blocks.
 */
export const accountBlockProtectionLimits = Object.freeze({
  version: 1,
  rollingWindowMilliseconds: 60 * 60 * 1000,
  pairTransitionsPerRollingWindow: 10,
  accountTransitionsPerRollingWindow: 60,
});

/**
 * Without an authority snapshot, a command may replay at most this many retained events
 * per authority stream. A longer stream is authority-unavailable, never an unbounded replay.
 */
export const accountBlockUnsnapshottedTailMax = 31;

export type AccountBlockPairTransition = Readonly<{
  transitionId: AccountBlockTransitionId;
  operation: AccountBlockOperation;
  effectiveAt: IsoUtcTimestamp;
  streamVersion: number;
}>;

export type AccountBlockPairState = Readonly<{
  streamVersion: number;
  relation: AccountBlockRelation;
  transitions: readonly AccountBlockPairTransition[];
}>;

export type AccountBlockBudgetEntry = Readonly<{
  transitionId: AccountBlockTransitionId;
  effectiveAt: IsoUtcTimestamp;
  streamVersion: number;
}>;

export type AccountBlockBudgetState = Readonly<{
  streamVersion: number;
  entries: readonly AccountBlockBudgetEntry[];
}>;

function poison(code: AccountBlockAuthorityErrorCode): never {
  throw new AccountBlockAuthorityError(code);
}

function assertStoredPosition(event: StoredEvent, streamId: string, tenantId: TenantId, streamVersion: number): void {
  if (event.streamId !== streamId) poison("identity");
  if (event.tenantId !== tenantId) poison("tenant");
  if (event.streamVersion !== streamVersion) poison("order");
}

function isAccountBlockAuthorityEventType(eventType: string): boolean {
  return (
    eventType === accountBlockTransitionRecordedEventType ||
    eventType === accountBlockBudgetRecordedEventType ||
    isIdentityAccountBlockFactEventType(eventType)
  );
}

/**
 * Folds one complete directed pair history. Every effective transition must be the
 * private transition immediately followed by its matching public fact, both carrying
 * their deterministic identities, legal from the prior relation state, and no earlier
 * than the previous effective instant. Anything else is poison and fails closed; the
 * fold never repairs or skips an event. Only stored effective instants are read.
 */
export function foldAccountBlockPairHistory(
  pair: AccountBlockPair,
  events: readonly StoredEvent[],
): AccountBlockPairState {
  const streamId = accountBlockPairStreamId(pair);
  const transitions: AccountBlockPairTransition[] = [];
  const seenTransitionIds = new Set<string>();
  let relation: AccountBlockRelation = "inactive";
  let previousEffectiveAt = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < events.length; index += 2) {
    const privateEvent = events[index] as StoredEvent;
    assertStoredPosition(privateEvent, streamId, pair.tenantId, index + 1);
    if (privateEvent.eventType !== accountBlockTransitionRecordedEventType) {
      poison(isAccountBlockAuthorityEventType(privateEvent.eventType) ? "unpaired" : "unknown-event");
    }
    const transition = decodeAccountBlockTransitionRecorded(privateEvent.payload);
    if (
      transition.blockingAccountId !== pair.blockingAccountId ||
      transition.blockedAccountId !== pair.blockedAccountId
    ) {
      poison("pairing");
    }
    if (seenTransitionIds.has(transition.transitionId)) poison("duplicate");
    const ids = accountBlockEventIds(pair, transition.transitionId);
    if (privateEvent.eventId !== ids.transition) poison("identity");
    if (transition.operation !== (relation === "inactive" ? "block" : "unblock")) poison("state");
    const effectiveAt = Date.parse(transition.effectiveAt);
    if (effectiveAt < previousEffectiveAt) poison("time");

    const publicEvent = events[index + 1];
    if (!publicEvent) poison("unpaired");
    assertStoredPosition(publicEvent, streamId, pair.tenantId, index + 2);
    if (publicEvent.eventType !== accountBlockFactEventType(transition.operation)) {
      if (isIdentityAccountBlockFactEventType(publicEvent.eventType)) poison("pairing");
      poison(isAccountBlockAuthorityEventType(publicEvent.eventType) ? "unpaired" : "unknown-event");
    }
    const fact = decodeAccountBlockFact(publicEvent.payload);
    if (fact.blockingAccountId !== pair.blockingAccountId || fact.blockedAccountId !== pair.blockedAccountId) {
      poison("pairing");
    }
    if (publicEvent.eventId !== ids.fact) poison("identity");

    seenTransitionIds.add(transition.transitionId);
    relation = transition.operation === "block" ? "active" : "inactive";
    previousEffectiveAt = effectiveAt;
    transitions.push({
      transitionId: transition.transitionId,
      operation: transition.operation,
      effectiveAt: transition.effectiveAt,
      streamVersion: privateEvent.streamVersion,
    });
  }

  return { streamVersion: events.length, relation, transitions };
}

/** Folds one complete Account budget history under the same identity, order and time rules. */
export function foldAccountBlockBudgetHistory(
  owner: Readonly<{ tenantId: TenantId; blockingAccountId: AccountId }>,
  events: readonly StoredEvent[],
): AccountBlockBudgetState {
  const streamId = accountBlockBudgetStreamId(owner.tenantId, owner.blockingAccountId);
  const entries: AccountBlockBudgetEntry[] = [];
  const seenTransitionIds = new Set<string>();
  let previousEffectiveAt = Number.NEGATIVE_INFINITY;

  events.forEach((event, index) => {
    assertStoredPosition(event, streamId, owner.tenantId, index + 1);
    if (event.eventType !== accountBlockBudgetRecordedEventType) {
      poison(isAccountBlockAuthorityEventType(event.eventType) ? "unpaired" : "unknown-event");
    }
    const entry = decodeAccountBlockBudgetRecorded(event.payload);
    if (entry.blockingAccountId !== owner.blockingAccountId) poison("pairing");
    if (seenTransitionIds.has(entry.transitionId)) poison("duplicate");
    if (event.eventId !== accountBlockBudgetEventId(owner.tenantId, owner.blockingAccountId, entry.transitionId)) {
      poison("identity");
    }
    const effectiveAt = Date.parse(entry.effectiveAt);
    if (effectiveAt < previousEffectiveAt) poison("time");
    seenTransitionIds.add(entry.transitionId);
    previousEffectiveAt = effectiveAt;
    entries.push({
      transitionId: entry.transitionId,
      effectiveAt: entry.effectiveAt,
      streamVersion: event.streamVersion,
    });
  });

  return { streamVersion: events.length, entries };
}

/**
 * Every pair transition must have its Account budget entry: same transition identity,
 * same effective instant, and the same relative order as in the pair stream.
 */
export function assertAccountBlockBudgetLinks(pair: AccountBlockPairState, budget: AccountBlockBudgetState): void {
  const entriesById = new Map(budget.entries.map((entry) => [entry.transitionId, entry]));
  let previousBudgetVersion = 0;
  for (const transition of pair.transitions) {
    const entry = entriesById.get(transition.transitionId);
    if (!entry || entry.effectiveAt !== transition.effectiveAt || entry.streamVersion <= previousBudgetVersion) {
      poison("budget-link");
    }
    previousBudgetVersion = entry.streamVersion;
  }
}

/**
 * The effective instant is the latest of the server clock read after the stream locks
 * and the last effective instant in each selected authority stream. It is therefore
 * monotonic; equal instants are ordered by stream version.
 */
export function resolveAccountBlockEffectiveAt(
  serverInstant: IsoUtcTimestamp,
  pair: AccountBlockPairState,
  budget: AccountBlockBudgetState,
): IsoUtcTimestamp {
  const candidates = [serverInstant, pair.transitions.at(-1)?.effectiveAt, budget.entries.at(-1)?.effectiveAt].flatMap(
    (instant) => (instant === undefined ? [] : [Date.parse(parseAccountBlockEffectiveAt(instant))]),
  );
  return new Date(Math.max(...candidates)).toISOString() as IsoUtcTimestamp;
}

/** Counts prior effective instants inside the half-open rolling window `(effectiveAt - PT1H, effectiveAt]`. */
export function countAccountBlockTransitionsInRollingWindow(
  instants: readonly IsoUtcTimestamp[],
  effectiveAt: IsoUtcTimestamp,
): number {
  const end = Date.parse(effectiveAt);
  const start = end - accountBlockProtectionLimits.rollingWindowMilliseconds;
  return instants.filter((instant) => {
    const at = Date.parse(instant);
    return at > start && at <= end;
  }).length;
}

export type AccountBlockCommandDecision =
  | Readonly<{ outcome: "already-in-state"; relation: AccountBlockRelation }>
  | Readonly<{
      outcome: "already-recorded";
      transitionId: AccountBlockTransitionId;
      operation: AccountBlockOperation;
      effectiveAt: IsoUtcTimestamp;
    }>
  | Readonly<{ outcome: "limited"; limit: "pair" | "account"; effectiveAt: IsoUtcTimestamp }>
  | Readonly<{
      outcome: "transition";
      transitionId: AccountBlockTransitionId;
      operation: AccountBlockOperation;
      effectiveAt: IsoUtcTimestamp;
      events: EncodedAccountBlockTransition;
    }>;

/**
 * Decides one command against validated pair and budget state. A delivered transition
 * identity resolves to its recorded transition; a command for the state the pair is
 * already in is a no-op; otherwise the pair and Account rolling windows are checked at
 * the resolved effective instant before the transition is encoded.
 */
export function decideAccountBlockCommand(
  input: Readonly<{
    pair: AccountBlockPair;
    operation: AccountBlockOperation;
    transitionId: AccountBlockTransitionId;
    pairState: AccountBlockPairState;
    budgetState: AccountBlockBudgetState;
    serverInstant: IsoUtcTimestamp;
  }>,
): AccountBlockCommandDecision {
  const recorded = input.pairState.transitions.find((transition) => transition.transitionId === input.transitionId);
  if (recorded) {
    if (recorded.operation !== input.operation) poison("transition-conflict");
    return {
      outcome: "already-recorded",
      transitionId: recorded.transitionId,
      operation: recorded.operation,
      effectiveAt: recorded.effectiveAt,
    };
  }
  if (input.budgetState.entries.some((entry) => entry.transitionId === input.transitionId)) {
    poison("transition-conflict");
  }

  const targetRelation: AccountBlockRelation = input.operation === "block" ? "active" : "inactive";
  if (input.pairState.relation === targetRelation) {
    return { outcome: "already-in-state", relation: input.pairState.relation };
  }

  const effectiveAt = resolveAccountBlockEffectiveAt(input.serverInstant, input.pairState, input.budgetState);
  const pairCount = countAccountBlockTransitionsInRollingWindow(
    input.pairState.transitions.map((transition) => transition.effectiveAt),
    effectiveAt,
  );
  if (pairCount >= accountBlockProtectionLimits.pairTransitionsPerRollingWindow) {
    return { outcome: "limited", limit: "pair", effectiveAt };
  }
  const accountCount = countAccountBlockTransitionsInRollingWindow(
    input.budgetState.entries.map((entry) => entry.effectiveAt),
    effectiveAt,
  );
  if (accountCount >= accountBlockProtectionLimits.accountTransitionsPerRollingWindow) {
    return { outcome: "limited", limit: "account", effectiveAt };
  }

  return {
    outcome: "transition",
    transitionId: input.transitionId,
    operation: input.operation,
    effectiveAt,
    events: encodeAccountBlockTransition(input.pair, input.transitionId, input.operation, effectiveAt),
  };
}
