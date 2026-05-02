import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createAuthSecretAdapters } from "../auth-support/adapters";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { upsertPasswordCredential } from "../auth-support/store";
import { createSessionRuntime } from "../../features/sessions/api/runtime";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { drainProjectors } from "@chase-sets/bounded-context-runtime";

function createAuthSeedContext(): EventStoreContext {
  return {
    tenantId: "tenant_seed_auth" as never,
    audit: {
      performedByUserId: identitySeedIds.support.userId,
      forAccountId: identitySeedIds.support.accountId,
    },
    trace: {},
  };
}

export async function seedAuthDatabase(pool: PgTransactionalPool) {
  const db = pool;

  try {
    const existing = await db.query(
      "SELECT COUNT(*) AS count FROM identity_sessions",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Auth already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db });
  const sessions = createSessionRuntime({ eventStore, checkpointStore, db });
  const auth = createAuthSecretAdapters();
  const context = createAuthSeedContext();
  const { demo, collector, support } = identitySeedIds;

  await sessions.commandHandler({
    streamId: toSessionStreamId(demo.sessionId),
    command: {
      type: "StartSession",
      sessionId: demo.sessionId,
      userId: demo.userId,
      accountId: demo.accountId,
      availableAccountIds: [demo.accountId],
      authenticationMethod: "password",
      expiresAt: new Date("2026-05-10T00:00:00.000Z").toISOString(),
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(support.sessionId),
    command: {
      type: "StartSession",
      sessionId: support.sessionId,
      userId: support.userId,
      accountId: support.accountId,
      availableAccountIds: [support.accountId, demo.accountId],
      authenticationMethod: "magic-link",
      expiresAt: new Date("2026-05-10T00:00:00.000Z").toISOString(),
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(support.sessionId),
    command: {
      type: "SwitchSessionAccount",
      accountId: demo.accountId,
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(collector.sessionId),
    command: {
      type: "StartSession",
      sessionId: collector.sessionId,
      userId: collector.userId,
      accountId: collector.accountId,
      availableAccountIds: [collector.accountId],
      authenticationMethod: "password",
      expiresAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(collector.sessionId),
    command: { type: "ExpireSession" },
    context,
  });

  await upsertPasswordCredential(db, {
    credentialId: demo.credentialId,
    userId: demo.userId,
    secretHash: auth.hashSecret("demo1234"),
  });
  await upsertPasswordCredential(db, {
    credentialId: collector.credentialId,
    userId: collector.userId,
    secretHash: auth.hashSecret("collector1234"),
  });

  await drainProjectors(sessions.projectors);
}
