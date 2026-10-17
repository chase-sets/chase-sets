import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { createId, type AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  SavedListCommandResult,
  SavedListProductCatalog,
  SavedListProductSelection,
  SavedListLineChangeErrorCode,
} from "../domain/contracts";
import {
  createSavedListRuntime,
  SavedListConcurrencyConflictError,
  SavedListAuthorizationError,
  SavedListIdempotencyConflictError,
  type ApplySavedListLineChangesInput,
} from "./runtime";
import {
  savedListCanonicalIdentifier,
  savedListCanonicalProduct,
  savedListCanonicalTitle,
  savedListFingerprint,
} from "./anonymous-owner";
import type { AddProductToSavedListRequest, SavedListDestination } from "./discovery-contracts";
import type {
  ConfirmSavedListOperation,
  PrepareSavedListOperation,
  SavedListOperationReference,
  SavedListRecoveryOperation,
  SavedListRecoveryPage,
} from "./recovery-contracts";
import { readAnonymousOwnerActivation } from "../../../support/runtime-support/anonymous-owner-activation";

const ttl = 30 * 24 * 60 * 60 * 1_000;
type OperationRow = {
  operation_id: string;
  account_id: AccountId;
  revision: number;
  send_revision: number | null;
  status: "prepared" | "confirmed" | "possible-send" | "applied" | "rejected" | "expired";
  draft: PrepareSavedListOperation;
  request: AddProductToSavedListRequest | null;
  fingerprint: string | null;
  rejection_code: SavedListLineChangeErrorCode | null;
  add_command_id: AddProductToSavedListRequest["addCommandId"];
  line_id: AddProductToSavedListRequest["lineId"];
  intent_id: string | null;
  intent_revision: number | null;
  created_at: string;
  terminal_at: string | null;
  expires_at: string;
};
const columns =
  "operation_id, account_id, revision, send_revision, status, draft, request, fingerprint, rejection_code, add_command_id, line_id, intent_id, intent_revision, created_at, terminal_at, expires_at";

export class SavedListRecoveryError extends Error {
  constructor(
    readonly code:
      | "disabled"
      | "not-found"
      | "conflict"
      | "expired"
      | "invalid-request"
      | "limit"
      | "catalog-unavailable",
  ) {
    super(`Saved List recovery: ${code}.`);
    this.name = "SavedListRecoveryError";
  }
}
export type SavedListRecoveryServices = ReturnType<typeof createSavedListRecoveryRuntime>;

