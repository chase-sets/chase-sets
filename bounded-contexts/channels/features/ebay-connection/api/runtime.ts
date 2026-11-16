import { randomUUID } from "node:crypto";
import { createId } from "@chase-sets/primitives/typed-ids";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { createEbaySubjectCipher } from "../../ebay-account-deletion/domain/subject";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { decodeTokenSet } from "../../credentials/domain/codecs";
import type {
  ChannelCredentialEnvelope,
  ChannelCredentialKeyring,
  ChannelOAuthTokenSet,
} from "../../credentials/domain/contracts";
import type { ChannelConnectionState } from "../../connections/domain/contracts";
import {
  decideChannelConnection,
  evolveChannelConnection,
  initialChannelConnectionState,
} from "../../connections/domain/domain";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { assertOpaqueId } from "../../connections/domain/validation";
import { createConnectionEpochs, type ConnectionEpochs } from "../../connections/api/owner-epochs";
import type { EbayOAuthConfiguration } from "../domain/configuration";
import {
  capabilitiesForConsent,
  createOAuthState,
  EbayConnectionError,
  hashOAuthState,
  scopesForCapabilities,
} from "../domain/oauth";
import { lockEbayConnectionBinding, type EbaySellerBinding } from "../read-model/binding";
import { createEbayOAuthProvider, revokeCurrentGrant, type EbayOAuthProvider } from "./provider";

