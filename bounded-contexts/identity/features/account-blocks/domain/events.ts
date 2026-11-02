import { createHash } from "node:crypto";
import {
  identityAccountBlockFactEventTypes,
  parseIdentityAccountBlockFactPayload,
  type IdentityAccountBlockFactEventType,
  type IdentityAccountBlockFactPayload,
} from "@chase-sets/event-core/public-event-payloads";
import type { EventRecordToStore } from "@chase-sets/event-core/storage";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { parseStrictTypedUlid, type AccountId, type EventId, type TenantId } from "@chase-sets/primitives/typed-ids";

/** Identity-private transition in the directed pair stream. Never in the public registry. */
export const accountBlockTransitionRecordedEventType = "identity.account-block-transition-recorded";
/** Identity-private Account-wide budget entry in the blocking Account's budget stream. Never in the public registry. */
export const accountBlockBudgetRecordedEventType = "identity.account-block-budget-recorded";

export type AccountBlockOperation = "block" | "unblock";
export type AccountBlockRelation = "inactive" | "active";

/** Receipt-derived identity of one effective transition: `abt_` and 64 lowercase hex digits. */
export type AccountBlockTransitionId = `abt_${string}`;

export type AccountBlockTransitionRecordedPayload = Readonly<{
  version: 1;
  transitionId: AccountBlockTransitionId;
  operation: AccountBlockOperation;
  blockingAccountId: AccountId;
  blockedAccountId: AccountId;
  effectiveAt: IsoUtcTimestamp;
}>;

export type AccountBlockBudgetRecordedPayload = Readonly<{
  version: 1;
  transitionId: AccountBlockTransitionId;
  blockingAccountId: AccountId;
  effectiveAt: IsoUtcTimestamp;
}>;

/** The directed relation one pair stream owns, inside one tenant. */
export type AccountBlockPair = Readonly<{
  tenantId: TenantId;
  blockingAccountId: AccountId;
  blockedAccountId: AccountId;
}>;

/**
 * Closed codes only: no message, log line or metric built from this error names an
 * Account, User, transition or instant.
 */
export type AccountBlockAuthorityErrorCode =
  | "invalid-command"
  | "invalid-clock"
  | "codec"
  | "unknown-event"
  | "identity"
  | "tenant"
  | "order"
  | "unpaired"
  | "pairing"
  | "state"
  | "time"
  | "duplicate"
  | "budget-link"
  | "tail-bound"
  | "transition-conflict";

export class AccountBlockAuthorityError extends Error {
  readonly code: AccountBlockAuthorityErrorCode;

  constructor(code: AccountBlockAuthorityErrorCode) {
    super(`Account Block authority refused: ${code}.`);
    this.name = "AccountBlockAuthorityError";
    this.code = code;
  }
}

const transitionIdPattern = /^abt_[0-9a-f]{64}$/;
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const transitionKeys = [
  "version",
  "transitionId",
  "operation",
  "blockingAccountId",
  "blockedAccountId",
  "effectiveAt",
] as const;
const budgetKeys = ["version", "transitionId", "blockingAccountId", "effectiveAt"] as const;

export function parseAccountBlockTransitionId(value: unknown): AccountBlockTransitionId {
  if (typeof value !== "string" || !transitionIdPattern.test(value)) throw new AccountBlockAuthorityError("codec");
  return value as AccountBlockTransitionId;
}

/**
 * A stored effective instant is exactly the millisecond `Z` form `Date#toISOString`
 * writes. Date-only text, offsets, other precisions and impossible calendar dates fail.
 */
export function parseAccountBlockEffectiveAt(value: unknown): IsoUtcTimestamp {
  if (typeof value !== "string" || !canonicalInstantPattern.test(value)) throw new AccountBlockAuthorityError("codec");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new AccountBlockAuthorityError("codec");
  }
  return value as IsoUtcTimestamp;
}

export function parseAccountBlockAccountId(value: unknown): AccountId {
  try {
    if (typeof value !== "string") throw new Error();
    return parseStrictTypedUlid(value, "acc");
  } catch {
    throw new AccountBlockAuthorityError("codec");
  }
}

function parseOperation(value: unknown): AccountBlockOperation {
  if (value !== "block" && value !== "unblock") throw new AccountBlockAuthorityError("codec");
  return value;
}

function closedRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AccountBlockAuthorityError("codec");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new AccountBlockAuthorityError("codec");
  const record = value as Readonly<Record<string, unknown>>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new AccountBlockAuthorityError("codec");
  }
  if (record.version !== 1) throw new AccountBlockAuthorityError("codec");
  return record;
}

/** Identity domain codec for the private pair transition. Every key is required; nothing else is accepted. */
export function decodeAccountBlockTransitionRecorded(value: unknown): AccountBlockTransitionRecordedPayload {
  const record = closedRecord(value, transitionKeys);
  const blockingAccountId = parseAccountBlockAccountId(record.blockingAccountId);
  const blockedAccountId = parseAccountBlockAccountId(record.blockedAccountId);
  if (blockingAccountId === blockedAccountId) throw new AccountBlockAuthorityError("codec");
  return {
    version: 1,
    transitionId: parseAccountBlockTransitionId(record.transitionId),
    operation: parseOperation(record.operation),
    blockingAccountId,
    blockedAccountId,
    effectiveAt: parseAccountBlockEffectiveAt(record.effectiveAt),
  };
}

