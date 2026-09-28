import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createListingAuthorityFence,
  type ListingAuthorityOperationInput,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import type { ListingAuthoritySessionConformanceFixture } from "@chase-sets/platform-runtime/listing-authority-conformance";
import type { SessionTokenMutation, SessionTokenRecord, SessionTokenStore } from "./session-token-store";
import { createSessionRuntime } from "./runtime";
import { createAuthSecretAdapters } from "../../../support/auth-support/adapters";
import { resolveListingSessionAuthentication } from "../../../support/runtime-support/runtime";
import type { AuthServices } from "../../../support/runtime-support/services";

/** Synthetic persistence adapter; SQL is separately tested. Real Auth secret adapter and owner writers. */
export function memoryTokens(): SessionTokenStore {
  const rows = new Map<string, SessionTokenRecord>();
  const mutations = new Map<string, SessionTokenMutation & { applied: boolean }>();
  const completed = new Set<string>();
  return {
    pending: async (limit, after = "") =>
      [...mutations.keys()]
        .filter((id) => !completed.has(id) && id > after)
        .sort()
        .slice(0, limit),
    complete: async (id) => {
      completed.add(id);
    },
    read: async (id) => rows.get(id) ?? null,
    authenticate: async (hash) => [...rows.values()].find((row) => row.token_hash === hash) ?? null,
    readMutation: async (id) => mutations.get(id) ?? null,
    stage: async (input) => {
      const prior = mutations.get(input.mutationId);
      if (
        prior &&
        JSON.stringify({ ...prior, applied: undefined }) !== JSON.stringify({ ...input, applied: undefined })
      )
        throw new Error("Mutation conflict");
      if (!prior) mutations.set(input.mutationId, { ...input, applied: false });
    },
    apply: async (id) => {
      const input = mutations.get(id);
      if (!input) throw new Error("Unknown token mutation");
      if (input.applied) return;
      rows.set(input.sessionId, {
        session_id: input.sessionId,
        token_hash: input.tokenHash,
        token_revision: id,
        expires_at: input.expiresAt,
      });
      mutations.set(id, { ...input, applied: true });
    },
  };
}

export async function authFixture(
  options: {
    owner?: "marketplace" | "ordering";
    expiresAt?: string;
    tokenExpiresAt?: string;
    sourceOnly?: boolean;
  } = {},
) {
  const owner = options.owner ?? "marketplace";
  const authMemory = createInMemoryEventStore();
  const authStore = authMemory.eventStore;
  const identityStore = createInMemoryEventStore().eventStore;
  const consumerMemory = createInMemoryEventStore();
  const consumerStore = consumerMemory.eventStore;
  const tokens = memoryTokens();
  const auth = createAuthSecretAdapters();
  const audit: EventStoreContext = {
    tenantId: "tnt_synthetic_auth",
    audit: { forAccountId: "acc_synthetic_auth", performedByUserId: "usr_synthetic_auth" },
  };
  const sessionId = "ses_synthetic_auth";
  const streamId = `auth.session-${sessionId}`;
  const expiresAt = options.expiresAt ?? "2099-01-01T00:00:00.000Z";
  const tokenExpiresAt = options.tokenExpiresAt ?? expiresAt;
  let unknownAbort = false;
  const makeSessions = () =>
    createSessionRuntime({
      eventStore: authStore,
      sessionTokens: tokens,
      db: {
        query: async () => {
          throw new Error("No projection access allowed");
        },
      },
      checkpointStore: {} as never,
      listingAuthorityConsumer: () => {
        const port = fence.forParticipant("auth");
        return {
          ...port,
          invalidate: async (...args) => {
            if (unknownAbort) throw new Error("Synthetic unavailable consumer");
            return port.invalidate(...args);
          },
        };
      },
    });
  let sessions = makeSessions();
  await sessions.commandHandler({
    streamId,
    context: audit,
    command: {
      type: "StartSession",
      sessionId,
      userId: audit.audit.performedByUserId,
      accountId: audit.audit.forAccountId,
      availableAccountIds: [audit.audit.forAccountId, "acc_synthetic_other"],
      authenticationMethod: "password",
      expiresAt,
    },
  });
  await sessions.listingAuthority.mutateToken({
    mutationId: "synthetic-token-1",
    sessionId,
    tokenHash: auth.hashSecret("synthetic-secret-1"),
    expiresAt: tokenExpiresAt,
    context: audit,
  });
  const resolve = (secret: string) => resolveListingSessionAuthentication({ auth, sessions } as AuthServices, secret);
  const evidence = await resolve("synthetic-secret-1");
  if (!evidence) throw new Error("Synthetic token did not authenticate through Auth");
  const context: EventStoreContext = {
    ...audit,
    listingAuthorityPrincipal: {
      ...evidence,
      kind: "user",
      membershipId: "mbr_synthetic_auth",
      delegation: null,
    },
  };
  // Only Identity is synthetic in the Auth-first pass. Replaced by the real Identity fixture in its pass.
  const identity = createListingAuthorityParticipant({
    eventStore: identityStore,
    participant: { owner: "identity", purpose: "manage-listing" },
    consumer: () => fence.forParticipant("identity"),
    resources: () => ["synthetic-membership"],
    validate: async (operation) => ({
      value: {},
      sourceRevisions: [{ resourceId: "synthetic-membership", revision: "1" }],
      validBefore: operation.prepareBefore,
    }),
  });
  const fence = createListingAuthorityFence({
    eventStore: consumerStore,
    owner,
    participants: [sessions.listingAuthority.port, identity],
  });
  const input: ListingAuthorityOperationInput = {
    tenantId: audit.tenantId,
    accountId: audit.audit.forAccountId,
    actor: { kind: "user", userId: audit.audit.performedByUserId },
    committingOwner: owner,
    kind: owner === "ordering" ? "native-commitment" : "accept-price",
    requestId: "synthetic-auth-request",
    command: { amount: "12.00", currencyCode: "USD" },
    listingId: "lst_synthetic_auth",
    subject: {
      inventoryItemId: "inv_synthetic_auth",
      catalogItemId: "cat_synthetic_auth",
      productId: "cat_synthetic_auth::",
      selectedOptions: [],
      quantity: 1,
      pair: { amount: "12.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: owner === "ordering" ? "ord_synthetic_auth" : null,
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: null,
    expectedPublicationRevision: null,
    participants: options.sourceOnly
      ? [sessions.listingAuthority.port.participant]
      : [sessions.listingAuthority.port.participant, identity.participant],
  };
  const fixture: ListingAuthoritySessionConformanceFixture = {
    context,
    input,
    consumerStore,
    sourceStore: authStore,
    fence,
    source: sessions.listingAuthority.source,
    invalidate: async () => {
      await sessions.commandHandler({ streamId, context: audit, command: { type: "RevokeSession" } });
    },
    prepareAuthorities: async (operation, carrier) => {
      const authGrant = await sessions.listingAuthority.port.prepare(operation, carrier);
      return options.sourceOnly ? [authGrant] : [authGrant, await identity.prepare(operation, carrier)];
    },
    restart: () => {
      sessions = makeSessions();
      return { ...fixture, source: sessions.listingAuthority.source };
    },
  };
  return {
    ...fixture,
    authStore,
    authMemory,
    consumerMemory,
    identityStore,
    tokens,
    auth,
    audit,
    sessionId,
    streamId,
    resolve,
    get sessions() {
      return sessions;
    },
    setUnknownAbort: (value: boolean) => {
      unknownAbort = value;
    },
  };
}
