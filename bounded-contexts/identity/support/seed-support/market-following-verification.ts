import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventCommitSourceMetadata } from "@chase-sets/event-core/consistency";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPgPool,
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createUserRuntime } from "../../features/users/api/runtime";
import type { IdentityRuntimeDeps } from "../runtime-support";
import { createIdentityBootstrapContext } from "../runtime-support/bootstrap-context";
import { normalizeEmail } from "../runtime-support/common";

/**
 * Browser E2E fixture support only. Re-issues the existing Identity `VerifyContactMethod`
 * command against a seeded user's actual stored primary email contact on EVERY invocation,
 * so each scenario run obtains a genuine new commit (already-verified retries included) and
 * returns only the commit metadata captured inside that command's scope.
 *
 * It never grants permissions, never fabricates ids or positions, never writes projection
 * rows and never touches any other user fact.
 */

export const IDENTITY_COMMIT_SOURCE_CONTEXT_NAME = "identity";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
const OWNED_IDENTITY_DATABASE_PATHNAME = /^\/cs_[a-z0-9_]+_identity$/;
const OWNED_COMPANION_DATABASE_PATHNAME = /^\/cs_[a-z0-9_]+_catalog$/;

export type MarketFollowingBuyerVerificationInput = Readonly<{
  userId: string;
  primaryEmail: string;
  verifiedAt?: string;
  context?: EventStoreContext;
}>;

export type MarketFollowingBuyerVerificationCommit = Readonly<{
  userId: string;
  contactMethodId: string;
  verifiedAt: string;
  previouslyVerifiedAt: string | null;
  sources: readonly EventCommitSourceMetadata[];
}>;

export type OwnedSandboxIdentityDatabaseInput = Readonly<{
  /** The owned sandbox Identity database URL; never logged or echoed in errors. */
  identityDatabaseUrl: string;
  /** The owned sandbox Catalog database URL already trusted by the calling spec. */
  companionDatabaseUrl: string;
}>;

/**
 * Accepts only the owned local E2E sandbox Identity database: loopback host, the same host
 * as the companion Catalog URL and the same `cs_<sandbox>_<context>` family with the Identity
 * suffix. Error messages deliberately omit both URLs so credentials are never surfaced.
 */
export function assertOwnedSandboxIdentityDatabaseUrl(input: OwnedSandboxIdentityDatabaseInput): URL {
  const identityUrl = parseDatabaseUrl(input.identityDatabaseUrl, "Identity");
  const companionUrl = parseDatabaseUrl(input.companionDatabaseUrl, "companion Catalog");
  if (!LOOPBACK_HOSTNAMES.has(identityUrl.hostname) || !LOOPBACK_HOSTNAMES.has(companionUrl.hostname))
    throw new Error("Buyer fixture verification requires the owned loopback E2E Identity database.");
  if (identityUrl.host !== companionUrl.host)
    throw new Error("Buyer fixture verification requires the Identity database on the owned sandbox host.");
  if (!OWNED_COMPANION_DATABASE_PATHNAME.test(companionUrl.pathname))
    throw new Error("Buyer fixture verification requires the owned sandbox Catalog database family.");
  if (
    !OWNED_IDENTITY_DATABASE_PATHNAME.test(identityUrl.pathname) ||
    identityUrl.pathname !== companionUrl.pathname.replace(/_catalog$/, "_identity")
  )
    throw new Error("Buyer fixture verification requires the owned sandbox Identity database.");
  return identityUrl;
}

/**
 * Returns the Identity source from captured commit metadata, failing when the metadata is
 * absent, empty, carries no committed event ids or comes from a different source context.
 */
export function requireIdentityCommitSource(
  sources: readonly EventCommitSourceMetadata[] | undefined,
): EventCommitSourceMetadata {
  if (!sources || sources.length === 0)
    throw new Error("Buyer fixture verification produced no commit receipt; refusing the session read.");
  const identity = sources.find((source) => source.sourceContextName === IDENTITY_COMMIT_SOURCE_CONTEXT_NAME);
  if (!identity)
    throw new Error(
      `Buyer fixture verification commit receipt names ${sources
        .map((source) => source.sourceContextName)
        .join(", ")} instead of ${IDENTITY_COMMIT_SOURCE_CONTEXT_NAME}; refusing the session read.`,
    );
  if (identity.eventIds.length === 0 || !identity.maxGlobalPosition)
    throw new Error("Buyer fixture verification Identity commit receipt carries no committed events.");
  return identity;
}

