import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { assert } from "./common";
import {
  inventoryMutationFamilies,
  inventoryMutationFingerprint,
  normalizeInventoryMutationIntent,
  type InventoryMutationFamily,
} from "./mutation-intent";

const attemptIdentity = Symbol("inventoryMutationAttempt");
const requestingAccount = Symbol("inventoryRequestingAccount");
type AttemptIdentity = Readonly<{ id: string; path: string; intentVersion: number }>;
type AttemptContext = EventStoreContext & {
  readonly [attemptIdentity]?: AttemptIdentity;
  readonly [requestingAccount]?: string;
};

export const INVENTORY_ATTEMPT_INTENT_CONFLICT = "Inventory mutation attempt conflicts with its accepted intent.";

export function hasInventoryMutationAttempt(context: EventStoreContext): boolean {
  return (context as AttemptContext)[attemptIdentity] !== undefined;
}

export function withInventoryMutationTargetAccount(
  context: EventStoreContext,
  targetAccountId: string,
): EventStoreContext {
  assert(Boolean(targetAccountId), "Inventory mutation is not authorized.");
  return {
    ...context,
    audit: { ...context.audit, forAccountId: targetAccountId },
    [requestingAccount]: (context as AttemptContext)[requestingAccount] ?? context.audit.forAccountId,
  } as AttemptContext;
}

function assertAttemptId(value: unknown): asserts value is string {
  assert(
    typeof value === "string" &&
      /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|iat_[A-Za-z0-9_-]{32,80})$/i.test(value),
    "A caller-created Inventory mutation attempt is required.",
  );
}

export function withInventoryMutationAttempt(
  context: EventStoreContext,
  attemptId: string,
  intentVersion = 1,
): EventStoreContext {
  assertAttemptId(attemptId);
  assert(Number.isSafeInteger(intentVersion) && intentVersion > 0, "Inventory intent version is invalid.");
  const attempted: AttemptContext = { ...context, [attemptIdentity]: { id: attemptId, path: "", intentVersion } };
  return attempted;
}

export function inventoryMutationAttemptFromSource(sourceIdentity: string, operation: string): string {
  assert(sourceIdentity.length > 0 && operation.length > 0, "Inventory source attempt identity is required.");
  return `iat_${createHash("sha256").update(`inventory-source-attempt/v1\n${sourceIdentity}\n${operation}`).digest("hex")}`;
}

export function withInventoryMutationChildAttempt(context: EventStoreContext, child: string): EventStoreContext {
  const identity = mutationIdentity(context);
  assert(
    /^[a-z][a-z0-9-]{0,63}$/.test(child) && identity.path.length + child.length < 256,
    "Inventory child attempt identity is invalid.",
  );
  const attempted: AttemptContext = {
    ...context,
    [attemptIdentity]: { ...identity, path: `${identity.path}/${child}` },
  };
  return attempted;
}

function mutationIdentity(context: EventStoreContext): AttemptIdentity {
  const identity = (context as AttemptContext)[attemptIdentity];
  assert(identity !== undefined, "A caller-created Inventory mutation attempt is required.");
  assertAttemptId(identity.id);
  return identity;
}

export function assertInventoryMutationAuthority(context: EventStoreContext, accountId: string) {
  assert(
    Boolean(context.tenantId && context.audit.performedByUserId && accountId) &&
      context.audit.forAccountId === accountId,
    "Inventory mutation is not authorized.",
  );
}

type Receipt<T = unknown> = {
  tenant_id: string;
  actor_user_id: string;
  account_id: string;
  requesting_account_id?: string;
  family: InventoryMutationFamily;
  target_id: string;
  intent_hash: string;
  fingerprint_version: number;
  receipt_version: number;
  status: "accepted" | "succeeded";
  result: T;
  result_hash: string;
  completed_at: string | Date;
};

export type InventoryMutationReceipt = Readonly<{
  version: 1;
  family: InventoryMutationFamily;
  targetId: string;
  result: unknown;
  completedAt: string;
}>;

