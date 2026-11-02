import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  accountBlockUnsnapshottedTailMax,
  assertAccountBlockBudgetLinks,
  decideAccountBlockCommand,
  foldAccountBlockBudgetHistory,
  foldAccountBlockPairHistory,
  type AccountBlockCommandDecision,
} from "../domain/authority";
import {
  AccountBlockAuthorityError,
  accountBlockBudgetStreamId,
  accountBlockPairStreamId,
  parseAccountBlockAccountId,
  parseAccountBlockEffectiveAt,
  parseAccountBlockTransitionId,
  type AccountBlockOperation,
  type AccountBlockPair,
  type AccountBlockTransitionId,
} from "../domain/events";

/** The two caller-owned-transaction event-store primitives the authority uses; nothing here begins or commits. */
export type AccountBlockAuthorityStore = Pick<
  PostgresEventStore,
  "appendToStreamsInTransaction" | "readStreamInTransaction"
>;

/**
 * One Block or Unblock command. `transitionId` is derived from the admission owner's
 * receipt. The initiating User travels only in `context.audit`; the blocking
 * Account is the audit Account. No caller or process timestamp is accepted.
 */
export type AccountBlockCommand = Readonly<{
  operation: AccountBlockOperation;
  blockingAccountId: AccountId;
  blockedAccountId: AccountId;
  transitionId: AccountBlockTransitionId;
  context: EventStoreContext;
}>;

/**
 * The staged result. Only `transition` carries appends, in lock order: the Account budget
 * stream, then the directed pair stream (private transition, then public fact).
 */
export type AccountBlockStagedCommand =
  | Exclude<AccountBlockCommandDecision, Readonly<{ outcome: "transition" }>>
  | Readonly<{
      outcome: "transition";
      transitionId: AccountBlockTransitionId;
      operation: AccountBlockOperation;
      effectiveAt: IsoUtcTimestamp;
      appends: readonly [AppendToStreamInput, AppendToStreamInput];
    }>;

// Read after the stream locks; explicit UTC text, so no session time zone or driver type parser applies.
const serverInstantSql = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS server_instant`;

/**
 * Stages one command inside a PostgreSQL transaction the caller owns, and appends
 * nothing. It locks the Account budget stream and then the pair stream, reads both
 * bounded histories, validates them, reads the server clock and decides. The command's
 * admission owner appends `appends` with `appendToStreamsInTransaction` on the same
 * client, writes its first-result receipt, and commits once; any failure rolls back
 * every event and the receipt together, so there is no event-only write path.
 */
export async function stageAccountBlockCommand(
  store: AccountBlockAuthorityStore,
  client: PgQueryable,
  command: AccountBlockCommand,
): Promise<AccountBlockStagedCommand> {
  const pair = parseCommandPair(command);
  const transitionId = parseCommandTransitionId(command.transitionId);
  const budgetStreamId = accountBlockBudgetStreamId(pair.tenantId, pair.blockingAccountId);
  const pairStreamId = accountBlockPairStreamId(pair);

  // Zero-event expected-version guards upsert and lock each stream row, budget first.
  await store.appendToStreamsInTransaction(client, [
    { streamId: budgetStreamId, expectedVersion: "any", events: [], context: command.context },
    { streamId: pairStreamId, expectedVersion: "any", events: [], context: command.context },
  ]);
  const budgetEvents = await readUnsnapshottedHistory(store, client, budgetStreamId);
  const pairEvents = await readUnsnapshottedHistory(store, client, pairStreamId);
  const budgetState = foldAccountBlockBudgetHistory(pair, budgetEvents);
  const pairState = foldAccountBlockPairHistory(pair, pairEvents);
  assertAccountBlockBudgetLinks(pairState, budgetState);

  const decision = decideAccountBlockCommand({
    pair,
    operation: command.operation,
    transitionId,
    pairState,
    budgetState,
    serverInstant: await readServerInstant(client),
  });
  if (decision.outcome !== "transition") return decision;

  return {
    outcome: "transition",
    transitionId: decision.transitionId,
    operation: decision.operation,
    effectiveAt: decision.effectiveAt,
    appends: [
      {
        streamId: budgetStreamId,
        expectedVersion: expectedVersion(budgetState.streamVersion),
        events: [decision.events.budgetEvent],
        context: command.context,
      },
      {
        streamId: pairStreamId,
        expectedVersion: expectedVersion(pairState.streamVersion),
        events: decision.events.pairEvents,
        context: command.context,
      },
    ],
  };
}

function parseCommandPair(command: AccountBlockCommand): AccountBlockPair {
  if (command.operation !== "block" && command.operation !== "unblock") {
    throw new AccountBlockAuthorityError("invalid-command");
  }
  let blockingAccountId: AccountId;
  let blockedAccountId: AccountId;
  try {
    blockingAccountId = parseAccountBlockAccountId(command.blockingAccountId);
    blockedAccountId = parseAccountBlockAccountId(command.blockedAccountId);
  } catch {
    throw new AccountBlockAuthorityError("invalid-command");
  }
  if (
    blockingAccountId === blockedAccountId ||
    typeof command.context?.tenantId !== "string" ||
    command.context.tenantId.length === 0 ||
    command.context.audit?.forAccountId !== blockingAccountId
  ) {
    throw new AccountBlockAuthorityError("invalid-command");
  }
  return { tenantId: command.context.tenantId, blockingAccountId, blockedAccountId };
}

function parseCommandTransitionId(value: unknown): AccountBlockTransitionId {
  try {
    return parseAccountBlockTransitionId(value);
  } catch {
    throw new AccountBlockAuthorityError("invalid-command");
  }
}

async function readUnsnapshottedHistory(
  store: AccountBlockAuthorityStore,
  client: PgQueryable,
  streamId: string,
): Promise<readonly StoredEvent[]> {
  const events = await store.readStreamInTransaction(client, {
    streamId,
    fromVersion: 1,
    limit: accountBlockUnsnapshottedTailMax + 1,
  });
  if (events.length > accountBlockUnsnapshottedTailMax) throw new AccountBlockAuthorityError("tail-bound");
  return events;
}

async function readServerInstant(client: PgQueryable): Promise<IsoUtcTimestamp> {
  const result = await client.query<Readonly<{ server_instant: unknown }>>(serverInstantSql);
  try {
    return parseAccountBlockEffectiveAt(result.rows[0]?.server_instant);
  } catch {
    throw new AccountBlockAuthorityError("invalid-clock");
  }
}

function expectedVersion(streamVersion: number): AppendToStreamInput["expectedVersion"] {
  return streamVersion === 0 ? "no_stream" : streamVersion;
}
