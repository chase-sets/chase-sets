import { createHash, randomUUID } from "node:crypto";
import type { AgentOAuthScope } from "@chase-sets/auth-context";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { createAgentGrantRevocationRelease } from "./revocation-release";

export const REVOCATION_PHASES = [
  "admitted",
  "identity-terminal",
  "payments-terminal",
  "webhook-excluded",
  "completed",
] as const;
export type RevocationPhase = (typeof REVOCATION_PHASES)[number];
export type RevocationOwner = Readonly<{
  operationId: string;
  accountId: string;
  grantId: string;
  revokedAt: string;
  reason: string | null;
  provenance: "session" | "token" | "adoption";
}>;
type RevocationProgress = RevocationOwner & Readonly<{ phase: RevocationPhase; version: number }>;
export type RevocationState = RevocationProgress & Readonly<{ effectContext: EventStoreContext }>;
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
  activate: ReturnType<typeof createAgentGrantRevocationRelease>["activate"];
  activationProof: ReturnType<typeof createAgentGrantRevocationRelease>["activationProof"];
  withMode: ReturnType<typeof createAgentGrantRevocationRelease>["withMode"];
  pending: () => Promise<
    readonly (
      | Readonly<{ state: RevocationState; context: EventStoreContext }>
      | Readonly<{ failure: "revocation_history_invalid" }>
    )[]
  >;
  admit: (binding: RevocationBinding, context: EventStoreContext) => Promise<RevocationState | null>;
  read: (binding: RevocationBinding) => Promise<RevocationState | null>;
  readProgress: (accountId: string, grantId: string) => Promise<RevocationPhase | null>;
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
const ownerKeys = ["accountId", "grantId", "operationId", "provenance", "reason", "revokedAt"];