export function createSavedListRecoveryRuntime(
  deps: Readonly<{
    pool: PgTransactionalPool;
    eventStore: PostgresEventStore;
    productCatalog: SavedListProductCatalog;
    clock?: () => Date;
  }>,
) {
  const now = deps.clock ?? (() => new Date());
  async function account(context: EventStoreContext) {
    if (typeof deps.pool.query !== "function") throw new SavedListRecoveryError("disabled");
    const activation = await readAnonymousOwnerActivation(deps.pool);
    if (!activation.activated_at) throw new SavedListRecoveryError("disabled");
    return savedListCanonicalIdentifier(context.audit.forAccountId) as AccountId;
  }
  function boundRuntime(client: PgQueryable, productCatalog: SavedListProductCatalog) {
    const eventStore: EventStore = {
      readStream: (input) => deps.eventStore.readStreamInTransaction(client, input),
      appendToStream: (input) => deps.eventStore.appendToStreamInTransaction(client, input),
      readAll: async () => {
        throw new SavedListRecoveryError("invalid-request");
      },
    };
    return createSavedListRuntime({ eventStore, productCatalog, clock: () => now().toISOString() });
  }
  const noCatalog: SavedListProductCatalog = {
    resolveProduct: async () => {
      throw new SavedListRecoveryError("invalid-request");
    },
  };
  async function readRow(db: PgQueryable, id: string, owner: AccountId, lock = false) {
    const result = await db.query<OperationRow>(
      `SELECT ${columns} FROM collections_saved_list_operations
      WHERE operation_id = $1 AND account_id = $2${lock ? " FOR UPDATE" : ""}`,
      [savedListCanonicalIdentifier(id), owner],
    );
    return result.rows[0] ?? null;
  }
  function fingerprint(row: OperationRow, request: AddProductToSavedListRequest) {
    const target = request.destination;
    return savedListFingerprint([
      "collections.addition.v1",
      row.account_id,
      row.operation_id,
      target.kind === "new"
        ? ["new", target.listId, target.createCommandId, target.title]
        : ["existing", target.listId],
      savedListCanonicalProduct(request.product),
      request.trackedQuantity,
      request.sourceSurface,
      request.addCommandId,
      request.lineId,
    ]);
  }
  function lineInput(row: OperationRow, version = 1): ApplySavedListLineChangesInput {
    const request = row.request;
    if (!request || row.fingerprint !== fingerprint(row, request)) throw new SavedListRecoveryError("conflict");
    return {
      commandId: request.addCommandId,
      listId: request.destination.listId,
      ownerAccountId: row.account_id,
      expectedVersion: version,
      operations: [
        {
          operationId: "discovery-add",
          kind: "add",
          lineId: request.lineId,
          product: request.product,
          trackedQuantity: request.trackedQuantity,
        },
      ],
    };
  }
  async function receipt(db: PgQueryable, row: OperationRow, context: EventStoreContext) {
    if (!row.request) return null;
    const runtime = boundRuntime(db, noCatalog);
    const result = await runtime.readLineChangesReceipt(lineInput(row), context);
    if (result && row.request.destination.kind === "new") {
      // Creation is independently replay-validated, not inferred from the addition row.
      const creation = await runtime.readCreationReceipt(
        {
          commandId: row.request.destination.createCommandId,
          listId: row.request.destination.listId,
          ownerAccountId: row.account_id,
          title: row.request.destination.title,
        },
        context,
      );
      if (!creation?.receipt.replayed) throw new SavedListRecoveryError("conflict");
    }
    return result;
  }
  function output(row: OperationRow, result: SavedListCommandResult | null = null): SavedListRecoveryOperation {
    const elapsedNotSent =
      (row.status === "prepared" || row.status === "confirmed") &&
      new Date(row.expires_at).getTime() <= now().getTime();
    return {
      operationId: row.operation_id,
      revision: Number(row.revision),
      sendRevision: row.send_revision === null ? null : Number(row.send_revision),
      status: result
        ? "applied"
        : elapsedNotSent
          ? "expired"
          : row.status === "possible-send" || row.status === "applied"
            ? "unknown"
            : row.status,
      draft: canonicalDraft(row.draft),
      request: row.request ? canonicalRequest(row.request) : null,
      createdAt: new Date(row.created_at).toISOString(),
      terminalAt: row.terminal_at ? new Date(row.terminal_at).toISOString() : null,
      lineResults: result
        ? [
            {
              operationId: row.operation_id,
              lineId: result.receipt.lineResults[0]?.lineId ?? row.line_id,
              status: "applied",
              errorCode: null,
            },
          ]
        : ["possible-send", "applied", "rejected"].includes(row.status)
          ? [
              {
                operationId: row.operation_id,
                lineId: row.line_id,
                status: row.status === "rejected" ? "rejected" : "unknown",
                errorCode: row.status === "rejected" ? row.rejection_code : null,
              },
            ]
          : [],
      result: result
        ? {
            receipt: {
              ...result.receipt,
              lineResults: result.receipt.lineResults.map(({ operationId, lineId, status, error }) => ({
                operationId,
                lineId,
                status,
                errorCode: error?.code ?? null,
              })),
            },
          }
        : null,
    };
  }
  async function update(
    db: PgQueryable,
    row: OperationRow,
    status: OperationRow["status"],
    terminal = false,
    rejectionCode: SavedListLineChangeErrorCode | null = null,
  ) {
    const result = await db.query<OperationRow>(
      `UPDATE collections_saved_list_operations
      SET status = $4, revision = revision + 1, terminal_at = $5, expires_at = $6, rejection_code = $8
      WHERE operation_id = $1 AND account_id = $2 AND revision = $3 AND status = $7 RETURNING ${columns}`,
      [
        row.operation_id,
        row.account_id,
        row.revision,
        status,
        terminal ? now().toISOString() : null,
        terminal ? new Date(now().getTime() + ttl).toISOString() : row.expires_at,
        row.status,
        rejectionCode,
      ],
    );
    if (result.rows.length !== 1) throw new SavedListRecoveryError("conflict");
    return result.rows[0]!;
  }
  async function lockIntent(db: PgQueryable, row: OperationRow) {
    if (!row.intent_id) return;
    const intent = await db.query<{ owner_revision: number }>(
      `SELECT owner_revision FROM collections_anonymous_saved_list_intents
      WHERE intent_id = $1 AND claimed_account_id = $2 AND owner_revision = $3 AND status = 'claiming' FOR UPDATE`,
      [row.intent_id, row.account_id, row.intent_revision],
    );
    if (intent.rows.length !== 1) throw new SavedListRecoveryError("conflict");
  }
  async function finishIntent(db: PgQueryable, row: OperationRow, expired: boolean) {
    if (!row.intent_id) return;
    const result = await db.query(
      `UPDATE collections_anonymous_saved_list_intents
      SET status = $4, owner_revision = owner_revision + 1, claimed_at = $5, updated_at = $5
      WHERE intent_id = $1 AND claimed_account_id = $2 AND owner_revision = $3 AND status = 'claiming'`,
      [row.intent_id, row.account_id, row.intent_revision, expired ? "expired" : "claimed", now().toISOString()],
    );
    if (result.rowCount !== 1) throw new SavedListRecoveryError("conflict");
  }
  async function expire(context: EventStoreContext) {
    context = { ...context, audit: { ...context.audit } };
    const owner = await account(context);
    return withPgTransaction(deps.pool, async (db) => {
      const due = await db.query<OperationRow>(
        `SELECT ${columns} FROM collections_saved_list_operations
        WHERE account_id = $1 AND expires_at <= $2 ORDER BY expires_at, operation_id LIMIT 500 FOR UPDATE`,
        [owner, now().toISOString()],
      );
      let expired = 0;
      for (const row of due.rows) {
        if (["applied", "rejected", "expired"].includes(row.status)) {
          const deleted = await db.query(
            `DELETE FROM collections_saved_list_operations
            WHERE operation_id = $1 AND account_id = $2 AND revision = $3 AND status = $4`,
            [row.operation_id, owner, row.revision, row.status],
          );
          if (deleted.rowCount !== 1) throw new SavedListRecoveryError("conflict");
        } else {
          await db.query("SAVEPOINT expire_operation");
          try {
            await lockIntent(db, row);
            const found = await receipt(db, row, context);
            await update(db, row, found ? "applied" : "expired", true);
            await finishIntent(db, row, !found);
          } catch (error) {
            await db.query("ROLLBACK TO SAVEPOINT expire_operation");
            if (
              !(error instanceof SavedListAuthorizationError) &&
              !(error instanceof SavedListIdempotencyConflictError) &&
              !(error instanceof SavedListRecoveryError && error.code === "conflict")
            )
              throw error;
            continue;
          } finally {
            await db.query("RELEASE SAVEPOINT expire_operation");
          }
        }
        expired += 1;
      }
      return expired;
    });
  }
  async function insert(
    db: PgQueryable,
    owner: AccountId,
    draft: PrepareSavedListOperation,
    tokens?: Pick<OperationRow, "add_command_id" | "line_id" | "intent_id" | "intent_revision">,
  ) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`collections.recovery:${owner}`]);
    const pending = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM collections_saved_list_operations
      WHERE account_id = $1 AND status IN ('prepared', 'confirmed', 'possible-send')`,
      [owner],
    );
    if (Number(pending.rows[0]?.count) >= 100) throw new SavedListRecoveryError("limit");
    const result = await db.query<OperationRow>(
      `INSERT INTO collections_saved_list_operations
      (operation_id, account_id, status, draft, add_command_id, line_id, intent_id, intent_revision, created_at, expires_at)
      VALUES ($1, $2, 'prepared', $3::jsonb, $4, $5, $6, $7, $8, $9) RETURNING ${columns}`,
      [
        createId("slo"),
        owner,
        JSON.stringify(draft),
        tokens?.add_command_id ?? createId("slc"),
        tokens?.line_id ?? createId("sll"),
        tokens?.intent_id ?? null,
        tokens?.intent_revision ?? null,
        now().toISOString(),
        new Date(now().getTime() + ttl).toISOString(),
      ],
    );
    return result.rows[0]!;
  }
  async function confirmRow(
    db: PgQueryable,
    row: OperationRow,
    destination: SavedListDestination,
    context: EventStoreContext,
  ) {
    const request = canonicalRequest({
      ...row.draft,
      destination,
      addCommandId: row.add_command_id,
      lineId: row.line_id,
    });
    const hash = fingerprint(row, request);
    if (row.request && row.fingerprint !== hash) throw new SavedListRecoveryError("conflict");
    if (!row.request && (row.status !== "prepared" || new Date(row.expires_at).getTime() <= now().getTime()))
      throw new SavedListRecoveryError("expired");
    if (request.destination.kind === "existing") {
      const snapshot = await boundRuntime(db, noCatalog).getOwnerSnapshot(
        { listId: request.destination.listId, ownerAccountId: row.account_id },
        context,
      );
      if (!snapshot) throw new SavedListRecoveryError("not-found");
    }
    if (row.request) return row;
    const changed = await db.query<OperationRow>(
      `UPDATE collections_saved_list_operations
      SET request = $4::jsonb, fingerprint = $5, status = 'confirmed', revision = revision + 1
      WHERE operation_id = $1 AND account_id = $2 AND revision = $3 AND status = 'prepared' RETURNING ${columns}`,
      [row.operation_id, row.account_id, row.revision, JSON.stringify(request), hash],
    );
    if (changed.rows.length !== 1) throw new SavedListRecoveryError("conflict");
    return changed.rows[0]!;
  }
  return {
    expire,
    async prepare(input: PrepareSavedListOperation, context: EventStoreContext) {
      context = { ...context, audit: { ...context.audit } };
      const owner = await account(context);
      const draft = canonicalDraft(input);
      await validateProduct(draft, deps.productCatalog);
      await expire(context);
      return withPgTransaction(deps.pool, async (db) => output(await insert(db, owner, draft)));
    },
    async confirm(input: ConfirmSavedListOperation, context: EventStoreContext) {
      context = { ...context, audit: { ...context.audit } };
      const owner = await account(context);
      return withPgTransaction(deps.pool, async (db) => {
        const row = await readRow(db, input.operationId, owner, true);
        if (!row) throw new SavedListRecoveryError("not-found");
        if (row.revision !== input.revision) throw new SavedListRecoveryError("conflict");
        return output(await confirmRow(db, row, input.destination, context));
      });
    },
    async beginSend(input: SavedListOperationReference, context: EventStoreContext) {
      context = { ...context, audit: { ...context.audit } };
      const owner = await account(context);
      return withPgTransaction(deps.pool, async (db) => {
        const row = await readRow(db, input.operationId, owner, true);
        if (!row) throw new SavedListRecoveryError("not-found");
        if (row.revision !== input.revision || row.status !== "confirmed") throw new SavedListRecoveryError("conflict");
        if (new Date(row.expires_at).getTime() <= now().getTime()) throw new SavedListRecoveryError("expired");
        const changed = await db.query<OperationRow>(
          `UPDATE collections_saved_list_operations
          SET status = 'possible-send', revision = revision + 1, send_revision = revision + 1
          WHERE operation_id = $1 AND account_id = $2 AND revision = $3 AND status = 'confirmed' RETURNING ${columns}`,
          [row.operation_id, owner, row.revision],
        );
        if (changed.rows.length !== 1) throw new SavedListRecoveryError("conflict");
        return output(changed.rows[0]!);
      });
    },
    // The locked re-read, receipt proof, aggregate append and finalization share one transaction.
    async apply(input: SavedListOperationReference, context: EventStoreContext) {
      context = { ...context, audit: { ...context.audit } };
      const owner = await account(context);
      const before = await readRow(deps.pool, input.operationId, owner);
      if (!before) throw new SavedListRecoveryError("not-found");
      if (before.status === "expired") throw new SavedListRecoveryError("expired");
      if (before.send_revision !== input.revision) throw new SavedListRecoveryError("conflict");
      if (before.status === "rejected") {
        lineInput(before);
        return output(before);
      }
      // Catalog is resolved before acquiring the recovery row or starting SQL work.
      const prior = await receipt(deps.pool, before, context);
      if (prior) return output(before, prior);
      await validateProduct(before.draft, deps.productCatalog);
      const validatedCatalog: SavedListProductCatalog = {
        resolveProduct: async (selection) => {
          if (
            JSON.stringify(savedListCanonicalProduct(selection)) !==
            JSON.stringify(savedListCanonicalProduct(before.draft.product))
          )
            throw new SavedListRecoveryError("conflict");
          return { availability: "active", product: selection };
        },
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let rolledBack = false;
        const transactionPool: PgTransactionalPool = {
          query: deps.pool.query.bind(deps.pool),
          idleInTransactionSessionTimeoutMillis: deps.pool.idleInTransactionSessionTimeoutMillis,
          connect: async () => {
            const client = await deps.pool.connect();
            return {
              release: (error) => client.release(error),
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                const result = await client.query<Row>(sql, values);
                if (sql === "ROLLBACK") rolledBack = true;
                return result;
              },
            };
          },
        };
        try {
          return await withPgTransaction(transactionPool, async (db) => {
            const row = await readRow(db, input.operationId, owner, true);
            if (!row) throw new SavedListRecoveryError("not-found");
            if (row.status === "expired") throw new SavedListRecoveryError("expired");
            if (row.send_revision !== input.revision || row.fingerprint !== before.fingerprint)
              throw new SavedListRecoveryError("conflict");
            const found = await receipt(db, row, context);
            if (found) return output(row, found);
            if (row.status !== "possible-send" || new Date(row.expires_at).getTime() <= now().getTime())
              throw new SavedListRecoveryError("expired");
            await lockIntent(db, row);
            const request = row.request!;
            const runtime = boundRuntime(db, validatedCatalog);
            if (request.destination.kind === "new")
              await runtime.createSavedList(
                {
                  commandId: request.destination.createCommandId,
                  listId: request.destination.listId,
                  ownerAccountId: owner,
                  title: request.destination.title,
                },
                context,
              );
            const snapshot = await runtime.getOwnerSnapshot(
              { listId: request.destination.listId, ownerAccountId: owner },
              context,
            );
            if (!snapshot) throw new SavedListRecoveryError("not-found");
            const result = await runtime.applyLineChanges(lineInput(row, snapshot.version), context);
            const applied = result.receipt.lineResults.some((line) => line.status !== "rejected");
            const terminal = await update(
              db,
              row,
              applied ? "applied" : "rejected",
              true,
              applied ? null : (result.receipt.lineResults[0]?.error?.code ?? null),
            );
            await finishIntent(db, row, !applied);
            return output(terminal, applied ? result : null);
          });
        } catch (error) {
          if (!(error instanceof SavedListConcurrencyConflictError) || attempt === 1) throw error;
          if (!rolledBack) throw new SavedListRecoveryError("conflict");
        }
      }
      throw new SavedListRecoveryError("conflict");
    },
    async get(id: string, context: EventStoreContext) {
      context = { ...context, audit: { ...context.audit } };
      const row = await readRow(deps.pool, id, await account(context));
      return row ? output(row, await receipt(deps.pool, row, context)) : null;
    },
    async list(input: Readonly<{ cursor?: string }>, context: EventStoreContext): Promise<SavedListRecoveryPage> {
      context = { ...context, audit: { ...context.audit } };
      const owner = await account(context);
      let cursor: [string, string] | null = null;
      if (input.cursor) {
        try {
          const parsed: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
          if (
            !Array.isArray(parsed) ||
            parsed.length !== 2 ||
            typeof parsed[0] !== "string" ||
            new Date(parsed[0]).toISOString() !== parsed[0] ||
            typeof parsed[1] !== "string"
          )
            throw new Error();
          cursor = [parsed[0], savedListCanonicalIdentifier(parsed[1])];
        } catch {
          throw new SavedListRecoveryError("invalid-request");
        }
      }
      const rows = await deps.pool.query<OperationRow>(
        `SELECT ${columns} FROM collections_saved_list_operations
        WHERE account_id = $1 AND ($2::timestamptz IS NULL OR (created_at, operation_id) > ($2::timestamptz, $3))
        ORDER BY created_at, operation_id LIMIT 21`,
        [owner, cursor?.[0] ?? null, cursor?.[1] ?? null],
      );
      const page = rows.rows.slice(0, 20);
      const last = page.at(-1);
      return {
        items: page.map((row) => output(row)),
        nextCursor:
          rows.rows.length > 20 && last
            ? Buffer.from(JSON.stringify([new Date(last.created_at).toISOString(), last.operation_id])).toString(
                "base64url",
              )
            : null,
      };
    },
    async reserveAnonymous(
      input: Readonly<{
        anonymousOwnerId: string;
        intentId: string;
        destination: SavedListDestination;
        trackedQuantity: number;
      }>,
      context: EventStoreContext,
    ) {
      context = { ...context, audit: { ...context.audit } };
      const owner = await account(context);
      const raw = savedListCanonicalIdentifier(input.anonymousOwnerId);
      if (!raw.startsWith("anon_")) throw new SavedListRecoveryError("invalid-request");
      const hash = savedListFingerprint(["collections.anonymous-owner.v1", raw]);
      const load = async (db: PgQueryable, lock = false) => {
        const result = await db.query<{
          intent_id: string;
          owner_revision: number;
          source_surface: PrepareSavedListOperation["sourceSurface"];
          catalog_catalog_item_id: string;
          product_id: string;
          selected_options: unknown;
          add_command_id: OperationRow["add_command_id"];
          line_id: OperationRow["line_id"];
          status: string;
          expires_at: string;
        }>(
          `SELECT intent_id, owner_revision, source_surface,
          catalog_catalog_item_id, product_id, selected_options, add_command_id, line_id, status, expires_at
          FROM collections_anonymous_saved_list_intents WHERE intent_id = $1
          AND (anonymous_owner_fingerprint = $2 OR (anonymous_owner_fingerprint IS NULL AND anonymous_owner_id = $3))${lock ? " FOR UPDATE" : ""}`,
          [savedListCanonicalIdentifier(input.intentId), hash, raw],
        );
        if (!result.rows[0]) throw new SavedListRecoveryError("not-found");
        return result.rows[0];
      };
      const before = await load(deps.pool);
      const draft = canonicalDraft({
        product: {
          catalogItemId: before.catalog_catalog_item_id as SavedListProductSelection["catalogItemId"],
          productId: before.product_id as SavedListProductSelection["productId"],
          selectedOptions: before.selected_options as SavedListProductSelection["selectedOptions"],
        },
        sourceSurface: before.source_surface,
        trackedQuantity: input.trackedQuantity,
      });
      await validateProduct(draft, deps.productCatalog);
      return withPgTransaction(deps.pool, async (db) => {
        const existing = await db.query<OperationRow>(
          `SELECT ${columns} FROM collections_saved_list_operations
          WHERE intent_id = $1 FOR UPDATE`,
          [input.intentId],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.account_id !== owner || JSON.stringify(canonicalDraft(row.draft)) !== JSON.stringify(draft))
            throw new SavedListRecoveryError("conflict");
          return output(await confirmRow(db, row, input.destination, context));
        }
        const intent = await load(db, true);
        if (
          intent.status !== "active" ||
          intent.owner_revision !== before.owner_revision ||
          new Date(intent.expires_at).getTime() <= now().getTime()
        )
          throw new SavedListRecoveryError("conflict");
        const target = canonicalDestination(input.destination);
        const reserved = await db.query<{ owner_revision: number }>(
          `UPDATE collections_anonymous_saved_list_intents
          SET anonymous_owner_fingerprint = $3, status = 'claiming', claimed_account_id = $4, claimed_list_id = $5,
          claimed_create_command_id = $6, claimed_list_title = $7, claimed_tracked_quantity = $8,
          owner_revision = owner_revision + 1, updated_at = $9
          WHERE intent_id = $1 AND owner_revision = $2 AND status = 'active' RETURNING owner_revision`,
          [
            intent.intent_id,
            intent.owner_revision,
            hash,
            owner,
            target.listId,
            target.kind === "new" ? target.createCommandId : null,
            target.kind === "new" ? target.title : null,
            draft.trackedQuantity,
            now().toISOString(),
          ],
        );
        if (reserved.rows.length !== 1) throw new SavedListRecoveryError("conflict");
        const row = await insert(db, owner, draft, {
          add_command_id: intent.add_command_id,
          line_id: intent.line_id,
          intent_id: intent.intent_id,
          intent_revision: reserved.rows[0]!.owner_revision,
        });
        return output(await confirmRow(db, row, target, context));
      });
    },
  };
}

function canonicalDraft(input: PrepareSavedListOperation): PrepareSavedListOperation {
  try {
    const [catalogItemId, productId, options] = savedListCanonicalProduct(input.product);
    if (
      !Number.isInteger(input.trackedQuantity) ||
      input.trackedQuantity < 1 ||
      input.trackedQuantity > 1_000_000 ||
      !["search", "item-detail"].includes(input.sourceSurface)
    )
      throw new Error();
    return {
      product: {
        catalogItemId: catalogItemId as SavedListProductSelection["catalogItemId"],
        productId: productId as SavedListProductSelection["productId"],
        selectedOptions: options.map(([dimensionId, optionId]) => ({ dimensionId, optionId })),
      },
      trackedQuantity: input.trackedQuantity,
      sourceSurface: input.sourceSurface,
    };
  } catch {
    throw new SavedListRecoveryError("invalid-request");
  }
}
function canonicalDestination(target: SavedListDestination): SavedListDestination {
  const listId = savedListCanonicalIdentifier(target.listId) as SavedListDestination["listId"];
  if (target.kind === "existing") return { kind: "existing", listId };
  if (target.kind !== "new") throw new SavedListRecoveryError("invalid-request");
  return {
    kind: "new",
    listId,
    createCommandId: savedListCanonicalIdentifier(
      target.createCommandId,
    ) as AddProductToSavedListRequest["addCommandId"],
    title: savedListCanonicalTitle(target.title),
  };
}
function canonicalRequest(input: AddProductToSavedListRequest): AddProductToSavedListRequest {
  return {
    ...canonicalDraft(input),
    destination: canonicalDestination(input.destination),
    addCommandId: savedListCanonicalIdentifier(input.addCommandId) as AddProductToSavedListRequest["addCommandId"],
    lineId: savedListCanonicalIdentifier(input.lineId) as AddProductToSavedListRequest["lineId"],
  };
}
async function validateProduct(draft: PrepareSavedListOperation, catalog: SavedListProductCatalog) {
  try {
    const resolved = await catalog.resolveProduct(draft.product);
    if (
      resolved.availability !== "active" ||
      !resolved.product ||
      JSON.stringify(savedListCanonicalProduct(resolved.product)) !==
        JSON.stringify(savedListCanonicalProduct(draft.product))
    )
      throw new SavedListRecoveryError("invalid-request");
  } catch (error) {
    if (error instanceof SavedListRecoveryError) throw error;
    throw new SavedListRecoveryError("catalog-unavailable");
  }
}