function validateReceipt(receipt: Receipt) {
  assert(
    receipt.status === "succeeded" &&
      receipt.receipt_version === 1 &&
      receipt.fingerprint_version === 1 &&
      inventoryMutationFamilies.includes(receipt.family) &&
      receipt.result_hash === inventoryMutationFingerprint(receipt.result),
    "Inventory mutation receipt is unavailable; reconciliation is required.",
  );
}

export function createInventoryMutationRuntime(pool: PgTransactionalPool, postgresEventStore: PostgresEventStore) {
  type Transaction = Readonly<{
    client: PgPoolClient;
    context: EventStoreContext;
    root: string;
    executing: Set<string>;
  }>;
  const transactions = new AsyncLocalStorage<Transaction>();
  let sequence = 0;
  const db: PgTransactionalPool = {
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    query: <Row>(sql: string, values?: readonly unknown[]) =>
      (transactions.getStore()?.client ?? pool).query<Row>(sql, values),
    connect: async () => {
      const client = transactions.getStore()?.client;
      if (!client) return pool.connect();
      const savepoint = `inventory_nested_${++sequence}`;
      return {
        query: <Row>(sql: string, values?: readonly unknown[]) =>
          client.query<Row>(
            sql === "BEGIN"
              ? `SAVEPOINT ${savepoint}`
              : sql === "COMMIT"
                ? `RELEASE SAVEPOINT ${savepoint}`
                : sql === "ROLLBACK"
                  ? `ROLLBACK TO SAVEPOINT ${savepoint}`
                  : sql,
            values,
          ),
        release: () => undefined,
      };
    },
  };
  async function protectedWrite<T>(client: PgQueryable, work: () => Promise<T>) {
    const savepoint = `inventory_write_${++sequence}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await work();
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Cleanup must not replace the primary write error.
      }
      throw error;
    }
  }
  const eventStore: EventStore = {
    ...postgresEventStore,
    appendToStream: (input) => {
      const active = transactions.getStore();
      return active
        ? protectedWrite(active.client, () => postgresEventStore.appendToStreamInTransaction(active.client, input))
        : postgresEventStore.appendToStream(input);
    },
    appendToStreams: (inputs) => {
      const active = transactions.getStore();
      return active
        ? protectedWrite(active.client, () => postgresEventStore.appendToStreamsInTransaction(active.client, inputs))
        : postgresEventStore.appendToStreams!(inputs);
    },
    readStream: (input) => {
      const client = transactions.getStore()?.client;
      return client ? postgresEventStore.readStreamInTransaction(client, input) : postgresEventStore.readStream(input);
    },
  };

  async function execute<T>(
    family: InventoryMutationFamily,
    targetId: string,
    accountId: string,
    params: unknown,
    context: EventStoreContext,
    work: () => Promise<T>,
  ): Promise<T> {
    assertInventoryMutationAuthority(context, accountId);
    const identity = mutationIdentity(context);
    const normalized = normalizeInventoryMutationIntent(family, params);
    assert(normalized.accountId === accountId, "Inventory mutation is not authorized.");
    const intentHash = inventoryMutationFingerprint(normalized);
    const attemptKey = createHash("sha256").update(`${identity.id}\n${identity.path}`).digest("hex");
    const requestingAccountId = (context as AttemptContext)[requestingAccount] ?? accountId;
    const active = transactions.getStore();
    if (active) {
      assert(
        active.context.tenantId === context.tenantId &&
          active.context.audit.performedByUserId === context.audit.performedByUserId &&
          active.context.audit.forAccountId === accountId &&
          active.root === identity.id,
        "Inventory mutation is not authorized.",
      );
      assert(
        identity.path.length > 0 && !active.executing.has(attemptKey),
        "A distinct nested Inventory attempt is required.",
      );
    }
    const accept = async () => {
      const transaction = transactions.getStore()!;
      transaction.executing.add(attemptKey);
      try {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory-attempt:${attemptKey}`]);
        const receipts = await db.query<Receipt<T>>(
          "SELECT * FROM inventory_mutation_attempts WHERE attempt_key = $1",
          [attemptKey],
        );
        const existing = receipts.rows[0];
        if (existing) {
          assert(
            existing.tenant_id === context.tenantId &&
              existing.actor_user_id === context.audit.performedByUserId &&
              existing.account_id === accountId,
            "Inventory mutation is not authorized.",
          );
          assert(
            (existing.requesting_account_id ?? existing.account_id) === requestingAccountId,
            "Inventory mutation is not authorized.",
          );
          assert(
            existing.family === family &&
              existing.target_id === targetId &&
              existing.fingerprint_version === identity.intentVersion &&
              existing.intent_hash === intentHash,
            INVENTORY_ATTEMPT_INTENT_CONFLICT,
          );
          validateReceipt(existing);
          return existing.result;
        }
        assert(identity.intentVersion === 1, "Inventory intent version is not supported.");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `inventory-target:${context.tenantId}:${accountId}:${family}:${targetId}`,
        ]);
        await db.query(
          `INSERT INTO inventory_mutation_attempts
          (attempt_key, tenant_id, actor_user_id, account_id, family, target_id, fingerprint_version, intent_hash, receipt_version, status, requesting_account_id)
          VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 1, 'accepted', $8)`,
          [
            attemptKey,
            context.tenantId,
            context.audit.performedByUserId,
            accountId,
            family,
            targetId,
            intentHash,
            requestingAccountId,
          ],
        );
        const result = JSON.parse(JSON.stringify(await work())) as T;
        const completed = await db.query(
          `UPDATE inventory_mutation_attempts SET status = 'succeeded', result = $8::jsonb, result_hash = $9, completed_at = now()
          WHERE attempt_key = $1 AND tenant_id = $2 AND actor_user_id = $3 AND account_id = $4 AND family = $5 AND target_id = $6
            AND fingerprint_version = 1 AND intent_hash = $7 AND receipt_version = 1 AND status = 'accepted' RETURNING attempt_key`,
          [
            attemptKey,
            context.tenantId,
            context.audit.performedByUserId,
            accountId,
            family,
            targetId,
            intentHash,
            JSON.stringify(result),
            inventoryMutationFingerprint(result),
          ],
        );
        assert(completed.rows.length === 1, "Inventory mutation receipt could not be completed.");
        return result;
      } finally {
        transaction.executing.delete(attemptKey);
      }
    };
    return active
      ? protectedWrite(active.client, accept)
      : withPgTransaction(pool, (client) =>
          transactions.run({ client, context, root: identity.id, executing: new Set() }, accept),
        );
  }

  async function read(attemptId: string, context: EventStoreContext): Promise<InventoryMutationReceipt | null> {
    assertAttemptId(attemptId);
    assertInventoryMutationAuthority(context, context.audit.forAccountId);
    const receipts = await db.query<Receipt>(
      `SELECT * FROM inventory_mutation_attempts
      WHERE attempt_key = $1 AND tenant_id = $2 AND actor_user_id = $3 AND COALESCE(requesting_account_id, account_id) = $4`,
      [
        createHash("sha256").update(`${attemptId}\n`).digest("hex"),
        context.tenantId,
        context.audit.performedByUserId,
        context.audit.forAccountId,
      ],
    );
    const receipt = receipts.rows[0];
    if (!receipt) return null;
    validateReceipt(receipt);
    return {
      version: 1 as const,
      family: receipt.family,
      targetId: receipt.target_id,
      result: receipt.result,
      completedAt: new Date(receipt.completed_at).toISOString(),
    };
  }
  async function child<T>(
    name: string,
    family: InventoryMutationFamily,
    targetId: string,
    params: Readonly<Record<string, unknown> & { accountId: string }>,
    context: EventStoreContext,
    work: (context: EventStoreContext) => Promise<T>,
  ): Promise<T> {
    if (!transactions.getStore()) return work(context);
    const childContext = withInventoryMutationChildAttempt(context, name);
    return execute(family, targetId, params.accountId, params, childContext, () => work(childContext));
  }
  return { db, eventStore, execute, read, child };
}
