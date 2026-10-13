import { createPgPool, createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createId, parseTypedId } from "@chase-sets/primitives/typed-ids";
import type { Pool } from "pg";
import { createIdentityMutationPersistence } from "../api/fences";

export function ownedBrowserIdentityDatabase(identityDatabaseUrl: unknown, catalogDatabaseUrl: unknown): URL {
  if (typeof identityDatabaseUrl !== "string" || typeof catalogDatabaseUrl !== "string")
    throw new Error("Owned browser database metadata is required.");
  let catalog: URL;
  let identity: URL;
  try {
    catalog = new URL(catalogDatabaseUrl);
    identity = new URL(identityDatabaseUrl);
  } catch {
    throw new Error("Owned browser database metadata is malformed.");
  }
  if (
    !["postgres:", "postgresql:"].includes(catalog.protocol) ||
    !["postgres:", "postgresql:"].includes(identity.protocol) ||
    !["localhost", "127.0.0.1"].includes(catalog.hostname) ||
    identity.host !== catalog.host ||
    !/^\/cs_[a-z0-9_]+_catalog$/.test(catalog.pathname) ||
    identity.pathname !== catalog.pathname.replace(/_catalog$/, "_identity")
  )
    throw new Error("Consent fixture requires the owned loopback browser sandbox.");
  return identity;
}

// Browser fixture only: a synthetic, actor-bound Consent fact, never policy activation or projection SQL.
export async function seedBrowserConsent(
  identityDatabaseUrl: unknown,
  catalogDatabaseUrl: unknown,
  actor: Readonly<{ userId: string; accountId: string; membershipId: string }>,
) {
  const pool = createPgPool(ownedBrowserIdentityDatabase(identityDatabaseUrl, catalogDatabaseUrl).toString(), {
    max: 2,
  });
  try {
    const raw = createPostgresEventStore({
      pool,
      wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "identity" }),
    });
    const user = await readCompleteStream(raw, { streamId: `identity.user-${actor.userId}`, maxEvents: 10000 });
    const account = await readCompleteStream(raw, {
      streamId: `identity.account-${actor.accountId}`,
      maxEvents: 10000,
    });
    const created = user[0];
    const membership = await readCompleteStream(raw, {
      streamId: `identity.membership-${actor.membershipId}`,
      maxEvents: 10000,
    });
    if (
      created?.eventType !== "identity.user.created" ||
      typeof created.payload.primaryEmail !== "string" ||
      !/^[a-f0-9]{64}@chasesets\.test$/.test(created.payload.primaryEmail) ||
      account[0]?.eventType !== "identity.account.created" ||
      membership[0]?.eventType !== "identity.membership.granted" ||
      membership[0].payload.userId !== actor.userId ||
      membership[0].payload.accountId !== actor.accountId ||
      [...user, ...account, ...membership].some((event) => event.tenantId !== created.tenantId)
    )
      throw new Error("Consent fixture requires the registered synthetic browser actor.");
    const context = {
      tenantId: parseTypedId(created.tenantId, "tnt"),
      audit: {
        performedByUserId: parseTypedId(actor.userId, "usr"),
        forAccountId: parseTypedId(actor.accountId, "acc"),
      },
    };
    const consentId = createId("cns");
    return await runWithEventCommitMetadata(async () => {
      const persistence = createIdentityMutationPersistence(pool, raw, () => []);
      await persistence.eventStore.appendToStream({
        streamId: `identity.consent-${consentId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "identity.consent.recorded",
            payload: {
              consentId,
              subjectType: "user",
              userId: actor.userId,
              accountId: actor.accountId,
              policyKey: "synthetic-browser-policy",
              policyVersion: "v1",
              recordedAt: new Date().toISOString(),
            },
          },
        ],
      });
      const sources = getEventCommitMetadata().sources;
      if (sources.length !== 1 || sources[0].sourceContextName !== "identity" || sources[0].eventIds.length !== 1)
        throw new Error("Consent fixture requires its exact committed event receipt.");
      return { consentId, sources };
    });
  } finally {
    await (pool as Pool).end();
  }
}
