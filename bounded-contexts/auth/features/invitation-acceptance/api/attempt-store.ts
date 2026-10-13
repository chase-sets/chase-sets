import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  ATTEMPT_MAX_EVENTS,
  ATTEMPT_STAGES,
  bindingDigest,
  foldAttempt,
  InvitationAttemptError,
  type AttemptBinding,
  type AttemptStage,
  type AttemptState,
} from "../domain/attempt";

export async function readAttempt(store: EventStore, attemptId: string, context: EventStoreContext) {
  return foldAttempt(
    await readCompleteStream(store, {
      streamId: `auth.invitation-acceptance-${attemptId}`,
      maxEvents: ATTEMPT_MAX_EVENTS,
    }),
    context.tenantId,
  );
}

export async function beginAttempt(
  store: EventStore,
  binding: AttemptBinding,
  context: EventStoreContext,
): Promise<AttemptState> {
  const digest = bindingDigest(binding);
  await store.appendToStream({
    streamId: `auth.invitation-acceptance-${binding.attemptId}`,
    expectedVersion: "no_stream",
    context,
    events: [{ eventType: "auth.invitation-acceptance.started", payload: binding as unknown as JsonObject }],
  });
  return { binding, digest, stage: null, version: 1 };
}

export async function checkpoint(
  store: EventStore,
  state: AttemptState,
  stage: AttemptStage,
  context: EventStoreContext,
): Promise<AttemptState> {
  if (ATTEMPT_STAGES[state.version - 1] !== stage) throw new InvitationAttemptError("invitation_attempt_ambiguous");
  await store.appendToStream({
    streamId: `auth.invitation-acceptance-${state.binding.attemptId}`,
    expectedVersion: state.version,
    context,
    events: [
      {
        eventType: "auth.invitation-acceptance.checkpoint",
        payload: { bindingDigest: state.digest, stage, at: new Date().toISOString() },
      },
    ],
  });
  return { ...state, stage, version: state.version + 1 };
}

export async function withInvitationAttemptLock<T>(
  pool: PgTransactionalPool,
  tenantId: string,
  invitationId: string,
  work: () => Promise<T>,
): Promise<T> {
  const client: PgPoolClient = await pool.connect();
  let releaseError: unknown;
  const key = `auth:invitation-acceptance:${tenantId}:${invitationId}`;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [key],
    );
    if (!result.rows[0]?.locked) throw new InvitationAttemptError("invitation_attempt_ambiguous");
    try {
      return await work();
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch (error) {
        releaseError = error;
        throw error;
      }
    }
  } finally {
    client.release(releaseError);
  }
}
