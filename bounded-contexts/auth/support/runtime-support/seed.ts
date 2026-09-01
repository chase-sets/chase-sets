import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { loadSeedStreamEvents } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createAuthSecretAdapters } from "../auth-support/adapters";
import { toSessionStreamId, type AuthMethod } from "../../features/sessions/domain/auth-flow";
import { upsertPasswordCredential } from "../auth-support/store";
import { createSessionRuntime, type SessionServices } from "../../features/sessions/api/runtime";
import {
  evolveSession,
  initialSessionState,
  type SessionEvent,
  type SessionState,
} from "../../features/sessions/domain/domain";
import { identitySeedIds } from "@chase-sets/identity-seed";
import type { AccountId, SessionId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

function createAuthSeedContext(): EventStoreContext {
  return {
    tenantId: "tenant_seed_auth" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.support.userId,
      forAccountId: identitySeedIds.support.accountId,
    },
    trace: {},
  };
}

type SeedSessionParams = Readonly<{
  sessionId: SessionId;
  userId: UserId;
  accountId: AccountId;
  availableAccountIds: string[];
  authenticationMethod: AuthMethod;
  expiresAt: string;
}>;

/**
 * Starts a seed session only if the session aggregate has not already
 * started. Reconciliation must check the event-sourced aggregate itself
 * (via `getSessionState`, which loads from the event store) rather than a
 * projection read model: projection tables can lag or be reset independently
 * of the event store, so a table-row check can report "empty" while the
 * aggregate already exists, which then replays `StartSession` into a
 * started aggregate and fails the `expectedVersion` guard in `decideSession`.
 */
async function ensureSessionStarted(
  sessions: SessionServices,
  context: EventStoreContext,
  params: SeedSessionParams,
): Promise<SessionState> {
  const existing = await sessions.getSessionState(params.sessionId);
  if (existing) {
    return existing;
  }

  await sessions.commandHandler({
    streamId: toSessionStreamId(params.sessionId),
    command: { type: "StartSession", ...params },
    context,
  });

  const started = await sessions.getSessionState(params.sessionId);
  if (!started) {
    throw new Error(
      `Auth seed reconciliation could not load session state for '${params.sessionId}' immediately after StartSession.`,
    );
  }

  return started;
}

export async function seedAuthDatabase(pool: PgTransactionalPool) {
  const db = pool;

  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db });
  const sessions = createSessionRuntime({ eventStore, checkpointStore, db });
  const auth = createAuthSecretAdapters();
  const context = createAuthSeedContext();
  const { demo, collector, support } = identitySeedIds;

  await ensureSessionStarted(sessions, context, {
    sessionId: demo.sessionId,
    userId: demo.userId,
    accountId: demo.accountId,
    availableAccountIds: [demo.accountId],
    authenticationMethod: "password",
    expiresAt: new Date("2026-05-10T00:00:00.000Z").toISOString(),
  });

  const supportSession = await ensureSessionStarted(sessions, context, {
    sessionId: support.sessionId,
    userId: support.userId,
    accountId: support.accountId,
    availableAccountIds: [support.accountId, demo.accountId],
    authenticationMethod: "magic-link",
    expiresAt: new Date("2026-05-10T00:00:00.000Z").toISOString(),
  });
  if (supportSession.accountId !== demo.accountId) {
    await sessions.commandHandler({
      streamId: toSessionStreamId(support.sessionId),
      command: { type: "SwitchSessionAccount", accountId: demo.accountId },
      context,
    });
  }

  const collectorSession = await ensureSessionStarted(sessions, context, {
    sessionId: collector.sessionId,
    userId: collector.userId,
    accountId: collector.accountId,
    availableAccountIds: [collector.accountId],
    authenticationMethod: "password",
    expiresAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
  });
  if (collectorSession.status !== "expired") {
    await sessions.commandHandler({
      streamId: toSessionStreamId(collector.sessionId),
      command: { type: "ExpireSession" },
      context,
    });
  }

  await upsertPasswordCredential(db, {
    credentialId: demo.credentialId,
    userId: demo.userId,
    secretHash: await auth.hashPassword("demo1234"),
  });
  await upsertPasswordCredential(db, {
    credentialId: collector.credentialId,
    userId: collector.userId,
    secretHash: await auth.hashPassword("collector1234"),
  });

  void sessions.projectors;
}

const seededAuthSessions = [
  { sessionId: identitySeedIds.demo.sessionId, key: "demo", expectedStatus: "active" },
  { sessionId: identitySeedIds.support.sessionId, key: "support", expectedStatus: "active" },
  { sessionId: identitySeedIds.collector.sessionId, key: "collector", expectedStatus: "expired" },
] as const;

/**
 * Reports the Auth seed's session state from the authoritative `auth.*`
 * streams. Auth has folded its seed decision from `repository.load` since the
 * original 2026-07-12 report; this exposes the same stream-sourced answer
 * through the shared module capability so seed coverage can be enumerated from
 * the runtime mount list.
 */
export async function inspectAuthSeedState(pool: PgTransactionalPool): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];

  for (const session of seededAuthSessions) {
    const streamId = toSessionStreamId(session.sessionId);
    const committed = await loadSeedStreamEvents<SessionEvent>(pool, streamId);
    const state = committed.reduce(evolveSession, initialSessionState);
    reports.push({
      contextName: "auth",
      aggregateName: "Session",
      id: session.sessionId,
      key: session.key,
      streamId,
      kind: state.id === null ? "absent" : state.status === session.expectedStatus ? "active" : "draft",
      status: state.id === null ? null : String(state.status),
      eventCount: committed.length,
    });
  }

  return reports;
}
