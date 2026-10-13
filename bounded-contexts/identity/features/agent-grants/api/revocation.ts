import { createHash, randomUUID } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { assertRevocationActivationProof, type RevocationActivationProof } from "./revocation-floor";

export const REVOCATION_PHASES = [
  "admitted",
  "identity-terminal",
  "payments-terminal",
  "webhook-excluded",
  "completed",
] as const;
export type RevocationPhase = (typeof REVOCATION_PHASES)[number];
export type RevocationOwner = Readonly<{ operationId: string; accountId: string; grantId: string; revokedAt: string }>;
export type RevocationState = RevocationOwner & Readonly<{ phase: RevocationPhase; version: number }>;
export type RevocationBinding = Readonly<{
  attemptId: string;
  tenantId: string;
  accountId: string;
  grantId: string;
  userId: string;
  sessionId: string;
  provenance: "session" | "token";
  reason: "account_consent_revoked" | "token_revocation";
  intent: "revoke";
  contractVersion: 1;
}>;
export type AgentGrantRevocations = Readonly<{
  isActiveGrant: (accountId: string, grantId: string) => Promise<boolean>;
  withActiveGrant: <T>(accountId: string, grantId: string, work: () => Promise<T>) => Promise<T | null>;
  isActivated: () => Promise<boolean>;
  activate: (proof: RevocationActivationProof, context: EventStoreContext) => Promise<void>;
  pending: () => Promise<readonly Readonly<{ state: RevocationState; context: EventStoreContext }>[]>;
  admit: (binding: RevocationBinding, context: EventStoreContext) => Promise<RevocationState | null>;
  read: (binding: RevocationBinding) => Promise<RevocationState | null>;
  advance: (state: RevocationState, context: EventStoreContext) => Promise<RevocationState>;
  withActiveGrants: <T>(
    accountId: string,
    clientId: string,
    grantIds: readonly string[],
    work: (activeGrantIds: readonly string[]) => Promise<T>,
  ) => Promise<T | null>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HISTORY_EVENTS = 500;
const MAX_HISTORY_BYTES = 64 * 1024;
const ownerKeys = ["accountId", "grantId", "operationId", "revokedAt"];

export function parseRevocationHistory(
  events: readonly Readonly<{ streamVersion: number; eventType: string; payload: unknown }>[],
  expected: Readonly<{ accountId: string; grantId: string }>,
): RevocationState | null {
  if (events.length === 0) return null;
  if (events.length > MAX_HISTORY_EVENTS || Buffer.byteLength(JSON.stringify(events), "utf8") > MAX_HISTORY_BYTES)
    invalidHistory();
  let owner: RevocationOwner | undefined;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalidHistory();
    const value = payload as Record<string, unknown>;
    if (
      Object.keys(value).sort().join() !== ownerKeys.join() ||
      typeof value.operationId !== "string" ||
      !UUID.test(value.operationId) ||
      typeof value.revokedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.revokedAt) ||
      !Number.isFinite(Date.parse(value.revokedAt)) ||
      new Date(value.revokedAt).toISOString() !== value.revokedAt ||
      value.accountId !== expected.accountId ||
      value.grantId !== expected.grantId ||
      !Number.isSafeInteger(event.streamVersion) ||
      event.streamVersion !== index + 1 ||
      index >= REVOCATION_PHASES.length ||
      event.eventType !== `identity.agent-grant-revocation.${REVOCATION_PHASES[index]}`
    )
      invalidHistory();
    const current = value as RevocationOwner;
    if (owner && (current.operationId !== owner.operationId || current.revokedAt !== owner.revokedAt)) invalidHistory();
    owner = current;
  }
  return { ...owner!, phase: REVOCATION_PHASES[events.length - 1], version: events.length };
}

