import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createIdentitySecretAdapters } from "../../features/api-keys/api/secret-adapters";
import { createAccountRuntime } from "../../features/accounts/api/runtime";
import { createApiKeyRuntime } from "../../features/api-keys/api/runtime";
import { createConsentRuntime } from "../../features/consents/api/runtime";
import { createInvitationRuntime } from "../../features/invitations/api/runtime";
import { createMembershipRuntime } from "../../features/memberships/api/runtime";
import { createShippingAddressRuntime } from "../../features/shipping-addresses/api/runtime";
import { createUserRuntime } from "../../features/users/api/runtime";
import { createLinkedPlatformAuthorizationStore } from "../ucp-support/linked-platform-authorizations";

export type IdentityServices = Readonly<{
  accounts: ReturnType<typeof createAccountRuntime>;
  users: ReturnType<typeof createUserRuntime>;
  memberships: ReturnType<typeof createMembershipRuntime>;
  invitations: ReturnType<typeof createInvitationRuntime>;
  apiKeys: ReturnType<typeof createApiKeyRuntime>;
  consents: ReturnType<typeof createConsentRuntime>;
  linkedPlatformAuthorizations: ReturnType<typeof createLinkedPlatformAuthorizationStore>;
  shippingAddresses: ReturnType<typeof createShippingAddressRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
  auth: ReturnType<typeof createIdentitySecretAdapters>;
}>;

export function createIdentityServices(pool: PgTransactionalPool): IdentityServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "identity" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const auth = createIdentitySecretAdapters();
  const deps = { eventStore, checkpointStore, db } as const;

  const accounts = createAccountRuntime(deps);
  const users = createUserRuntime(deps);
  const memberships = createMembershipRuntime(deps);
  const invitations = createInvitationRuntime(deps);
  const apiKeys = createApiKeyRuntime(deps);
  const consents = createConsentRuntime(deps);
  const linkedPlatformAuthorizations = createLinkedPlatformAuthorizationStore(db);
  const shippingAddresses = createShippingAddressRuntime(deps);

  return {
    accounts,
    users,
    memberships,
    invitations,
    apiKeys,
    consents,
    linkedPlatformAuthorizations,
    shippingAddresses,
    projectors: [
      ...accounts.projectors,
      ...users.projectors,
      ...memberships.projectors,
      ...invitations.projectors,
      ...apiKeys.projectors,
      ...consents.projectors,
      ...shippingAddresses.projectors,
    ],
    pool,
    db,
    auth,
  };
}
