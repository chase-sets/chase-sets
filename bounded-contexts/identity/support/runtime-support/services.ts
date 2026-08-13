import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import { createPolicyRuntime, type PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createIdentitySecretAdapters } from "../../features/api-keys/api/secret-adapters";
import { createAccountRuntime } from "../../features/accounts/api/runtime";
import { createAccessHubRuntime } from "../../features/access-hub/api/runtime";
import { createApiKeyRuntime } from "../../features/api-keys/api/runtime";
import { createConsentRuntime } from "../../features/consents/api/runtime";
import {
  resolveConsentBundle,
  type RegistrationConsentBundleResolver,
} from "../../features/consents/domain/consent-bundle";
import { REGISTRATION_CONSENT_BUNDLE_KEY } from "../../features/consents/domain/registration-consent";
import { createInvitationRuntime } from "../../features/invitations/api/runtime";
import { createFoundersCohortRuntime } from "../../features/founders-cohort/api/runtime";
import { createMembershipRuntime } from "../../features/memberships/api/runtime";
import { createUserPreferencesRuntime } from "../../features/preferences/api/runtime";
import { createShippingAddressRuntime } from "../../features/shipping-addresses/api/runtime";
import { createUserRuntime } from "../../features/users/api/runtime";
import { createLinkedPlatformAuthorizationStore } from "../ucp-support/linked-platform-authorizations";

export type IdentityServices = Readonly<{
  eventStore?: EventStore;
  accessHub: ReturnType<typeof createAccessHubRuntime>;
  accounts: ReturnType<typeof createAccountRuntime>;
  users: ReturnType<typeof createUserRuntime>;
  memberships: ReturnType<typeof createMembershipRuntime>;
  invitations: ReturnType<typeof createInvitationRuntime>;
  foundersCohort: ReturnType<typeof createFoundersCohortRuntime>;
  apiKeys: ReturnType<typeof createApiKeyRuntime>;
  consents: ReturnType<typeof createConsentRuntime>;
  /**
   * The registration Consent Bundle seam. Required and non-optional: a services
   * object that cannot resolve the bundle cannot register anybody, which is
   * what stops a host from composing an Identity that mints or admits
   * registration consent without consulting a validated activation authority.
   */
  registrationConsentBundles: RegistrationConsentBundleResolver;
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
  const accessHub = createAccessHubRuntime(deps);
  const users = createUserRuntime(deps);
  const memberships = createMembershipRuntime(deps);
  const invitations = createInvitationRuntime(deps);
  const foundersCohort = createFoundersCohortRuntime(deps, accounts);
  const apiKeys = createApiKeyRuntime(deps);
  const consents = createConsentRuntime(deps);
  const preferences = createUserPreferencesRuntime(deps);
  const linkedPlatformAuthorizations = createLinkedPlatformAuthorizationStore(db);
  const shippingAddresses = createShippingAddressRuntime(deps);
  // Bound unconditionally, with no port, no override and no options argument
  // reaching it: there is no shape in which a caller composes this runtime and
  // supplies a different registration bundle resolver. It is handed only the
  // Consent Activation Authority surface, so the cached `resolvePolicy` value
  // is structurally unreachable from bundle resolution.
  const registrationConsentBundles: RegistrationConsentBundleResolver = {
    resolve: () => resolveConsentBundle(policies.consentActivation, REGISTRATION_CONSENT_BUNDLE_KEY),
  };

  return {
    eventStore,
    accessHub,
    accounts,
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
