import { randomBytes, randomUUID } from "node:crypto";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  compareConnectorSecret,
  connectorRecord,
  connectorSecretDigest,
  connectorString,
  type ConnectorOAuthService,
} from "../../../support/request-support/connector-oauth";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import {
  decideChannelConnection,
  evolveChannelConnection,
  initialChannelConnectionState,
} from "../../connections/domain/domain";
import {
  ChannelConnectionError,
  type ChannelConnectionServices,
  type ChannelConnectionState,
} from "../../connections/domain/contracts";
import {
  ConnectorPairingError,
  connectorOperations,
  type ConnectorAuthority,
  type ConnectorIdentity,
  type ConnectorOperation,
  type ConnectorPairingDetail,
} from "../domain/contracts";

type PairingRow = {
  pairing_id: string;
  connection_id: string;
  account_id: string;
  user_id: string;
  state: "code" | "paired" | "closed";
  revision: number;
  code_hash: string | null;
  code_expires_at: Date | string;
  grant_id: string | null;
  last_seen_at: Date | string | null;
};
type ConnectionQuery = Readonly<{ accountId: string; connectionId: string }>;
type Seller = Readonly<{ userId: string; accountId: string; permissions: readonly string[] }>;
type Identify = (identity: ConnectorIdentity) => void;
const ignoreIdentity: Identify = () => {};

