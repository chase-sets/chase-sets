import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createAuthSecretAdapters } from "../auth-support/adapters";
import { toSessionStreamId } from "../../features/sessions/domain/auth-flow";
import { upsertPasswordCredential } from "../auth-support/store";
import { createSessionRuntime } from "../../features/sessions/api/runtime";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { drainProjectors } from "@chase-sets/bounded-context-runtime";
import { createId } from "@chase-sets/primitives/typed-ids";

function createAuthSeedContext(): EventStoreContext {
  return {
    tenantId: "tenant_seed_auth" as never,
    audit: {
      performedByUserId: identitySeedIds.support.userId,
      forAccountId: identitySeedIds.support.accountId,
    },
    trace: {
      correlationId: createId("cor") as never,
      commandId: createId("cmd") as never,
    },
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
  const { seller, buyer, support } = identitySeedIds;

  await sessions.commandHandler({
    streamId: toSessionStreamId(seller.sessionId),
    command: {
      type: "StartSession",
      sessionId: seller.sessionId,
      userId: seller.userId,
      accountId: seller.accountId,
      availableAccountIds: [seller.accountId],
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
      availableAccountIds: [support.accountId, seller.accountId],
      authenticationMethod: "magic-link",
      expiresAt: new Date("2026-05-10T00:00:00.000Z").toISOString(),
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(support.sessionId),
    command: {
      type: "SwitchSessionAccount",
      accountId: seller.accountId,
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(buyer.sessionId),
    command: {
      type: "StartSession",
      sessionId: buyer.sessionId,
      userId: buyer.userId,
      accountId: buyer.accountId,
      availableAccountIds: [buyer.accountId],
      authenticationMethod: "password",
      expiresAt: new Date("2026-04-15T00:00:00.000Z").toISOString(),
    },
    context,
  });
  await sessions.commandHandler({
    streamId: toSessionStreamId(buyer.sessionId),
    command: { type: "ExpireSession" },
    context,
  });

  await upsertPasswordCredential(db, {
    credentialId: seller.credentialId,
    userId: seller.userId,
    secretHash: auth.hashSecret("seller1234"),
  });
  await upsertPasswordCredential(db, {
    credentialId: buyer.credentialId,
    userId: buyer.userId,
    secretHash: auth.hashSecret("buyer1234"),
  });

  await drainProjectors(sessions.projectors);
}