function invalidHistory(): never {
  throw new Error("revocation_history_invalid");
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function ownerStream(accountId: string, grantId: string): string {
  return `identity.agent-grant-revocation-${digest([accountId, grantId])}`;
}
function attemptStream(attemptId: string): string {
  return `identity.agent-grant-revocation-attempt-${attemptId.toLowerCase()}`;
}
export function bindingDigest(binding: RevocationBinding): string {
  if (
    !UUID.test(binding.attemptId) ||
    binding.contractVersion !== 1 ||
    binding.intent !== "revoke" ||
    !["session", "token"].includes(binding.provenance) ||
    !["account_consent_revoked", "token_revocation"].includes(binding.reason) ||
    [binding.tenantId, binding.accountId, binding.grantId, binding.userId, binding.sessionId].some(
      (value) => typeof value !== "string" || value.length === 0 || value.length > 256,
    )
  )
    throw new Error("revocation_binding_invalid");
  return digest([
    binding.attemptId.toLowerCase(),
    binding.tenantId,
    binding.accountId,
    binding.grantId,
    binding.userId,
    binding.sessionId,
    binding.provenance,
    binding.reason,
    binding.intent,
    binding.contractVersion,
  ]);
}

export function createAgentGrantRevocations(
  pool: PgTransactionalPool,
  eventStore: PostgresEventStore,
): AgentGrantRevocations {
  const activationStream = "identity.agent-grant-revocation-release-v1";
  const history = (db: PgQueryable, streamId: string) =>
    readCompleteStream(
      { readStream: (input) => eventStore.readStreamInTransaction(db, input) },
      { streamId, maxEvents: MAX_HISTORY_EVENTS },
    );
  const load = async (db: PgQueryable, binding: Readonly<{ accountId: string; grantId: string }>) => {
    const events = await history(db, ownerStream(binding.accountId, binding.grantId));
    if (events.some((event) => event.forAccountId !== binding.accountId || event.tenantId !== events[0].tenantId))
      invalidHistory();
    return parseRevocationHistory(events, binding);
  };
  const verifyAttempt = async (db: PgQueryable, binding: RevocationBinding): Promise<boolean> => {
    const events = await history(db, attemptStream(binding.attemptId));
    if (!events.length) return false;
    if (
      events.length !== 1 ||
      events[0].eventType !== "identity.agent-grant-revocation-attempt.admitted" ||
      Object.keys(events[0].payload).sort().join() !== "bindingDigest,ownerStream" ||
      events[0].payload.ownerStream !== ownerStream(binding.accountId, binding.grantId) ||
      events[0].payload.bindingDigest !== bindingDigest(binding)
    )
      throw new Error("revocation_conflict");
    return true;
  };
  const grant = async (db: PgQueryable, binding: Readonly<{ accountId: string; grantId: string }>) => {
    const result = await db.query<{ status: string; revoked_at: string | Date | null }>(
      `SELECT status, revoked_at FROM identity_linked_platform_authorizations
       WHERE account_id = $1 AND authorization_id = $2 FOR UPDATE`,
      [binding.accountId, binding.grantId],
    );
    return result.rows[0] ?? null;
  };
  return {
    isActiveGrant: async (accountId, grantId) => {
      const result = await pool.query(
        `SELECT authorization_id FROM identity_linked_platform_authorizations WHERE account_id = $1 AND authorization_id = $2 AND status = 'active'`,
        [accountId, grantId],
      );
      return result.rows.length === 1;
    },
    withActiveGrant: (accountId, grantId, work) =>
      withPgTransaction(pool, async (db) => {
        const result = await db.query(
          `SELECT authorization_id FROM identity_linked_platform_authorizations WHERE account_id = $1 AND authorization_id = $2 AND status = 'active' FOR SHARE`,
          [accountId, grantId],
        );
        return result.rows.length === 1 ? work() : null;
      }),
    isActivated: async () => {
      const events = await readCompleteStream(eventStore, { streamId: activationStream, maxEvents: 500 });
      if (!events.length) return false;
      if (
        events.length !== 1 ||
        events[0].eventType !== "identity.agent-grant-revocation-release.activated" ||
        events[0].payload.supportVersion !== 1
      )
        throw new Error("revocation_support_floor");
      return true;
    },
    activate: async (proof, context) => {
      assertRevocationActivationProof(proof, new Date().toISOString());
      await eventStore.appendToStream({
        streamId: activationStream,
        expectedVersion: 0,
        context,
        events: [
          { eventType: "identity.agent-grant-revocation-release.activated", payload: { supportVersion: 1, proof } },
        ],
      });
    },
    pending: async () => {
      const result = await pool.query<{
        account_id: string;
        grant_id: string;
        tenant_id: string;
        performed_by_user_id: string;
      }>(
        `SELECT payload->>'accountId' AS account_id, payload->>'grantId' AS grant_id, tenant_id, performed_by_user_id
         FROM event_store_events AS admitted WHERE event_type = 'identity.agent-grant-revocation.admitted'
         AND NOT EXISTS (SELECT 1 FROM event_store_events AS completed WHERE completed.stream_id = admitted.stream_id
           AND completed.event_type = 'identity.agent-grant-revocation.completed')
         ORDER BY global_position LIMIT 50`,
      );
      return Promise.all(
        result.rows.map(async (row) => {
          const state = await load(pool, { accountId: row.account_id, grantId: row.grant_id });
          if (!state) invalidHistory();
          return {
            state,
            context: {
              tenantId: row.tenant_id as EventStoreContext["tenantId"],
              audit: {
                performedByUserId: row.performed_by_user_id as EventStoreContext["audit"]["performedByUserId"],
                forAccountId: row.account_id as EventStoreContext["audit"]["forAccountId"],
              },
            },
          };
        }),
      );
    },
    admit: (binding, context) =>
      withPgTransaction(pool, async (db) => {
        const release = await history(db, activationStream);
        if (
          release.length !== 1 ||
          release[0].eventType !== "identity.agent-grant-revocation-release.activated" ||
          release[0].payload.supportVersion !== 1
        )
          throw new Error("revocation_support_floor");
        const boundDigest = bindingDigest(binding);
        if (
          context.tenantId !== binding.tenantId ||
          context.audit.forAccountId !== binding.accountId ||
          context.audit.performedByUserId !== binding.userId
        )
          throw new Error("revocation_binding_invalid");
        const row = await grant(db, binding);
        if (!row) return null;
        if (!["active", "revoked"].includes(row.status)) invalidHistory();
        const existingAttempt = await verifyAttempt(db, binding);
        let state = await load(db, binding);
        if (!state) {
          const revokedAt = row.revoked_at ? new Date(row.revoked_at).toISOString() : new Date().toISOString();
          const owner: RevocationOwner = {
            operationId: binding.attemptId,
            accountId: binding.accountId,
            grantId: binding.grantId,
            revokedAt,
          };
          await eventStore.appendToStreamInTransaction(db, {
            streamId: ownerStream(binding.accountId, binding.grantId),
            expectedVersion: 0,
            context,
            events: [{ eventType: "identity.agent-grant-revocation.admitted", payload: owner }],
          });
          state = { ...owner, phase: "admitted", version: 1 };
        }
        if (!existingAttempt) {
          const admitted = await db.query<{ count: string }>(
            `SELECT count(*) AS count FROM event_store_events
          WHERE event_type = 'identity.agent-grant-revocation-attempt.admitted' AND payload->>'ownerStream' = $1`,
            [ownerStream(binding.accountId, binding.grantId)],
          );
          if (Number(admitted.rows[0]?.count ?? 0) >= 500) throw new Error("revocation_attempt_limit");
          await eventStore.appendToStreamInTransaction(db, {
            streamId: attemptStream(binding.attemptId),
            expectedVersion: 0,
            context,
            events: [
              {
                eventType: "identity.agent-grant-revocation-attempt.admitted",
                payload: { bindingDigest: boundDigest, ownerStream: ownerStream(binding.accountId, binding.grantId) },
              },
            ],
          });
        }
        return state;
      }),
    read: (binding) =>
      withPgTransaction(pool, async (db) => {
        bindingDigest(binding);
        if (!(await grant(db, binding)) || !(await verifyAttempt(db, binding))) return null;
        return load(db, binding);
      }),
    advance: (state, context) =>
      withPgTransaction(pool, async (db) => {
        const row = await grant(db, state);
        const current = await load(db, state);
        if (
          !row ||
          !current ||
          current.operationId !== state.operationId ||
          current.revokedAt !== state.revokedAt ||
          context.audit.forAccountId !== state.accountId
        )
          invalidHistory();
        if (current.version !== state.version || current.phase === "completed") return current;
        const phase = REVOCATION_PHASES[current.version];
        if (phase === "identity-terminal") {
          if (
            !["active", "revoked"].includes(row.status) ||
            (row.status === "revoked" &&
              (!row.revoked_at || new Date(row.revoked_at).toISOString() !== current.revokedAt))
          )
            invalidHistory();
          await db.query(
            `UPDATE identity_linked_platform_authorizations SET status = 'revoked', revoked_at = $3::timestamptz,
          revocation_reason = COALESCE(revocation_reason, 'agent_grant_revocation'), updated_at = now()
          WHERE account_id = $1 AND authorization_id = $2`,
            [state.accountId, state.grantId, state.revokedAt],
          );
        } else if (
          row.status !== "revoked" ||
          !row.revoked_at ||
          new Date(row.revoked_at).toISOString() !== current.revokedAt
        )
          invalidHistory();
        const owner: RevocationOwner = {
          operationId: current.operationId,
          accountId: current.accountId,
          grantId: current.grantId,
          revokedAt: current.revokedAt,
        };
        await eventStore.appendToStreamInTransaction(db, {
          streamId: ownerStream(state.accountId, state.grantId),
          expectedVersion: current.version,
          context,
          events: [{ eventType: `identity.agent-grant-revocation.${phase}`, payload: owner }],
        });
        return { ...owner, phase, version: current.version + 1 };
      }),
    withActiveGrants: createActiveAgentGrantFence(pool),
  };
}

export function createActiveAgentGrantFence(pool: PgTransactionalPool): AgentGrantRevocations["withActiveGrants"] {
  return (accountId, clientId, grantIds, work) =>
    withPgTransaction(pool, async (db) => {
      if (grantIds.length === 0 || grantIds.length > 500 || new Set(grantIds).size !== grantIds.length) return null;
      const result = await db.query<{ authorization_id: string }>(
        `SELECT authorization_id FROM identity_linked_platform_authorizations
        WHERE account_id = $1 AND client_id = $2 AND authorization_id = ANY($3::text[])
          AND status = 'active' AND scopes ? 'order:read' ORDER BY authorization_id FOR SHARE`,
        [accountId, clientId, grantIds],
      );
      return result.rows.length ? work(result.rows.map((row) => row.authorization_id)) : null;
    });
}

export function newRevocationAttemptId(): string {
  return randomUUID();
}