export function createConnectorFeedRuntime(
  deps: Readonly<{
    db: PgTransactionalPool;
    eventStore: PostgresEventStore;
    oauth?: ConnectorOAuthService;
    now?: () => Date;
  }>,
) {
  const now = deps.now ?? (() => new Date());
  function oauth(): ConnectorOAuthService {
    if (!deps.oauth) throw new ConnectorPairingError("unavailable");
    return deps.oauth;
  }
  function query(input: ConnectionQuery): ConnectionQuery {
    const value = connectorRecord(input, ["accountId", "connectionId"]);
    return { accountId: connectorString(value.accountId), connectionId: connectorString(value.connectionId) };
  }
  async function transact<T>(
    input: ConnectionQuery,
    work: (db: PgQueryable, state: ChannelConnectionState, version: number) => Promise<T>,
  ): Promise<T> {
    const checked = query(input);
    return withPgTransaction(deps.db, async (db) => {
      const streamId = `channels.connection-${checked.connectionId}`;
      await db.query("SELECT stream_id FROM event_store_streams WHERE stream_id = $1 FOR UPDATE", [streamId]);
      const reader = createPostgresEventStore({
        pool: { query: db.query.bind(db), connect: deps.db.connect.bind(deps.db) },
      });
      const events = await readCompleteStream(reader, { streamId });
      const state = events.reduce(
        (current, event) => evolveChannelConnection(current, channelConnectionEventCodec.decode(event)),
        initialChannelConnectionState,
      );
      if (state.connectionId !== checked.connectionId || state.accountId !== checked.accountId)
        throw new ConnectorPairingError("connection-not-found");
      return work(db, state, events.at(-1)?.streamVersion ?? 0);
    });
  }
  async function latest(db: PgQueryable, connectionId: string): Promise<PairingRow | null> {
    const rows = await db.query<PairingRow>(
      `SELECT * FROM channel_connector_pairings WHERE connection_id = $1
      ORDER BY created_sequence DESC LIMIT 1 FOR UPDATE`,
      [connectionId],
    );
    return rows.rows[0] ?? null;
  }
  async function close(db: PgQueryable, pairing: PairingRow): Promise<void> {
    if (pairing.state === "closed") return;
    // Auth commits first. A Channels rollback may retain a revoked pairing, never a usable replacement.
    await oauth().revokePairing({
      connectionId: pairing.connection_id,
      accountId: pairing.account_id,
      pairingId: pairing.pairing_id,
      userId: pairing.user_id,
    });
    const result = await db.query(
      `UPDATE channel_connector_pairings SET state = 'closed', closed_at = $1,
      code_hash = NULL, revision = revision + 1 WHERE pairing_id = $2 AND revision = $3 AND state = $4 RETURNING pairing_id`,
      [now().toISOString(), pairing.pairing_id, pairing.revision, pairing.state],
    );
    if (result.rows.length !== 1) throw new ConnectorPairingError("conflict");
    await publishPairing(db, pairing, "closed", pairing.revision + 1, pairing.grant_id);
  }
  async function publishPairing(
    db: PgQueryable,
    pairing: Pick<PairingRow, "pairing_id" | "connection_id" | "account_id" | "user_id">,
    state: PairingRow["state"],
    revision: number,
    grantId: string | null,
  ) {
    const reader = createPostgresEventStore({
      pool: { query: db.query.bind(db), connect: deps.db.connect.bind(deps.db) },
    });
    const connectionEvents = await readCompleteStream(reader, {
      streamId: `channels.connection-${pairing.connection_id}`,
    });
    const opening = connectionEvents[0];
    if (!opening) throw new ConnectorPairingError("connection-not-found");
    await deps.eventStore.appendToStreamInTransaction(db, {
      streamId: `channels.connector-pairing-${pairing.pairing_id}`,
      expectedVersion: revision === 1 ? "no_stream" : revision - 1,
      wakeSourceContextName: "channels",
      context: {
        tenantId: opening.tenantId,
        audit: { performedByUserId: parseTypedId(pairing.user_id, "usr"), forAccountId: opening.forAccountId },
      },
      events: [
        {
          eventType: `channels.connector-pairing.${state === "code" ? "code-created" : state === "paired" ? "paired" : "closed"}`,
          payload: {
            pairingId: pairing.pairing_id,
            connectionId: pairing.connection_id,
            accountId: pairing.account_id,
            userId: pairing.user_id,
            state,
            revision,
            grantId,
            occurredAt: now().toISOString(),
          },
        },
      ],
    });
  }
  async function sellerAllowed(seller: Seller, input: ConnectionQuery): Promise<void> {
    if (
      seller.accountId !== input.accountId ||
      !seller.permissions.includes("channels.manage") ||
      !(await oauth().hasMembership(seller.userId, input.accountId))
    )
      throw new ConnectorPairingError("authorization-refused");
  }
  async function readAuthorityLocked(
    db: PgQueryable,
    input: ConnectionQuery,
    state: ChannelConnectionState,
  ): Promise<ConnectorAuthority> {
    let pairing = await latest(db, input.connectionId);
    const grant = pairing?.grant_id ? await oauth().readGrant(pairing.grant_id) : null;
    const bound =
      !!pairing &&
      !!grant &&
      grant.connectionId === input.connectionId &&
      grant.accountId === input.accountId &&
      grant.pairingId === pairing.pairing_id &&
      grant.grantId === pairing.grant_id &&
      grant.userId === pairing.user_id;
    const connected = state.status === "active" || state.status === "paused";
    if (
      pairing &&
      pairing.state !== "closed" &&
      (!connected ||
        (pairing.state === "code" && new Date(pairing.code_expires_at).getTime() <= now().getTime()) ||
        (pairing.state === "paired" && (!bound || !grant?.valid)))
    ) {
      await close(db, pairing);
      pairing = { ...pairing, state: "closed" };
    }
    const live = connected && pairing?.state === "paired" && bound && grant?.valid === true;
    const membership = live && grant ? await oauth().hasMembership(grant.userId, grant.accountId) : false;
    if (!state.status) throw new ConnectorPairingError("connection-not-found");
    return {
      connectionId: input.connectionId,
      accountId: input.accountId,
      connectionState: state.status,
      inbound: live ? "live" : pairing?.state === "closed" ? "revoked" : "absent",
      pairingId: pairing?.pairing_id ?? null,
      grant: bound ? grant : null,
      claimReportAllowed: membership,
    };
  }
  async function readAuthority(input: ConnectionQuery): Promise<ConnectorAuthority> {
    return transact(input, (db, state) => readAuthorityLocked(db, input, state));
  }
  async function detail(input: ConnectionQuery, identify: Identify = ignoreIdentity): Promise<ConnectorPairingDetail> {
    return transact(input, async (db, state) => {
      identify({ connectionId: input.connectionId, pairingId: null });
      const before = await latest(db, input.connectionId);
      await readAuthorityLocked(db, input, state);
      const pairing = await latest(db, input.connectionId);
      identify({ connectionId: input.connectionId, pairingId: pairing?.pairing_id ?? null });
      const expired = before?.state === "code" && new Date(before.code_expires_at).getTime() <= now().getTime();
      return {
        state: expired ? "expired" : !pairing || pairing.state === "closed" ? "unpaired" : pairing.state,
        pairingId: pairing?.pairing_id ?? null,
        revision: pairing?.revision ?? null,
        codeExpiresAt: pairing ? new Date(pairing.code_expires_at).toISOString() : null,
        lastSeenAt: pairing?.last_seen_at ? new Date(pairing.last_seen_at).toISOString() : null,
      };
    });
  }
  async function createPairingCode(input: ConnectionQuery, seller: Seller, identify: Identify = ignoreIdentity) {
    await sellerAllowed(seller, input);
    return transact(input, async (db, state) => {
      identify({ connectionId: input.connectionId, pairingId: null });
      if (state.status !== "active" && state.status !== "paused")
        throw new ConnectorPairingError("authorization-refused");
      const previous = await latest(db, input.connectionId);
      if (previous) await close(db, previous);
      const pairingId = `pair_${randomUUID()}`;
      const code = randomBytes(32).toString("base64url");
      const at = now();
      const expiresAt = new Date(at.getTime() + 600_000).toISOString();
      await db.query(
        `INSERT INTO channel_connector_pairings
        (pairing_id, connection_id, account_id, user_id, state, revision, code_hash, code_expires_at, created_at)
        VALUES ($1,$2,$3,$4,'code',1,$5,$6,$7)`,
        [
          pairingId,
          input.connectionId,
          input.accountId,
          seller.userId,
          connectorSecretDigest(code),
          expiresAt,
          at.toISOString(),
        ],
      );
      await publishPairing(
        db,
        {
          pairing_id: pairingId,
          connection_id: input.connectionId,
          account_id: input.accountId,
          user_id: seller.userId,
        },
        "code",
        1,
        null,
      );
      identify({ connectionId: input.connectionId, pairingId });
      return { pairingId, revision: 1, code, expiresAt };
    });
  }
  async function consumePairingCode(input: unknown, seller: Seller, identify: Identify = ignoreIdentity) {
    const body = connectorRecord(input, [
      "pairing_code",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
    ]);
    const code = connectorString(body.pairing_code);
    const result = await deps.db.query<PairingRow>("SELECT * FROM channel_connector_pairings WHERE code_hash = $1", [
      connectorSecretDigest(code),
    ]);
    const found = result.rows[0];
    if (
      !compareConnectorSecret(code, found?.code_hash ?? "0".repeat(64)) ||
      !found ||
      found.account_id !== seller.accountId ||
      found.user_id !== seller.userId
    )
      throw new ConnectorPairingError("invalid-credential");
    const target = { accountId: found.account_id, connectionId: found.connection_id };
    await sellerAllowed(seller, target);
    return transact(target, async (db, state) => {
      const pairing = await latest(db, target.connectionId);
      if (
        !pairing ||
        pairing.pairing_id !== found.pairing_id ||
        pairing.state !== "code" ||
        !compareConnectorSecret(code, pairing.code_hash ?? "0".repeat(64))
      )
        throw new ConnectorPairingError("invalid-credential");
      identify({ connectionId: target.connectionId, pairingId: pairing.pairing_id });
      if (new Date(pairing.code_expires_at).getTime() <= now().getTime())
        throw new ConnectorPairingError("pairing-expired");
      if (state.status !== "active" && state.status !== "paused")
        throw new ConnectorPairingError("authorization-refused");
      const authorized = await oauth().authorize(
        {
          client_id: body.client_id,
          redirect_uri: body.redirect_uri,
          code_challenge: body.code_challenge,
          code_challenge_method: body.code_challenge_method,
        },
        { ...target, pairingId: pairing.pairing_id, userId: pairing.user_id },
      );
      const updated = await db.query(
        `UPDATE channel_connector_pairings SET state = 'paired', code_hash = NULL,
        grant_id = $1, revision = revision + 1 WHERE pairing_id = $2 AND revision = $3 AND state = 'code' RETURNING pairing_id`,
        [authorized.grantId, pairing.pairing_id, pairing.revision],
      );
      if (updated.rows.length !== 1) throw new ConnectorPairingError("conflict");
      await publishPairing(db, pairing, "paired", pairing.revision + 1, authorized.grantId);
      return { code: authorized.code };
    });
  }
  async function unpair(
    input: ConnectionQuery,
    pairingId: string,
    revision: number,
    seller: Seller,
    identify: Identify = ignoreIdentity,
  ) {
    connectorString(pairingId);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ConnectorPairingError("invalid-request");
    await sellerAllowed(seller, input);
    await transact(input, async (db) => {
      identify({ connectionId: input.connectionId, pairingId: null });
      const pairing = await latest(db, input.connectionId);
      if (!pairing || pairing.pairing_id !== pairingId) throw new ConnectorPairingError("conflict");
      identify({ connectionId: input.connectionId, pairingId });
      if (pairing.state === "closed") return;
      if (pairing.revision !== revision) throw new ConnectorPairingError("conflict");
      await close(db, pairing);
    });
  }
  const disconnectChannelConnection: ChannelConnectionServices["disconnectChannelConnection"] = async (
    input,
    context: EventStoreContext,
  ) => {
    try {
      return await transact(input, async (db, state, version) => {
        const pairing = await latest(db, input.connectionId);
        if (pairing) await close(db, pairing);
        const newEvents = decideChannelConnection(state, { type: "DisconnectChannelConnection" });
        const storedEvents = newEvents.length
          ? await deps.eventStore.appendToStreamInTransaction(db, {
              streamId: `channels.connection-${input.connectionId}`,
              expectedVersion: version,
              events: newEvents.map(channelConnectionEventCodec.encode),
              context,
              wakeSourceContextName: "channels",
            })
          : [];
        return {
          state: newEvents.reduce(evolveChannelConnection, state),
          version: version + newEvents.length,
          newEvents,
          storedEvents,
        };
      });
    } catch (error) {
      if (error instanceof ConnectorPairingError && error.code === "connection-not-found")
        throw new ChannelConnectionError("connection-not-found");
      throw error;
    }
  };
  async function withAuthority<T>(
    input: Readonly<{ token: string; connectionId: string; operation: ConnectorOperation }>,
    work: (authority: ConnectorAuthority, db: PgQueryable) => Promise<T>,
    identify: Identify = ignoreIdentity,
  ): Promise<T> {
    const checked = connectorRecord(input, ["token", "connectionId", "operation"]);
    const token = connectorString(checked.token);
    const connectionId = connectorString(checked.connectionId);
    if (!connectorOperations.some((operation) => operation === checked.operation))
      throw new ConnectorPairingError("invalid-request");
    const grant = await oauth().resolveToken(token);
    if (!grant || grant.connectionId !== connectionId) throw new ConnectorPairingError("invalid-credential");
    return transact({ accountId: grant.accountId, connectionId }, async (db, state) => {
      const current = await oauth().resolveToken(token);
      const authority = await readAuthorityLocked(db, { accountId: grant.accountId, connectionId }, state);
      if (
        !current ||
        current.grantId !== authority.grant?.grantId ||
        authority.pairingId !== grant.pairingId ||
        authority.inbound !== "live"
      )
        throw new ConnectorPairingError("invalid-credential");
      identify({ connectionId, pairingId: grant.pairingId });
      if (checked.operation !== "ingest" && !authority.claimReportAllowed)
        throw new ConnectorPairingError("authorization-refused");
      return work(authority, db);
    });
  }
  async function exchange(input: unknown, identify: Identify = ignoreIdentity) {
    const exchanged = await oauth().exchange(input);
    const authority = await readAuthority({
      accountId: exchanged.grant.accountId,
      connectionId: exchanged.grant.connectionId,
    });
    if (authority.inbound !== "live" || authority.grant?.grantId !== exchanged.grant.grantId)
      throw new ConnectorPairingError("invalid-credential");
    identify({ connectionId: authority.connectionId, pairingId: authority.pairingId });
    return exchanged.tokens;
  }
  async function revoke(token: string, identify: Identify = ignoreIdentity) {
    const grant = await oauth().resolveToken(token);
    if (!grant) throw new ConnectorPairingError("invalid-credential");
    await transact({ accountId: grant.accountId, connectionId: grant.connectionId }, async (db) => {
      const pairing = await latest(db, grant.connectionId);
      if (!pairing || pairing.grant_id !== grant.grantId || pairing.pairing_id !== grant.pairingId)
        throw new ConnectorPairingError("invalid-credential");
      identify({ connectionId: grant.connectionId, pairingId: grant.pairingId });
      await close(db, pairing);
    });
  }
  return {
    readAuthority,
    withAuthority,
    detail,
    createPairingCode,
    consumePairingCode,
    unpair,
    disconnectChannelConnection,
    exchange,
    revoke,
    register: (input: unknown) => oauth().register(input),
    resolveSeller: (request: Request) => oauth().resolveSeller(request),
  };
}
export type ConnectorFeedServices = ReturnType<typeof createConnectorFeedRuntime>;