type Target = Readonly<{ accountId: string; connectionId: string }>;
type Attempt = {
  account_id: string;
  candidate_connection_id: string;
  expected_connection_id: string | null;
  expected_generation: string | null;
  environment: "sandbox";
  ru_name: string;
  capabilities: string[];
  scopes: string[];
  created_at: Date;
};
export function createEbayConnectionRuntime(deps: {
  db: PgTransactionalPool;
  eventStore: PostgresEventStore;
  configuration: EbayOAuthConfiguration | null;
  keyring: ChannelCredentialKeyring | null;
  provider?: EbayOAuthProvider;
  now?: () => Date;
  retireWork?: (db: PgQueryable, connectionId: string) => Promise<void>;
  connectionEpochs?: ConnectionEpochs;
}) {
  const config = deps.configuration;
  const provider = deps.provider ?? (config ? createEbayOAuthProvider(config) : null);
  const credentials = createChannelCredentialRuntime(deps.keyring);
  const cipher = createEbaySubjectCipher(deps.keyring);
  const now = deps.now ?? (() => new Date());
  const connectionEpochs = deps.connectionEpochs ?? createConnectionEpochs(deps.db);
  const configured = () => {
    if (!config || !provider) throw new EbayConnectionError("unavailable");
    return { config, provider };
  };
  async function connection(db: PgQueryable, connectionId: string) {
    const streamId = `channels.connection-${connectionId}`;
    await db.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1 FOR UPDATE", [streamId]);
    const reader = createPostgresEventStore({
      pool: { query: db.query.bind(db), connect: deps.db.connect.bind(deps.db) },
    });
    const events = await readCompleteStream(reader, { streamId });
    return {
      state: events.reduce(
        (state, event) => evolveChannelConnection(state, channelConnectionEventCodec.decode(event)),
        initialChannelConnectionState,
      ),
      version: events.at(-1)?.streamVersion ?? 0,
    };
  }
  async function current(db: PgQueryable, target: Target) {
    const binding = await lockEbayConnectionBinding(db, target.connectionId);
    if (
      !binding ||
      binding.account_id !== target.accountId ||
      binding.current_connection_id !== target.connectionId ||
      !binding.credential_reference
    )
      throw new EbayConnectionError("stale-authorization");
    const envelope = await credentials.readMetadata(db, binding.credential_reference);
    if (
      !envelope ||
      envelope.accountId !== binding.account_id ||
      envelope.connectionId !== target.connectionId ||
      envelope.environment !== binding.environment ||
      envelope.providerKey !== "ebay"
    )
      throw new EbayConnectionError("stale-authorization");
    return { binding, envelope };
  }
  async function tokens(db: PgQueryable, envelope: ChannelCredentialEnvelope) {
    const capability = Object.freeze({});
    const resolver = createChannelCredentialRuntime(deps.keyring, [{ capability, binding: envelope }]);
    const bytes = await resolver.resolve(db, capability, { ...envelope, reference: envelope.rowId });
    try {
      return decodeTokenSet(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  return {
    enabled: config !== null,
    consent: (publication: boolean) => ({
      scopes: scopesForCapabilities(publication),
      capabilities: capabilitiesForConsent(publication),
    }),
    async start(accountId: string, publication: boolean, connectionId: string | null = null) {
      const { config } = configured();
      assertOpaqueId(accountId, "accountId");
      if (typeof publication !== "boolean") throw new EbayConnectionError("invalid-request");
      const state = createOAuthState();
      const at = now();
      await withPgTransaction(deps.db, async (db) => {
        const expected = connectionId ? await current(db, { accountId, connectionId }) : null;
        await db.query(
          `INSERT INTO channels_ebay_oauth_attempts
          (state_hash,account_id,candidate_connection_id,expected_connection_id,expected_generation,environment,ru_name,capabilities,scopes,created_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            hashOAuthState(state),
            accountId,
            createId("chn"),
            connectionId,
            expected?.envelope.tokenGeneration ?? null,
            config.environment,
            config.ruName,
            JSON.stringify(capabilitiesForConsent(publication)),
            JSON.stringify(scopesForCapabilities(publication)),
            at,
            new Date(at.getTime() + 600000),
          ],
        );
      });
      const url = new URL("https://auth.sandbox.ebay.com/oauth2/authorize");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.ruName,
        response_type: "code",
        scope: scopesForCapabilities(publication).join(" "),
        state,
      }).toString();
      return { authorizationUrl: url.toString() };
    },
    async consume(accountId: string, state: string) {
      const { config } = configured();
      const result = await deps.db.query<Attempt>(
        `UPDATE channels_ebay_oauth_attempts SET consumed_at=$1
        WHERE state_hash=$2 AND account_id=$3 AND environment=$4 AND ru_name=$5 AND consumed_at IS NULL AND expires_at>$1
        RETURNING *`,
        [now(), hashOAuthState(state), accountId, config.environment, config.ruName],
      );
      if (result.rows.length !== 1) throw new EbayConnectionError("invalid-state");
      return result.rows[0]!;
    },
    async callback(accountId: string, state: string, code: string, context: EventStoreContext) {
      const { provider, config } = configured();
      if (typeof code !== "string" || !code.length || code.length > 8192)
        throw new EbayConnectionError("invalid-request");
      const attempt = await this.consume(accountId, state);
      const signal = AbortSignal.timeout(20000);
      const candidate = await provider.exchange(code, signal);
      const subject = await provider.identity(candidate.accessToken, signal);
      const fingerprint = cipher.fingerprint(subject);
      const creationKey = `connection/${attempt.candidate_connection_id}`;
      return connectionEpochs.transaction([creationKey], async (db: PgQueryable) => {
        const bindingId = randomUUID();
        const sealed = cipher.seal(bindingId, subject);
        await db.query(
          `INSERT INTO channels_ebay_seller_bindings
          (binding_id,account_id,environment,subject_fingerprint,subject_key_id,iv,ciphertext,tag,capabilities)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]') ON CONFLICT (environment,subject_fingerprint) DO NOTHING`,
          [
            bindingId,
            accountId,
            config.environment,
            fingerprint,
            sealed.keyId,
            sealed.iv,
            sealed.ciphertext,
            sealed.tag,
          ],
        );
        const binding = (
          await db.query<EbaySellerBinding>(
            `SELECT * FROM channels_ebay_seller_bindings WHERE environment=$1 AND subject_fingerprint=$2 FOR UPDATE`,
            [config.environment, fingerprint],
          )
        ).rows[0]!;
        if (binding.account_id !== accountId) throw new EbayConnectionError("seller-conflict");
        cipher.assertAvailable({ fingerprint: binding.subject_fingerprint, keyId: binding.subject_key_id });
        if (attempt.expected_connection_id && attempt.expected_connection_id !== binding.current_connection_id)
          throw new EbayConnectionError("stale-authorization");
        const disconnected = await db.query(
          `SELECT 1 FROM channels_ebay_disconnect_records WHERE binding_id=$1 AND disconnected_at >= $2 LIMIT 1`,
          [binding.binding_id, attempt.created_at],
        );
        if (disconnected.rows.length) throw new EbayConnectionError("stale-authorization");
        let connectionId = binding.current_connection_id;
        let envelope: ChannelCredentialEnvelope;
        if (connectionId) {
          const live = await current(db, { accountId, connectionId });
          if (
            attempt.expected_generation !== null &&
            Number(attempt.expected_generation) !== live.envelope.tokenGeneration
          )
            throw new EbayConnectionError("stale-authorization");
          const loaded = await connection(db, connectionId);
          if (loaded.state.status === "disconnected" || loaded.state.accountId !== accountId)
            throw new EbayConnectionError("stale-authorization");
          envelope = await credentials.supersede(db, live.envelope, candidate, now().toISOString());
          await deps.retireWork?.(db, connectionId);
        } else {
          connectionId = attempt.candidate_connection_id;
          await db.query(
            "UPDATE channels_ebay_seller_bindings SET current_connection_id=$2,credential_reference='pending' WHERE binding_id=$1",
            [binding.binding_id, connectionId],
          );
          envelope = await credentials.create(
            db,
            { accountId, connectionId, providerKey: "ebay", environment: config.environment },
            candidate,
            now().toISOString(),
          );
          const events = decideChannelConnection(initialChannelConnectionState, {
            type: "ConnectChannel",
            accountId,
            connectionId,
            providerKey: "ebay",
            environment: config.environment,
            createdAt: now().toISOString(),
          });
          await deps.eventStore.appendToStreamInTransaction(db, {
            streamId: `channels.connection-${connectionId}`,
            expectedVersion: "no_stream",
            events: events.map(channelConnectionEventCodec.encode),
            context,
            wakeSourceContextName: "channels",
          });
        }
        await db.query(
          "UPDATE channels_ebay_seller_bindings SET credential_reference=$2,capabilities=$3 WHERE binding_id=$1",
          [binding.binding_id, envelope.rowId, JSON.stringify(attempt.capabilities)],
        );
        return { connectionId };
      });
    },
    async beforeConnectionLock(db: PgQueryable, input: Target) {
      await lockEbayConnectionBinding(db, input.connectionId);
    },
    async disconnectEffect(db: PgQueryable, state: ChannelConnectionState) {
      if (state.providerKey !== "ebay") return;
      const target = { accountId: state.accountId!, connectionId: state.connectionId! };
      const { binding, envelope } = await current(db, target);
      let refreshToken: string | null = null;
      try {
        const material = await tokens(db, envelope);
        if (
          material.refresh.kind === "present" &&
          (!material.refresh.expiresAt || Date.parse(material.refresh.expiresAt) > now().getTime())
        )
          refreshToken = material.refresh.token;
      } catch {
        /* Unusable custody still requires local removal. */
      }
      const remote = await revokeCurrentGrant(provider, refreshToken);
      await credentials.delete(db, envelope);
      await db.query(
        `UPDATE channel_outbound_operations SET status='failed',revision=revision+1,terminal_reason='connection-disconnected',terminal_at=$2
        WHERE connection_id=$1 AND status IN ('pending','in-flight')`,
        [target.connectionId, now()],
      );
      await deps.retireWork?.(db, target.connectionId);
      await db.query(
        `INSERT INTO channels_ebay_disconnect_records (connection_id,binding_id,account_id,remote_revocation,seller_instruction,disconnected_at)
        VALUES ($1,$2,$3,$4,'remove-chase-sets-access',$5)`,
        [target.connectionId, binding.binding_id, target.accountId, remote, now()],
      );
      await db.query(
        "UPDATE channels_ebay_seller_bindings SET current_connection_id=NULL,credential_reference=NULL,capabilities='[]' WHERE binding_id=$1",
        [binding.binding_id],
      );
    },
    async detail(target: Target) {
      return withPgTransaction(deps.db, async (db) => {
        const binding = await lockEbayConnectionBinding(db, target.connectionId);
        if (!binding || binding.account_id !== target.accountId) return null;
        const result = await db.query<{ capabilities: string[]; remoteRevocation: string | null }>(
          `SELECT capabilities,NULL::text AS "remoteRevocation" FROM channels_ebay_seller_bindings WHERE current_connection_id=$1 AND account_id=$2
        UNION ALL SELECT '[]'::jsonb,remote_revocation FROM channels_ebay_disconnect_records WHERE connection_id=$1 AND account_id=$2`,
          [target.connectionId, target.accountId],
        );
        const loaded = await connection(db, target.connectionId);
        if (!result.rows[0] || loaded.state.accountId !== target.accountId) return null;
        return { ...result.rows[0], status: loaded.state.status };
      });
    },
    async withCurrentCredential<T>(
      target: Target,
      expectedGeneration: number,
      work: (db: PgQueryable, envelope: ChannelCredentialEnvelope, material: ChannelOAuthTokenSet) => Promise<T>,
    ): Promise<T> {
      return withPgTransaction(deps.db, async (db) => {
        const { envelope } = await current(db, target);
        if (envelope.tokenGeneration !== expectedGeneration) throw new EbayConnectionError("stale-authorization");
        return work(db, envelope, await tokens(db, envelope));
      });
    },
  };
}
export type EbayConnectionServices = ReturnType<typeof createEbayConnectionRuntime>;
