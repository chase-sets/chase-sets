import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  ChannelConnectionError,
  type ChannelConnectionPage,
  type ChannelConnectionState,
  type ChannelConnectionStatus,
  type PublicChannelConnection,
} from "../domain/contracts";
import {
  assertClosedRecord,
  assertConnectionStatus,
  assertOpaqueId,
  assertProviderKey,
  assertRfc3339Instant,
} from "../domain/validation";

type ChannelConnectionRow = Readonly<{
  connection_id: string;
  account_id: string;
  provider_key: string;
  environment: "sandbox" | "production";
  status: ChannelConnectionStatus;
  created_at: string;
}>;

const columns = "connection_id, account_id, provider_key, environment, status, created_at";
const defaultStatuses = ["pending-setup", "active", "paused"] as const;
const cursorVersion = "channels-connections/v1" as const;

export function toPublicChannelConnection(state: ChannelConnectionState): PublicChannelConnection {
  if (
    state.connectionId === null ||
    state.providerKey === null ||
    state.environment === null ||
    state.status === null ||
    state.createdAt === null
  ) {
    throw new ChannelConnectionError("connection-not-found");
  }
  return {
    connectionId: state.connectionId,
    providerKey: state.providerKey,
    environment: state.environment,
    status: state.status,
    createdAt: state.createdAt,
  };
}

export function closePublicChannelConnection(value: PublicChannelConnection): PublicChannelConnection {
  assertClosedRecord(value, ["connectionId", "providerKey", "environment", "status", "createdAt"], "public connection");
  assertOpaqueId(value.connectionId, "connectionId");
  assertProviderKey(value.providerKey);
  if (value.environment !== "sandbox" && value.environment !== "production") {
    throw new ChannelConnectionError("invalid-input", "public connection environment is invalid.");
  }
  assertConnectionStatus(value.status);
  assertRfc3339Instant(value.createdAt, "createdAt");
  return {
    connectionId: value.connectionId,
    providerKey: value.providerKey,
    environment: value.environment,
    status: value.status,
    createdAt: value.createdAt,
  };
}

export async function getPublicChannelConnection(
  db: PgQueryable,
  input: Readonly<{ accountId: string; connectionId: string }>,
): Promise<PublicChannelConnection | null> {
  assertClosedRecord(input, ["accountId", "connectionId"], "detail query");
  assertOpaqueId(input.accountId, "accountId");
  assertOpaqueId(input.connectionId, "connectionId");
  const result = await db.query<ChannelConnectionRow>(
    `SELECT ${columns}
     FROM channel_connections
     WHERE account_id = $1 AND connection_id = $2`,
    [input.accountId, input.connectionId],
  );
  return result.rows[0] ? rowToPublic(result.rows[0]) : null;
}

export async function listPublicChannelConnections(
  db: PgQueryable,
  input: Readonly<{
    accountId: string;
    cursor?: string;
    limit?: number;
    status?: ChannelConnectionStatus;
  }>,
): Promise<ChannelConnectionPage> {
  assertClosedRecord(input, ["accountId", "cursor", "limit", "status"], "list query");
  assertOpaqueId(input.accountId, "accountId");
  if (input.status !== undefined) assertConnectionStatus(input.status);
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidPage();
  const predicate = input.status ?? "default";
  const statuses: readonly ChannelConnectionStatus[] = input.status === undefined ? defaultStatuses : [input.status];
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor, input.accountId, predicate);
  const values: unknown[] = [input.accountId, statuses, limit + 1];
  const cursorClause = cursor ? "AND (created_at_instant, connection_id) < ($4::timestamptz, $5::text)" : "";
  if (cursor) values.push(cursor.createdAt, cursor.connectionId);
  const result = await db.query<ChannelConnectionRow>(
    `SELECT ${columns}
     FROM channel_connections
     WHERE account_id = $1
       AND status = ANY($2::text[])
       ${cursorClause}
     ORDER BY created_at_instant DESC, connection_id DESC
     LIMIT $3`,
    values,
  );
  const hasNext = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const items = pageRows.map(rowToPublic);
  if (!hasNext || items.length === 0) return { items };
  const tail = items[items.length - 1];
  return {
    items,
    nextCursor: encodeCursor({
      version: cursorVersion,
      accountId: input.accountId,
      predicate,
      createdAt: tail.createdAt,
      connectionId: tail.connectionId,
    }),
  };
}

type CursorPayload = Readonly<{
  version: typeof cursorVersion;
  accountId: string;
  predicate: "default" | ChannelConnectionStatus;
  createdAt: string;
  connectionId: string;
}>;

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, accountId: string, predicate: CursorPayload["predicate"]): CursorPayload {
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) invalidPage();
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) invalidPage();
    const parsed: unknown = JSON.parse(decoded);
    assertClosedRecord(parsed, ["version", "accountId", "predicate", "createdAt", "connectionId"], "cursor");
    if (parsed.version !== cursorVersion || parsed.accountId !== accountId || parsed.predicate !== predicate) {
      invalidPage();
    }
    assertOpaqueId(parsed.accountId, "cursor accountId");
    assertOpaqueId(parsed.connectionId, "cursor connectionId");
    assertRfc3339Instant(parsed.createdAt, "cursor createdAt");
    const parsedPredicate = parsed.predicate;
    if (parsedPredicate !== "default") assertConnectionStatus(parsedPredicate);
    return {
      version: cursorVersion,
      accountId: parsed.accountId,
      predicate: parsedPredicate,
      createdAt: parsed.createdAt,
      connectionId: parsed.connectionId,
    };
  } catch {
    invalidPage();
  }
}

function rowToPublic(row: ChannelConnectionRow): PublicChannelConnection {
  return closePublicChannelConnection({
    connectionId: row.connection_id,
    providerKey: row.provider_key,
    environment: row.environment,
    status: row.status,
    createdAt: row.created_at,
  });
}

function invalidPage(): never {
  throw new ChannelConnectionError("invalid-input", "invalid-page");
}
