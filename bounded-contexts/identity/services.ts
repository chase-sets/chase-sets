import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { createIdentitySecretAdapters } from "./api-keys/secret-adapters";
import { createAccountRuntime } from "./accounts/runtime";
import { createApiKeyRuntime } from "./api-keys/runtime";
import { createConsentRuntime } from "./consents/runtime";
import { createInvitationRuntime } from "./invitations/runtime";
import { createMembershipRuntime } from "./memberships/runtime";
import { createUserRuntime } from "./users/runtime";

export type IdentityServices = Readonly<{
  accounts: ReturnType<typeof createAccountRuntime>;
  users: ReturnType<typeof createUserRuntime>;
  memberships: ReturnType<typeof createMembershipRuntime>;
  invitations: ReturnType<typeof createInvitationRuntime>;
  apiKeys: ReturnType<typeof createApiKeyRuntime>;
  consents: ReturnType<typeof createConsentRuntime>;
  projectors: readonly Projector[];
  pool: PgTransactionalPool;
  db: PgQueryable;
  auth: ReturnType<typeof createIdentitySecretAdapters>;
}>;

export function createIdentityServices(pool: PgTransactionalPool): IdentityServices {
  const eventStore = createPostgresEventStore({ pool });
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

  return {
    accounts,
    users,
    memberships,
    invitations,
    apiKeys,
    consents,
    projectors: [
      ...accounts.projectors,
      ...users.projectors,
      ...memberships.projectors,
      ...invitations.projectors,
      ...apiKeys.projectors,
      ...consents.projectors,
    ],
    pool,
    db,
    auth,
  };
}
