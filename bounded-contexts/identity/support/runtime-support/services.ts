import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createIdentitySecretAdapters } from "../../features/api-keys/api/secret-adapters";
import { createAccountCapabilityRuntime } from "../../features/account-capabilities/api/runtime";
import type { AccountCapabilityCatalog } from "../../features/account-capabilities/api/runtime";
import type { CapabilityAdministrationAuthority } from "../../features/account-capabilities/api/authority";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createAccountRuntime } from "../../features/accounts/api/runtime";
import { createAccessHubRuntime } from "../../features/access-hub/api/runtime";
import { createApiKeyRuntime } from "../../features/api-keys/api/runtime";
import { createConsentRuntime } from "../../features/consents/api/runtime";
import {
  assertRegistrationConsentDeclaration,
  bindRegistrationConsentSubject,
  resolveConsentBundle,
  type RegistrationConsentBundles,
} from "../../features/consents/domain/consent-bundle";
import { createInvitationRuntime } from "../../features/invitations/api/runtime";
import { createFoundersCohortRuntime } from "../../features/founders-cohort/api/runtime";
import { createMembershipRuntime } from "../../features/memberships/api/runtime";
import { createUserPreferencesRuntime } from "../../features/preferences/api/runtime";
import { createShippingAddressRuntime } from "../../features/shipping-addresses/api/runtime";
import { createUserRuntime } from "../../features/users/api/runtime";
import { createLinkedPlatformAuthorizationStore } from "../ucp-support/linked-platform-authorizations";
import { createAgentGrantRevocations, type AgentGrantRevocations } from "../../features/agent-grants/api/revocation";
import {
  createIdentityMutationPersistence,
  type IdentityMutationPersistence,
} from "../../features/account-management/api/fences";
import {
  createAccountManagementRuntime,
  type AccountManagementServices,
} from "../../features/account-management/api/runtime";

export type IdentityServices = Readonly<{
  eventStore?: EventStore;
  /** Transactional Identity persistence; every Social Login Link and ownership claim commits through it. */
  mutationPersistence: IdentityMutationPersistence;
  accountManagement?: AccountManagementServices;
  accessHub: ReturnType<typeof createAccessHubRuntime>;
  accounts: ReturnType<typeof createAccountRuntime>;
  accountCapabilities: ReturnType<typeof createAccountCapabilityRuntime>;
  users: ReturnType<typeof createUserRuntime>;
  memberships: ReturnType<typeof createMembershipRuntime>;
  invitations: ReturnType<typeof createInvitationRuntime>;
  foundersCohort: ReturnType<typeof createFoundersCohortRuntime>;
  apiKeys: ReturnType<typeof createApiKeyRuntime>;
  consents: ReturnType<typeof createConsentRuntime>;
  registrationConsentBundles: RegistrationConsentBundles;
  preferences: ReturnType<typeof createUserPreferencesRuntime>;
  linkedPlatformAuthorizations: ReturnType<typeof createLinkedPlatformAuthorizationStore>;
  agentGrantRevocations: AgentGrantRevocations;
  shippingAddresses: ReturnType<typeof createShippingAddressRuntime>;
  /** The shared platform-policy runtime, mounted for this context's `definePolicy` documents (Terms of Service active version). */
  policies: PolicyRuntime;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
  auth: ReturnType<typeof createIdentitySecretAdapters>;
}>;

export type IdentityHostPorts = Readonly<{
  capabilityAdministrationAuthority: CapabilityAdministrationAuthority;
  accountCapabilityRegistry?: AccountCapabilityCatalog;
  addressVerificationProvider?: PostageLabelProvider | null;
}>;

export function createIdentityServices(pool: PgTransactionalPool, ports: IdentityHostPorts): IdentityServices {
  if (
    !ports?.capabilityAdministrationAuthority ||
    !["configured", "deny-all"].includes(ports.capabilityAdministrationAuthority.kind)
  ) {
    throw new Error("Identity requires capabilityAdministrationAuthority host capability.");
  }
  const postgresEventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "identity" }),
  });
  let projectors: readonly ProjectionHandlerSet[] = [];
  const mutationPersistence = createIdentityMutationPersistence(pool, postgresEventStore, () => projectors);
  const eventStore = mutationPersistence.eventStore;
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const auth = createIdentitySecretAdapters();
  const policies = createPolicyRuntime({ eventStore, db });
  const registrationConsentBundles: RegistrationConsentBundles = {
    async resolve() {
      const declaration = await resolveConsentBundle(policies.consentActivation, "registration");
      assertRegistrationConsentDeclaration(declaration);
      return declaration;
    },
    async forRegistration(subject) {
      return bindRegistrationConsentSubject(await registrationConsentBundles.resolve(), subject);
    },
  };
  const deps = {
    eventStore,
    checkpointStore,
    db,
    addressVerificationProvider: ports.addressVerificationProvider,
  } as const;

  const accounts = createAccountRuntime(deps);
  const accountCapabilities = createAccountCapabilityRuntime(deps, {
    authority: ports.capabilityAdministrationAuthority,
    registry: ports.accountCapabilityRegistry ?? [],
    targetAccountInTenant: async (accountId, tenantId) => {
      const events = await readCompleteStream(eventStore, {
        streamId: `identity.account-${accountId}`,
        maxEvents: 10000,
      });
      return events.length > 0 && events.every((event) => event.tenantId === tenantId);
    },
  });
  const accessHub = createAccessHubRuntime(deps);
  const users = createUserRuntime(deps);
  const memberships = createMembershipRuntime(deps);
  const invitations = createInvitationRuntime(deps);
  const foundersCohort = createFoundersCohortRuntime(deps, accounts);
  const apiKeys = createApiKeyRuntime(deps);
  const consents = createConsentRuntime(deps);
  const preferences = createUserPreferencesRuntime(deps);
  const linkedPlatformAuthorizations = createLinkedPlatformAuthorizationStore(pool);
  const shippingAddresses = createShippingAddressRuntime(deps);
  const accountManagement = createAccountManagementRuntime(mutationPersistence, { auth, shippingAddresses });

  projectors = [
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
  ];

  return {
    eventStore,
    mutationPersistence,
    agentGrantRevocations: createAgentGrantRevocations(pool, postgresEventStore),
    accountManagement,
    accessHub,
    accounts,
    accountCapabilities,
    users,
    memberships,
    invitations,
    foundersCohort,
    apiKeys,
    consents,
    registrationConsentBundles,
    preferences,
    linkedPlatformAuthorizations,
    shippingAddresses,
    policies,
    projectors,
    pool,
    db,
    auth,
  };
}