/** Identity domain codec for the private Account budget entry. Every key is required; nothing else is accepted. */
export function decodeAccountBlockBudgetRecorded(value: unknown): AccountBlockBudgetRecordedPayload {
  const record = closedRecord(value, budgetKeys);
  return {
    version: 1,
    transitionId: parseAccountBlockTransitionId(record.transitionId),
    blockingAccountId: parseAccountBlockAccountId(record.blockingAccountId),
    effectiveAt: parseAccountBlockEffectiveAt(record.effectiveAt),
  };
}

/** The public fact codec, reported with this module's closed error codes. */
export function decodeAccountBlockFact(value: unknown): IdentityAccountBlockFactPayload {
  try {
    return parseIdentityAccountBlockFactPayload(value);
  } catch {
    throw new AccountBlockAuthorityError("codec");
  }
}

export function accountBlockFactEventType(operation: AccountBlockOperation): IdentityAccountBlockFactEventType {
  return identityAccountBlockFactEventTypes[operation];
}

/** SHA-256 over each part as a 4-byte big-endian UTF-8 length followed by its bytes, as lowercase hex. */
export function lengthPrefixedSha256Hex(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

/**
 * Stream ids are opaque digests, so an event-store error, lock wait or stream-category
 * metric never names the Accounts in a relation.
 */
export function accountBlockPairStreamId(pair: AccountBlockPair): string {
  return `identity.account-block-pair-${lengthPrefixedSha256Hex([
    "account-block-pair/v1",
    pair.tenantId,
    pair.blockingAccountId,
    pair.blockedAccountId,
  ])}`;
}

export function accountBlockBudgetStreamId(tenantId: TenantId, blockingAccountId: AccountId): string {
  return `identity.account-block-budget-${lengthPrefixedSha256Hex(["account-block-budget/v1", tenantId, blockingAccountId])}`;
}

export type AccountBlockEventIds = Readonly<{ budget: EventId; transition: EventId; fact: EventId }>;

function accountBlockEventId(parts: readonly string[]): EventId {
  return `evt_account_block_${lengthPrefixedSha256Hex(parts)}` as EventId;
}

/** `sha256(lengthPrefixed(tenantId, blockingAccountId, transitionId, "budget"))`; it never names the blocked Account. */
export function accountBlockBudgetEventId(
  tenantId: TenantId,
  blockingAccountId: AccountId,
  transitionId: AccountBlockTransitionId,
): EventId {
  return accountBlockEventId([tenantId, blockingAccountId, transitionId, "budget"]);
}

/** The deterministic event identities of one effective transition. */
export function accountBlockEventIds(
  pair: AccountBlockPair,
  transitionId: AccountBlockTransitionId,
): AccountBlockEventIds {
  return {
    budget: accountBlockBudgetEventId(pair.tenantId, pair.blockingAccountId, transitionId),
    transition: accountBlockEventId([
      pair.tenantId,
      pair.blockingAccountId,
      pair.blockedAccountId,
      transitionId,
      "transition",
    ]),
    fact: accountBlockEventId([pair.tenantId, pair.blockingAccountId, pair.blockedAccountId, transitionId, "fact"]),
  };
}

export type EncodedAccountBlockTransition = Readonly<{
  budgetEvent: EventRecordToStore;
  pairEvents: readonly [EventRecordToStore, EventRecordToStore];
}>;

/**
 * Encodes one effective transition: the Account budget entry, then the private pair
 * transition and its public fact. Each payload is re-read through its closed codec
 * before it can be appended, and the stored envelope time is the effective instant.
 */
export function encodeAccountBlockTransition(
  pair: AccountBlockPair,
  transitionId: AccountBlockTransitionId,
  operation: AccountBlockOperation,
  effectiveAt: IsoUtcTimestamp,
): EncodedAccountBlockTransition {
  const ids = accountBlockEventIds(pair, transitionId);
  const budget = decodeAccountBlockBudgetRecorded({
    version: 1,
    transitionId,
    blockingAccountId: pair.blockingAccountId,
    effectiveAt,
  });
  const transition = decodeAccountBlockTransitionRecorded({
    version: 1,
    transitionId,
    operation,
    blockingAccountId: pair.blockingAccountId,
    blockedAccountId: pair.blockedAccountId,
    effectiveAt,
  });
  const fact = decodeAccountBlockFact({
    blockingAccountId: pair.blockingAccountId,
    blockedAccountId: pair.blockedAccountId,
  });
  return {
    budgetEvent: {
      eventId: ids.budget,
      eventType: accountBlockBudgetRecordedEventType,
      payload: { ...budget },
      occurredAt: effectiveAt,
    },
    pairEvents: [
      {
        eventId: ids.transition,
        eventType: accountBlockTransitionRecordedEventType,
        payload: { ...transition },
        occurredAt: effectiveAt,
      },
      {
        eventId: ids.fact,
        eventType: accountBlockFactEventType(operation),
        payload: { ...fact },
        occurredAt: effectiveAt,
      },
    ],
  };
}