export function parseRevocationHistory(
  events: readonly Readonly<{ streamVersion: number; eventType: string; payload: unknown }>[],
  expected: Readonly<{ accountId: string; grantId: string }>,
): RevocationProgress | null {
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
      typeof value.provenance !== "string" ||
      !["session", "token", "adoption"].includes(value.provenance) ||
      !(
        value.reason === null ||
        (typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 128)
      ) ||
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
    if (
      owner &&
      (current.operationId !== owner.operationId ||
        current.revokedAt !== owner.revokedAt ||
        current.reason !== owner.reason ||
        current.provenance !== owner.provenance)
    )
      invalidHistory();
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
  instanceId?: string,
): AgentGrantRevocations {
  const release = createAgentGrantRevocationRelease(pool, eventStore, instanceId);
  const history = (db: PgQueryable, streamId: string) =>
    readCompleteStream(
      { readStream: (input) => eventStore.readStreamInTransaction(db, input) },
      { streamId, maxEvents: MAX_HISTORY_EVENTS },
    );
  const load = async (db: PgQueryable, binding: Readonly<{ accountId: string; grantId: string }>) => {
    const events = await history(db, ownerStream(binding.accountId, binding.grantId));
    if (events.some((event) => event.forAccountId !== binding.accountId || event.tenantId !== events[0].tenantId))
      invalidHistory();
    const progress = parseRevocationHistory(events, binding);
    if (!progress) return null;
    const first = events[0];
    return {
      ...progress,
      effectContext: {
        tenantId: first.tenantId,
        audit: { performedByUserId: first.performedByUserId, forAccountId: first.forAccountId },
      },
    };
  };
  const verifyAttempt = async (db: PgQueryable, binding: RevocationBinding): Promise<boolean> => {
    const events = await history(db, attemptStream(binding.attemptId));
    if (!events.length) return false;
    if (
      events.length !== 1 ||
      events[0].eventType !== "identity.agent-grant-revocation-attempt.admitted" ||
      events[0].tenantId !== binding.tenantId ||
      events[0].forAccountId !== binding.accountId ||
      events[0].performedByUserId !== binding.userId ||
      Object.keys(events[0].payload).sort().join() !== "bindingDigest,ownerStream" ||
      events[0].payload.ownerStream !== ownerStream(binding.accountId, binding.grantId) ||
      events[0].payload.bindingDigest !== bindingDigest(binding)
    )
      throw new Error("revocation_conflict");
    return true;
  };
  const grant = async (db: PgQueryable, binding: Readonly<{ accountId: string; grantId: string }>) => {
    const result = await db.query<{
      status: string;
      revoked_at: string | Date | null;
      revocation_reason: string | null;
    }>(
      `SELECT status, revoked_at, revocation_reason FROM identity_linked_platform_authorizations
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
    isActivated: release.isActivated,
    activate: release.activate,
    activationProof: release.activationProof,
    withMode: release.withMode,
    pending: async () => {
      if (!(await release.isActivated())) return [];
      const result = await pool.query<{ account_id: string; grant_id: string }>(
        `WITH due AS (
          SELECT account_id, grant_id FROM identity_agent_grant_revocation_work
          WHERE completed = false AND next_attempt_at <= now()
          ORDER BY next_attempt_at, position LIMIT 50 FOR UPDATE SKIP LOCKED
        ) UPDATE identity_agent_grant_revocation_work AS work SET next_attempt_at = now() + interval '30 seconds'
          FROM due WHERE work.account_id = due.account_id AND work.grant_id = due.grant_id
          RETURNING work.account_id, work.grant_id`,
      );
      const items: Awaited<ReturnType<AgentGrantRevocations["pending"]>>[number][] = [];
      for (const row of result.rows) {
        try {
          const state = await withPgTransaction(pool, async (db) => {
            const binding = { accountId: row.account_id, grantId: row.grant_id };
            const linked = await grant(db, binding);
            const existing = await load(db, binding);
            if (existing) return existing;
            if (!linked || linked.status !== "revoked" || !linked.revoked_at) invalidHistory();
            const owner: RevocationOwner = {
              ...binding,
              operationId: randomUUID(),
              revokedAt: new Date(linked.revoked_at).toISOString(),
              reason: linked.revocation_reason,
              provenance: "adoption",
            };
            const effectContext = adoptionContext(row.account_id);
            await eventStore.appendToStreamInTransaction(db, {
              streamId: ownerStream(row.account_id, row.grant_id),
              expectedVersion: 0,
              context: effectContext,
              events: [{ eventType: "identity.agent-grant-revocation.admitted", payload: owner }],
            });
            return { ...owner, phase: "admitted" as const, version: 1, effectContext };
          });
          items.push({ state, context: state.effectContext });
        } catch {
          items.push({ failure: "revocation_history_invalid" });
        }
      }
      return items;
    },
    admit: (binding, context) =>
      withPgTransaction(pool, async (db) => {
        await release.requireActivated(db);
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
            reason: row.status === "revoked" ? row.revocation_reason : binding.reason,
            provenance: row.status === "revoked" ? "adoption" : binding.provenance,
          };
          const effectContext = row.status === "revoked" ? adoptionContext(binding.accountId) : context;
          await eventStore.appendToStreamInTransaction(db, {
            streamId: ownerStream(binding.accountId, binding.grantId),
            expectedVersion: 0,
            context: effectContext,
            events: [{ eventType: "identity.agent-grant-revocation.admitted", payload: owner }],
          });
          state = { ...owner, phase: "admitted", version: 1, effectContext };
        }
        await db.query(
          `INSERT INTO identity_agent_grant_revocation_work (account_id, grant_id)
          VALUES ($1, $2) ON CONFLICT (account_id, grant_id) DO NOTHING`,
          [binding.accountId, binding.grantId],
        );
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
    readProgress: async (accountId, grantId) => (await load(pool, { accountId, grantId }))?.phase ?? null,
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
          revocation_reason = COALESCE(revocation_reason, $4), updated_at = now()
          WHERE account_id = $1 AND authorization_id = $2`,
            [state.accountId, state.grantId, state.revokedAt, current.reason],
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
          reason: current.reason,
          provenance: current.provenance,
        };
        await eventStore.appendToStreamInTransaction(db, {
          streamId: ownerStream(state.accountId, state.grantId),
          expectedVersion: current.version,
          context: current.effectContext,
          events: [{ eventType: `identity.agent-grant-revocation.${phase}`, payload: owner }],
        });
        if (phase === "completed")
          await db.query(
            "UPDATE identity_agent_grant_revocation_work SET completed = true WHERE account_id = $1 AND grant_id = $2",
            [state.accountId, state.grantId],
          );
        return { ...owner, phase, version: current.version + 1, effectContext: current.effectContext };
      }),
    withActiveGrants: createActiveAgentGrantFence(pool),
  };
}

export function createActiveAgentGrantFence(pool: PgTransactionalPool): AgentGrantRevocations["withActiveGrants"] {
  const orderReadScope: AgentOAuthScope = "dev.ucp.shopping.order:read";
  return (accountId, clientId, grantIds, work) =>
    withPgTransaction(pool, async (db) => {
      if (grantIds.length === 0 || grantIds.length > 500 || new Set(grantIds).size !== grantIds.length) return null;
      const result = await db.query<{ authorization_id: string }>(
        `SELECT authorization_id FROM identity_linked_platform_authorizations
        WHERE account_id = $1 AND client_id = $2 AND authorization_id = ANY($3::text[])
          AND status = 'active' AND scopes ? $4 ORDER BY authorization_id FOR SHARE`,
        [accountId, clientId, grantIds, orderReadScope],
      );
      return result.rows.length ? work(result.rows.map((row) => row.authorization_id)) : null;
    });
}

export function newRevocationAttemptId(): string {
  return randomUUID();
}

function adoptionContext(accountId: string): EventStoreContext {
  return {
    tenantId: "tnt_identity",
    audit: {
      performedByUserId: "usr_identity_revocation_adoption",
      forAccountId: accountId as EventStoreContext["audit"]["forAccountId"],
    },
  };
}
