import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createListingAuthorityFence,
  type ListingAuthorityOperationInput,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import type { ListingAuthorityConformanceFixture } from "@chase-sets/platform-runtime/listing-authority-conformance";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createIdentityListingAuthority } from "./listing-authority";
import { createAccountRuntime } from "../../accounts/api/runtime";
import { createUserRuntime } from "../../users/api/runtime";
import { createMembershipRuntime } from "../../memberships/api/runtime";
import { createApiKeyRuntime } from "../../api-keys/api/runtime";
import { createIdentitySecretAdapters } from "../../api-keys/api/secret-adapters";
import type {
  IdentityCredentialStore,
  IdentityCredentialMutation,
  IdentityApiKeyCredential,
  IdentityDelegationCredential,
} from "./listing-credentials";

/** Synthetic SQL persistence only. Policy, canonical aggregate writers and protocol are the actual owners. */
export function memoryIdentityCredentials(): IdentityCredentialStore {
  const keys = new Map<string, IdentityApiKeyCredential>();
  const delegations = new Map<string, IdentityDelegationCredential>();
  const receipts = new Map<
    string,
    IdentityCredentialMutation & { applied: boolean; result: IdentityDelegationCredential | boolean | null }
  >();
  const completed = new Set<string>();
  return {
    readApiKey: async (id) => keys.get(id) ?? null,
    readDelegation: async (id) => delegations.get(id) ?? null,
    authenticateApiKey: async (hash) => [...keys.values()].find((key) => key.secret_hash === hash) ?? null,
    authenticateDelegation: async (hash) => [...delegations.values()].find((d) => d.access_token_hash === hash) ?? null,
    readMutation: async (id) => receipts.get(id) ?? null,
    pending: async (limit, after = "") =>
      [...receipts.keys()]
        .filter((id) => !completed.has(id) && id > after)
        .sort()
        .slice(0, limit),
    complete: async (id) => {
      completed.add(id);
    },
    stage: async (input) => {
      const old = receipts.get(input.mutationId);
      if (old && JSON.stringify(old.command) !== JSON.stringify(input.command))
        throw new Error("Synthetic mutation conflict");
      if (!old) receipts.set(input.mutationId, { ...input, applied: false, result: null });
    },
    apply: async (id) => {
      const receipt = receipts.get(id)!;
      if (receipt.applied) return receipt.result;
      const c = receipt.command;
      let result: IdentityDelegationCredential | boolean | null = true;
      if (c.kind === "api-key-upsert")
        keys.set(c.apiKeyId, {
          api_key_id: c.apiKeyId,
          user_id: c.userId,
          key_prefix: c.keyPrefix,
          secret_hash: c.secretHash,
          authority_revision: id,
        });
      else if (c.kind === "api-key-delete") keys.delete(c.apiKeyId);
      else if (c.kind === "delegation-grant") {
        const p = c.params;
        result = {
          authorization_id: p.authorizationId,
          user_id: p.userId,
          account_id: p.accountId,
          platform_profile_url: p.platformProfileUrl,
          client_id: p.clientId,
          scopes: p.scopes,
          status: "active",
          access_token_hash: p.accessTokenHash,
          refresh_token_hash: p.refreshTokenHash ?? null,
          access_token_expires_at: p.accessTokenExpiresAt,
          refresh_token_expires_at: p.refreshTokenExpiresAt ?? null,
          granted_at: p.grantedAt,
          last_refreshed_at: null,
          refresh_token_rotated_at: null,
          revoked_at: null,
          revocation_reason: null,
          updated_at: p.grantedAt,
          authority_revision: id,
        };
        delegations.set(p.authorizationId, result);
      } else if (c.kind === "delegation-rotate") {
        const d = delegations.get(c.authorizationId);
        result =
          d && d.refresh_token_hash === c.params.refreshTokenHash && d.status === "active"
            ? {
                ...d,
                access_token_hash: c.params.newAccessTokenHash,
                refresh_token_hash: c.params.newRefreshTokenHash,
                access_token_expires_at: c.params.accessTokenExpiresAt,
                refresh_token_expires_at: c.params.refreshTokenExpiresAt,
                authority_revision: id,
              }
            : null;
        if (result) delegations.set(c.authorizationId, result);
      } else {
        const d = delegations.get(c.authorizationId);
        result = !!d && d.status === "active" && d.account_id === c.accountId;
        if (result) delegations.set(c.authorizationId, { ...d!, status: "revoked", authority_revision: id });
      }
      receipts.set(id, { ...receipt, applied: true, result });
      return result;
    },
  };
}

