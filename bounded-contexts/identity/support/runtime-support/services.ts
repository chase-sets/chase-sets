import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createIdentitySecretAdapters } from "../../features/api-keys/api/secret-adapters";
import { createAccountRuntime } from "../../features/accounts/api/runtime";
import { createApiKeyRuntime } from "../../features/api-keys/api/runtime";
import { createConsentRuntime } from "../../features/consents/api/runtime";
import { createInvitationRuntime } from "../../features/invitations/api/runtime";
import { createFoundersCohortRuntime } from "../../features/founders-cohort/api/runtime";
import { createMembershipRuntime } from "../../features/memberships/api/runtime";
import { createUserPreferencesRuntime } from "../../features/preferences/api/runtime";
import { createShippingAddressRuntime } from "../../features/shipping-addresses/api/runtime";
import { createUserRuntime } from "../../features/users/api/runtime";
import { createLinkedPlatformAuthorizationStore } from "../ucp-support/linked-platform-authorizations";

export type IdentityServices = Readonly<{
  accounts: ReturnType<typeof createAccountRuntime>;
  users: ReturnType<typeof createUserRuntime>;
  memberships: ReturnType<typeof createMembershipRuntime>;
  invitations: ReturnType<typeof createInvitationRuntime>;
  foundersCohort: ReturnType<typeof createFoundersCohortRuntime>;
  apiKeys: ReturnType<typeof createApiKeyRuntime>;
  consents: ReturnType<typeof createConsentRuntime>;
  preferences: ReturnType<typeof createUserPreferencesRuntime>;
  linkedPlatformAuthorizations: ReturnType<typeof createLinkedPlatformAuthorizationStore>;
  shippingAddresses: ReturnType<typeof createShippingAddressRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (Terms of Service active version). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
  auth: ReturnType<typeof createIdentitySecretAdapters>;
}>;

export type IdentityHostPorts = Readonly<{
  addressVerificationProvider?: PostageLabelProvider | null;
}>;

export function createIdentityServices(pool: PgTransactionalPool, ports: IdentityHostPorts = {}): IdentityServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "identity" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const auth = createIdentitySecretAdapters();
  const policies = createPolicyRuntime({ eventStore, db });
  const deps = {
    eventStore,
    checkpointStore,
    db,
    addressVerificationProvider: ports.addressVerificationProvider,
  } as const;

  const accounts = createAccountRuntime(deps);
  const users = createUserRuntime(deps);
  const memberships = createMembershipRuntime(deps);
  const invitations = createInvitationRuntime(deps);
  const foundersCohort = createFoundersCohortRuntime(deps, accounts);
  const apiKeys = createApiKeyRuntime(deps);
  const consents = createConsentRuntime(deps);
  const preferences = createUserPreferencesRuntime(deps);
  const linkedPlatformAuthorizations = createLinkedPlatformAuthorizationStore(db);
  const shippingAddresses = createShippingAddressRuntime(deps);

  return {
    accounts,
    users,
    memberships,
    invitations,
    foundersCohort,
    apiKeys,
    consents,
    preferences,
    linkedPlatformAuthorizations,
    shippingAddresses,
    policies,
    projectors: [
      ...accounts.projectors,
      ...users.projectors,
      ...memberships.projectors,
      ...invitations.projectors,
      ...foundersCohort.projectors,
      ...apiKeys.projectors,
      ...consents.projectors,
      ...preferences.projectors,
      ...shippingAddresses.projectors,
      ...policies.projectors,
    ],
    pool,
    db,
    auth,
  };
}