/**
 * Issues `VerifyContactMethod` for the user's actual stored primary email contact through the
 * existing Identity user command runtime and returns only the commit metadata captured inside
 * `runWithEventCommitMetadata` for that command.
 */
export async function verifyMarketFollowingBuyerContact(
  deps: IdentityRuntimeDeps,
  input: MarketFollowingBuyerVerificationInput,
): Promise<MarketFollowingBuyerVerificationCommit> {
  const users = createUserRuntime(deps);
  const state = await users.getUserState(input.userId);
  if (!state) throw new Error(`Buyer fixture user ${input.userId} does not exist in the Identity event store.`);
  const expectedEmail = normalizeEmail(input.primaryEmail);
  if (!state.primaryEmail || normalizeEmail(state.primaryEmail) !== expectedEmail)
    throw new Error(`Buyer fixture user ${input.userId} does not own the expected primary email.`);
  const contact = state.contactMethods.find(
    (method) => method.type === "email" && normalizeEmail(method.value) === expectedEmail,
  );
  if (!contact) throw new Error(`Buyer fixture user ${input.userId} has no stored primary email contact method.`);

  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const context = input.context ?? createIdentityBootstrapContext();
  const { result, metadata } = await runWithEventCommitMetadata(async () => {
    const execution = await users.commandHandler({
      streamId: `identity.user-${input.userId}`,
      command: { type: "VerifyContactMethod", contactMethodId: contact.contactMethodId, verifiedAt },
      context,
    });
    return { result: execution, metadata: getEventCommitMetadata() };
  });
  if (result.storedEvents.length !== 1)
    throw new Error(
      `Buyer fixture verification expected exactly one committed Identity event, saw ${result.storedEvents.length}.`,
    );
  const identity = requireIdentityCommitSource(metadata.sources);
  const storedEvent = result.storedEvents[0]!;
  if (
    identity.eventIds.length !== 1 ||
    identity.eventIds[0] !== String(storedEvent.eventId) ||
    identity.maxGlobalPosition !== String(storedEvent.globalPosition)
  )
    throw new Error("Buyer fixture verification commit metadata does not match the committed Identity event.");

  return {
    userId: input.userId,
    contactMethodId: contact.contactMethodId,
    verifiedAt,
    previouslyVerifiedAt: contact.verifiedAt,
    sources: metadata.sources,
  };
}

export type OwnedSandboxMarketFollowingBuyerVerificationInput = OwnedSandboxIdentityDatabaseInput &
  Readonly<{
    userId: string;
    primaryEmail: string;
  }>;

/**
 * Postgres entry point for the browser fixture: composes the same event store, projection
 * checkpoint store and wake notification configuration the Identity runtime uses, against the
 * owned sandbox Identity database only, and closes its single-connection pool afterwards.
 */
export async function verifyMarketFollowingBuyerContactInOwnedSandbox(
  input: OwnedSandboxMarketFollowingBuyerVerificationInput,
): Promise<MarketFollowingBuyerVerificationCommit> {
  const identityUrl = assertOwnedSandboxIdentityDatabaseUrl(input);
  const pool = createPgPool(identityUrl.toString(), { max: 1 });
  try {
    const eventStore = createPostgresEventStore({
      pool,
      wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({
        sourceContextName: "identity",
      }),
    });
    const checkpointStore = createPostgresProjectionStore({ db: pool });
    const db = pool as PgQueryable;
    return await verifyMarketFollowingBuyerContact(
      { eventStore, checkpointStore, db },
      { userId: input.userId, primaryEmail: input.primaryEmail },
    );
  } finally {
    await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
  }
}

function parseDatabaseUrl(value: string, label: string): URL {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Buyer fixture verification requires the owned sandbox ${label} database URL.`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`Buyer fixture verification received an unparseable ${label} database URL.`);
  }
}