export async function identityFixture() {
  const memory = createInMemoryEventStore();
  const consumerMemory = createInMemoryEventStore();
  const credentials = memoryIdentityCredentials();
  const accountId = createId("acc"),
    userId = createId("usr"),
    membershipId = createId("mbr"),
    keyId = createId("key");
  const audit: EventStoreContext = {
    tenantId: "tnt_synthetic_identity",
    audit: { forAccountId: accountId, performedByUserId: userId },
  };
  let block = false;
  const makeSource = () =>
    createIdentityListingAuthority({
      eventStore: memory.eventStore,
      credentials,
      listingAuthorityConsumer: () => {
        const port = fence.forParticipant("identity");
        return {
          ...port,
          invalidate: async (...args) => {
            if (block) throw new Error("Synthetic unavailable consumer");
            return port.invalidate(...args);
          },
        };
      },
    });
  let authority = makeSource();
  const deps = {
    eventStore: authority.eventStore,
    db: {
      query: async () => {
        throw new Error("Projection access prohibited");
      },
    },
    checkpointStore: {} as never,
  };
  const accounts = createAccountRuntime(deps),
    users = createUserRuntime(deps),
    memberships = createMembershipRuntime(deps),
    apiKeys = createApiKeyRuntime(deps);
  await accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    context: audit,
    command: { type: "CreateAccount", accountId, name: "Synthetic account", accountType: "personal" },
  });
  await users.commandHandler({
    streamId: `identity.user-${userId}`,
    context: audit,
    command: { type: "CreateUser", userId, displayName: "Synthetic user", primaryEmail: "synthetic@example.test" },
  });
  await memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    context: audit,
    command: {
      type: "GrantMembership",
      membershipId,
      accountId,
      userId,
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    },
  });
  await apiKeys.commandHandler({
    streamId: `identity.api-key-${keyId}`,
    context: audit,
    command: { type: "CreateApiKey", apiKeyId: keyId, userId, name: "Synthetic key", keyPrefix: "synthetic" },
  });
  const secrets = createIdentitySecretAdapters();
  await authority.mutateCredential({
    mutationId: "synthetic-key-1",
    context: audit,
    command: {
      kind: "api-key-upsert",
      apiKeyId: keyId,
      userId,
      keyPrefix: "synthetic",
      secretHash: secrets.hashSecret("synthetic-secret"),
    },
  });
  const principal = await authority.authenticateApiKey("synthetic-secret", membershipId, "2099-01-01T00:00:00.000Z");
  if (!principal) throw new Error("Synthetic credential authentication failed");
  const context = { ...audit, listingAuthorityPrincipal: principal };
  const input: ListingAuthorityOperationInput = {
    tenantId: audit.tenantId,
    accountId,
    actor: { kind: "user", userId },
    committingOwner: "marketplace",
    kind: "accept-price",
    requestId: "synthetic-identity-request",
    command: { amount: "12.00", currencyCode: "USD" },
    listingId: "lst_synthetic_identity",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions: [],
      quantity: 1,
      pair: { amount: "12.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: null,
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: null,
    expectedPublicationRevision: null,
    participants: [authority.port.participant],
  };
  const fence = createListingAuthorityFence({
    eventStore: consumerMemory.eventStore,
    owner: "marketplace",
    participants: [authority.port],
  });
  const fixture: ListingAuthorityConformanceFixture = {
    context,
    input,
    consumerStore: consumerMemory.eventStore,
    sourceStore: memory.eventStore,
    source: authority.source,
    fence,
    invalidate: async () => {
      await memberships.commandHandler({
        streamId: `identity.membership-${membershipId}`,
        command: { type: "RevokeMembership" },
        context: audit,
      });
    },
    restart: () => {
      authority = makeSource();
      return { ...fixture, source: authority.source };
    },
  };
  return {
    ...fixture,
    memory,
    consumerMemory,
    credentials,
    accounts,
    users,
    memberships,
    apiKeys,
    accountId,
    userId,
    membershipId,
    keyId,
    audit,
    secrets,
    get authority() {
      return authority;
    },
    blockInvalidation: (value: boolean) => {
      block = value;
    },
  };
}
