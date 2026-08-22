import { Hono } from "hono";
import type { Context } from "hono";
import { t } from "@chase-sets/localization";
import { hasPermission as hasActorPermission, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { DomainEvent } from "@chase-sets/event-core";
import type { AppendToStreamsResult, EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  EventStoreContext,
  ExpectedStreamVersion,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { AccountId, ConsentId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import { getApiKeySecretByPrefix } from "./features/api-keys/api/secret-store";
import {
  formatGrantableRoleKeys,
  IdentityDomainError,
  normalizeEmail,
  normalizeLabel,
  normalizePhoneNumber,
  parseGrantableRoleKey,
  type GrantableRoleKey,
  type PermissionKey,
} from "./support/runtime-support/common";
import type { IdentityServices } from "./support/runtime-support/services";
import { accountRoutes } from "./features/accounts/api/route";
import { accessHubRoutes } from "./features/access-hub/api/route";
import { userRoutes } from "./features/users/api/route";
import { membershipRoutes } from "./features/memberships/api/route";
import { invitationRoutes } from "./features/invitations/api/route";
import { validateInvitationAcceptanceToken } from "./features/invitations/domain/domain";
import {
  decideAccount,
  evolveAccount,
  GUEST_ACCOUNT_PLACEHOLDER_DISPLAY_NAME,
  initialAccountState,
  type AccountEvent,
  type AccountState,
} from "./features/accounts/domain/domain";
import {
  decideUser,
  evolveUser,
  initialUserState,
  type UserEvent,
  type UserState,
} from "./features/users/domain/domain";
import {
  decideMembership,
  evolveMembership,
  initialMembershipState,
  type MembershipEvent,
  type MembershipState,
} from "./features/memberships/domain/domain";
import {
  decideAuthorizedConsent,
  evolveConsent,
  initialConsentState,
  type ConsentEvent,
  type ConsentState,
} from "./features/consents/domain/domain";
import {
  deriveRegistrationOperation,
  normalizeRegistrationDisplayNameKey,
  readCompleteRegistrationStreamHistory,
  readRegistrationOperationClaim,
  registrationOperationConsentBundleAgrees,
  REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE,
  REGISTRATION_OPERATION_KEY_VERSION,
  RegistrationOperationClaimHistoryError,
  type RegistrationOperation,
  type RegistrationOperationClaim,
  type RegistrationOperationConsent,
} from "./support/runtime-support/registration-operation";
import { apiKeyRoutes } from "./features/api-keys/api/route";
import { consentRoutes } from "./features/consents/api/route";
import { termsOfServiceConsentRoutes } from "./features/consents/api/terms-route";
import {
  assertConsentAuthorizationForContext,
  authorizeConsentForSelfRegistration,
} from "./features/consents/domain/consent-recording-authorization";
import {
  mintRegistrationConsentResolution,
  resolveRegistrationConsentRequirements,
  verifyRegistrationConsentSubmission,
  type RegistrationConsentRejection,
  type RegistrationConsentSubmission,
} from "./features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "./support/runtime-support/registration-consent-signing";
import { userPreferencesRoutes } from "./features/preferences/api/route";
import { shippingAddressRoutes } from "./features/shipping-addresses/api/route";
import { createIdentityBootstrapContext } from "./support/runtime-support/bootstrap-context";
import { buildCurrentActorDisplay } from "./support/shell-support/current-actor-display";
import { publishIdentityCsatOutcomeFact } from "./support/request-support/csat-outcome-facts";

export type IdentityApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor | null;
  };
};

function hasPermission(actor: ResolvedActor | null | undefined, permission: PermissionKey) {
  return hasActorPermission(actor, permission);
}

export function createBootstrapContext(): EventStoreContext {
  return createIdentityBootstrapContext();
}

function getBootstrapContext(c: Context<IdentityApiEnv>) {
  return c.var.context ?? createBootstrapContext();
}

function getRequiredContext(c: Context<IdentityApiEnv>) {
  const context = c.var.context;
  if (!context) {
    throw new Error("Missing identity request context.");
  }
  return context;
}

export class IdentityDisplayNameConflictError extends Error {
  constructor() {
    super("Display name is already taken.");
    this.name = "IdentityDisplayNameConflictError";
  }
}

/**
 * The states outside the one window in which a guest Account display name may
 * converge. Every one of them is derived from committed Account aggregate
 * state, and every one of them is decided before the reservation row is
 * written, so a refusal leaves the reservation table exactly as it found it.
 *
 * A refusal is a ruling, not an outage: the caller must be able to tell it
 * apart from a transient failure, or it forms a retry loop that asks the same
 * settled question forever.
 */
export const guestAccountDisplayNameConvergenceRefusalReasons = [
  "display_name_required",
  "account_not_found",
  "account_closed",
  "display_name_not_placeholder",
] as const;

export type GuestAccountDisplayNameConvergenceRefusalReason =
  (typeof guestAccountDisplayNameConvergenceRefusalReasons)[number];

export class IdentityGuestDisplayNameConvergenceRefusedError extends Error {
  constructor(public readonly reason: GuestAccountDisplayNameConvergenceRefusalReason) {
    super("Guest account display name cannot converge from its committed state.");
    this.name = "IdentityGuestDisplayNameConvergenceRefusedError";
  }
}

/**
 * Thrown by the personal-identity constructor when the registration consent
 * submission is not a value Identity minted, is stale, or leaves requirements
 * unaffirmed. Raised before any aggregate write, so a rejected registration
 * leaves no account, user, membership, or consent behind.
 */
export class RegistrationConsentRejectedError extends Error {
  constructor(public readonly rejection: RegistrationConsentRejection) {
    super(rejection.message);
    this.name = "RegistrationConsentRejectedError";
  }
}

export function normalizeAccountDisplayNameKey(displayName: string) {
  return normalizeRegistrationDisplayNameKey(displayName);
}

type IdentityMutationSnapshot = Readonly<{
  aggregate: "account" | "api-key" | "consent" | "invitation" | "membership" | "user";
  id: string;
  version: number;
  status: string;
}>;

function mutationSnapshot<State extends Readonly<object>>(
  aggregate: IdentityMutationSnapshot["aggregate"],
  id: string,
  result: Readonly<{ version: number; state: State }>,
  options: Readonly<{ fallbackStatus?: string }> = {},
): IdentityMutationSnapshot {
  const stateStatus = "status" in result.state ? result.state.status : undefined;

  return {
    aggregate,
    id,
    version: result.version,
    status: typeof stateStatus === "string" ? stateStatus : (options.fallbackStatus ?? "committed"),
  };
}

/**
 * Claim the display name for one Registration Operation.
 *
 * This row cannot join the event append. `withPgTransaction` issues an
 * unconditional BEGIN/COMMIT on a freshly connected client, so handing the
 * event store a client-backed pool facade would commit the registration before
 * an outer failure is even known. The reservation therefore has to be safe to
 * find left behind, which is what the operation binding buys: a retry of the
 * same operation reclaims its own row and proceeds, and every other operation
 * still conflicts.
 *
 * The `identity_accounts` read is a stale projection and is deliberately not
 * the uniqueness authority -- it survives only as a friendlier message ahead of
 * the primary key and the operation predicate below, which are.
 */
async function reservePersonalAccountDisplayName(
  services: IdentityServices,
  eventStore: EventStore,
  params: Readonly<{
    accountId: AccountId;
    displayName: string;
    operationKey: string;
  }>,
) {
  const displayNameKey = normalizeAccountDisplayNameKey(params.displayName);
  if (!displayNameKey) {
    return;
  }

  const existingAccount = await services.db.query<{ account_id: string }>(
    `SELECT account_id
     FROM identity_accounts
     WHERE lower(regexp_replace(btrim(display_name), '[[:space:]]+', ' ', 'g')) = $1
     LIMIT 1`,
    [displayNameKey],
  );
  if (existingAccount.rows.some((row) => row.account_id !== params.accountId)) {
    throw new IdentityDisplayNameConflictError();
  }

  // The ON CONFLICT predicate is the concurrency guard: it re-asserts the state
  // this writer is entitled to overwrite. A key-only upsert here would let any
  // registration steal any held display name.
  const reservation = await services.db.query<{ display_name_key: string }>(
    `INSERT INTO identity_account_display_name_reservations (
       display_name_key,
       account_id,
       display_name,
       operation_key,
       created_at
     )
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (display_name_key) DO UPDATE
        SET account_id = EXCLUDED.account_id,
            display_name = EXCLUDED.display_name
      WHERE identity_account_display_name_reservations.operation_key = EXCLUDED.operation_key
     RETURNING display_name_key`,
    [displayNameKey, params.accountId, params.displayName, params.operationKey],
  );
  if (reservation.rows.length > 0) {
    return;
  }

  await reclaimStrandedDisplayNameReservation(services, eventStore, { ...params, displayNameKey });
}

/**
 * Reclaim a reservation written before reservations were bound to an operation.
 *
 * Such a row is reclaimable only when its account was never committed: that is
 * the stranded artifact of a pre-atomic attempt that died between the
 * reservation write and the account write, and it is exactly the artifact that
 * used to turn a retry into a 409. A row whose account does exist names a real
 * account -- adopting it would grant a stranger an owner membership on somebody
 * else's account -- so it stays a conflict.
 */
async function reclaimStrandedDisplayNameReservation(
  services: IdentityServices,
  eventStore: EventStore,
  params: Readonly<{
    accountId: AccountId;
    displayName: string;
    displayNameKey: string;
    operationKey: string;
  }>,
) {
  const held = await services.db.query<{ account_id: string; operation_key: string | null }>(
    `SELECT account_id, operation_key
     FROM identity_account_display_name_reservations
     WHERE display_name_key = $1`,
    [params.displayNameKey],
  );
  const heldRow = held.rows[0];
  if (!heldRow || heldRow.operation_key !== null) {
    throw new IdentityDisplayNameConflictError();
  }

  // @stream-read-contract bounded-contexts/identity/tests/registration-operation-recovery.db.test.ts
  const strandedAccount = await eventStore.readStream({
    streamId: `identity.account-${heldRow.account_id}`,
    limit: 1,
  });
  if (strandedAccount.length > 0) {
    throw new IdentityDisplayNameConflictError();
  }

  const adopted = await services.db.query<{ display_name_key: string }>(
    `UPDATE identity_account_display_name_reservations
        SET account_id = $2,
            display_name = $3,
            operation_key = $4
      WHERE display_name_key = $1
        AND operation_key IS NULL
        AND account_id = $5
     RETURNING display_name_key`,
    [params.displayNameKey, params.accountId, params.displayName, params.operationKey, heldRow.account_id],
  );
  if (adopted.rows.length === 0) {
    throw new IdentityDisplayNameConflictError();
  }
}

/**
 * Drop the reservation this attempt took, once it is known to have committed
 * nothing, so a failed registration leaves the table exactly as it found it.
 *
 * The account it minted is the discriminator. Two attempts for one operation
 * share an operation key, so the key alone cannot tell this attempt's row from
 * a concurrent winner's -- and the winner's row must survive, or its committed
 * account loses its display name. A row whose account is the claimed account is
 * therefore left alone; anything else belonged to an attempt that committed
 * nothing, including a losing attempt that reserved a different display name
 * before adopting the winner's.
 *
 * Best effort by construction: if it fails, the row is still bound to this
 * operation and a retry of it still reclaims it.
 */
async function releaseUnclaimedDisplayNameReservation(
  services: IdentityServices,
  eventStore: EventStore,
  params: Readonly<{
    accountId: AccountId;
    displayName: string;
    operation: RegistrationOperation;
  }>,
) {
  const displayNameKey = normalizeAccountDisplayNameKey(params.displayName);
  if (!displayNameKey) {
    return;
  }

  try {
    const claimed = await readRegistrationOperationClaim(eventStore, params.operation);
    if (claimed?.claim.accountId === params.accountId) {
      return;
    }

    await services.db.query(
      `DELETE FROM identity_account_display_name_reservations
        WHERE display_name_key = $1
          AND operation_key = $2
          AND account_id = $3`,
      [displayNameKey, params.operation.key, params.accountId],
    );
  } catch {
    // Cleanup is an optimization, never a gate, and it must never replace the
    // failure the caller is already reporting.
  }
}

type RegistrationParticipant<State> = Readonly<{
  streamId: string;
  version: number;
  storedEvents: readonly StoredEvent[];
  state: State;
}>;

type RegistrationParticipantHistory = Readonly<{
  creationEventType: string;
  allowedEventTypes: ReadonlySet<string>;
}>;

const accountRegistrationHistory: RegistrationParticipantHistory = {
  creationEventType: "identity.account.created",
  allowedEventTypes: new Set([
    "identity.account.created",
    "identity.account.profile-updated",
    "identity.account.suspended",
    "identity.account.reactivated",
    "identity.account.closed",
    "identity.account.founders-window-opened",
    "identity.account.badge-assigned",
    "identity.account.badge-removed",
  ]),
};

const userRegistrationHistory: RegistrationParticipantHistory = {
  creationEventType: "identity.user.created",
  allowedEventTypes: new Set([
    "identity.user.created",
    "identity.user.profile-updated",
    "identity.user.contact-method-added",
    "identity.user.contact-method-verified",
    "identity.user.auth-method-enabled",
    "identity.user.auth-method-disabled",
    "identity.user.password-credential-attached",
    "identity.user.passkey-registered",
    "identity.user.social-login-linked",
    "identity.user.suspended",
    "identity.user.reactivated",
  ]),
};

const membershipRegistrationHistory: RegistrationParticipantHistory = {
  creationEventType: "identity.membership.granted",
  allowedEventTypes: new Set([
    "identity.membership.granted",
    "identity.membership.role-changed",
    "identity.membership.revoked",
    "identity.membership.reinstated",
  ]),
};

const consentRegistrationHistory: RegistrationParticipantHistory = {
  creationEventType: "identity.consent.recorded",
  allowedEventTypes: new Set(["identity.consent.recorded", "identity.consent.withdrawn"]),
};

/**
 * Rehydrate one participant stream from the command side.
 *
 * Registration reads and appends through the event store directly rather than
 * through each feature's command handler, because a command handler owns its
 * own single-stream append and there is no shape in which five of them share
 * one transaction. The deciders and evolvers used here are the same exported
 * pure functions those handlers are built from, so the events produced are
 * identical -- only the commit boundary moves.
 */
async function readRegistrationParticipant<State, Event extends DomainEvent>(
  eventStore: EventStore,
  streamId: string,
  initialState: State,
  evolve: (state: Readonly<State>, event: Readonly<Event>) => State,
  history: RegistrationParticipantHistory,
  disagreement: () => Error,
): Promise<RegistrationParticipant<State>> {
  const storedEvents = await readCompleteRegistrationStreamHistory(eventStore, streamId);
  if (storedEvents.length > 0) {
    const firstEvent = storedEvents[0];
    const creationCount = storedEvents.filter((event) => event.eventType === history.creationEventType).length;
    if (
      !firstEvent ||
      firstEvent.eventType !== history.creationEventType ||
      creationCount !== 1 ||
      storedEvents.some((event, index) => event.streamVersion !== index + 1) ||
      storedEvents.some((event) => !history.allowedEventTypes.has(event.eventType))
    ) {
      throw disagreement();
    }
  }

  try {
    return {
      streamId,
      version: storedEvents.length === 0 ? 0 : storedEvents[storedEvents.length - 1].streamVersion,
      storedEvents,
      state: storedEvents.reduce(
        (folded, storedEvent) => evolve(folded, { type: storedEvent.eventType, data: storedEvent.payload } as Event),
        initialState,
      ),
    };
  } catch {
    throw disagreement();
  }
}

function registrationParticipantInput(
  streamId: string,
  expectedVersion: ExpectedStreamVersion,
  events: readonly DomainEvent[],
  context: EventStoreContext,
): AppendToStreamInput {
  return {
    streamId,
    expectedVersion,
    events: events.map((event) => ({ eventType: event.type, payload: event.data })),
    context,
  };
}

function committedParticipantVersion(
  results: readonly AppendToStreamsResult[],
  streamId: string,
  priorVersion: number,
): number {
  const storedEvents = results.find((result) => result.streamId === streamId)?.storedEvents ?? [];
  return storedEvents.length === 0 ? priorVersion : storedEvents[storedEvents.length - 1].streamVersion;
}

function isEventStoreConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}

/**
 * Registration reaches the event store directly, so a services object that
 * carries no multi-stream append cannot register anybody. Failing here is
 * deliberate: silently falling back to sequential per-aggregate commits is the
 * exact behaviour this composition exists to remove.
 */
function requireRegistrationEventStore(services: IdentityServices) {
  const eventStore = services.eventStore;
  if (!eventStore?.appendToStreams) {
    throw new Error("Personal identity registration requires an event store that appends to many streams atomically.");
  }

  return eventStore as EventStore & Readonly<{ appendToStreams: NonNullable<EventStore["appendToStreams"]> }>;
}

/** Raised when no verified contact accompanies a registration, so no operation identity can be derived. */
export class RegistrationOperationContactRequiredError extends Error {
  constructor() {
    super("A verified email or phone is required to register a personal identity.");
    this.name = "RegistrationOperationContactRequiredError";
  }
}

/**
 * Raised when an operation was already claimed against a different ordered
 * consent bundle than the recovering request carries. Completing it would
 * append consent at versions nobody in this operation ever affirmed, so
 * registration fails closed and appends nothing. Reconciling a genuine version
 * disagreement is activation-authority work owned elsewhere.
 */
export class RegistrationOperationConsentDisagreementError extends Error {
  constructor() {
    super("This registration operation already recorded a different consent bundle.");
    this.name = "RegistrationOperationConsentDisagreementError";
  }
}

/**
 * Raised when the claim itself or a non-Consent participant contradicts the
 * registration operation. Recovery cannot use ids from poisoned authority or
 * silently skip an aggregate that is not in its required final state.
 */
export class RegistrationOperationParticipantDisagreementError extends Error {
  constructor() {
    super("This registration operation contains a participant that disagrees with its claim.");
    this.name = "RegistrationOperationParticipantDisagreementError";
  }
}

type RegistrationIdentity = Readonly<{
  accountId: AccountId;
  userId: UserId;
  membershipId: MembershipId;
  displayName: string;
  displayNameKey: string;
  consents: readonly RegistrationOperationConsent[];
}>;

/** Two passes: the first can lose the claim race, the second runs against the winner's committed ids. */
const REGISTRATION_CONVERGENCE_ATTEMPTS = 2;

async function createPersonalIdentityForAuth(
  services: IdentityServices,
  params: Readonly<{
    email?: string | null;
    phone?: string | null;
    displayName: string;
    givenName?: string;
    familyName?: string;
    /**
     * Required, non-optional, non-nullable. This is the enforcement: every
     * caller must produce a value only Identity can mint, so destructuring a
     * raw client, rebuilding the URL from string fragments, aliasing the
     * contract type, or defining a same-named local binder all still have to
     * come up with a valid signature -- and none of them can.
     */
    registrationConsent: RegistrationConsentSubmission;
    foundersBetaAccessStartedAt?: string;
    context: EventStoreContext;
  }>,
) {
  // First statement, before the display-name reservation and before any
  // append: the constructor is the chokepoint, so verification lives here
  // rather than in the route wrapper. A future route that reaches this
  // function inherits the check instead of having to remember it.
  const verification = verifyRegistrationConsentSubmission(params.registrationConsent, {
    signingKeys: resolveRegistrationConsentSigningKeys(),
    nowMs: Date.now(),
  });
  if (!verification.ok) {
    throw new RegistrationConsentRejectedError(verification.rejection);
  }
  const verifiedRegistrationConsent = verification.submission;

  const eventStore = requireRegistrationEventStore(services);
  // Derived here, from the contact every caller already supplies. No route,
  // client, or contract gains a field: a new required member on this command is
  // precisely how the caller-inventory defect class bites.
  const operation = deriveRegistrationOperation({ email: params.email, phone: params.phone });
  if (!operation) {
    throw new RegistrationOperationContactRequiredError();
  }

  const email = params.email?.trim() ?? "";
  const phone = params.phone?.trim() ?? "";
  const requirements = verifiedRegistrationConsent.resolution.requirements;
  const proposedDisplayName = normalizeLabel(params.displayName) || email || phone;

  for (let attempt = 1; ; attempt += 1) {
    let claimed: Awaited<ReturnType<typeof readRegistrationOperationClaim>>;
    try {
      claimed = await readRegistrationOperationClaim(eventStore, operation);
    } catch (error) {
      if (error instanceof RegistrationOperationClaimHistoryError) {
        throw new RegistrationOperationParticipantDisagreementError();
      }
      throw error;
    }
    if (claimed && !registrationOperationConsentBundleAgrees(claimed.claim, requirements)) {
      throw new RegistrationOperationConsentDisagreementError();
    }

    const identity: RegistrationIdentity = claimed
      ? {
          accountId: claimed.claim.accountId,
          userId: claimed.claim.userId,
          membershipId: claimed.claim.membershipId,
          displayName: claimed.claim.displayName,
          displayNameKey: claimed.claim.displayNameKey,
          consents: claimed.claim.consents,
        }
      : {
          accountId: createId("acc") as AccountId,
          userId: createId("usr") as UserId,
          membershipId: createId("mbr") as MembershipId,
          displayName: proposedDisplayName,
          displayNameKey: normalizeAccountDisplayNameKey(proposedDisplayName),
          consents: requirements.map((requirement) => ({
            consentId: createId("cns") as ConsentId,
            policyKey: requirement.policyKey,
            policyVersion: requirement.version,
          })),
        };

    const plan = await planPersonalIdentityRegistration({
      eventStore,
      params,
      operation,
      identity,
      claimedVersion: claimed?.version ?? null,
      email,
      phone,
    });

    await reservePersonalAccountDisplayName(services, eventStore, {
      accountId: identity.accountId,
      displayName: identity.displayName,
      operationKey: operation.key,
    });

    try {
      return await appendPersonalIdentityRegistration({
        services,
        eventStore,
        params,
        operation,
        identity,
        plan,
      });
    } catch (error) {
      // Whichever way this attempt ends, it committed nothing, so the
      // reservation it took has to go before anything else happens. The loser
      // of a claim race may have reserved a different display name than the
      // winner settled on, and that row would otherwise hold a name forever on
      // behalf of an account that never existed.
      await releaseUnclaimedDisplayNameReservation(services, eventStore, {
        accountId: identity.accountId,
        displayName: identity.displayName,
        operation,
      });

      // The loser of the claim race rolled back every stream in its batch,
      // including the ones it would have created. The next pass re-reads the
      // committed claim, adopts the winner's ids, and returns the winner's
      // registration -- a same-operation caller never receives a conflict.
      if (attempt < REGISTRATION_CONVERGENCE_ATTEMPTS && isEventStoreConcurrencyConflict(error)) {
        continue;
      }

      throw error;
    }
  }
}

type RegistrationConsentPlan = Readonly<{
  consent: RegistrationOperationConsent;
  participant: RegistrationParticipant<ConsentState>;
  consentEvents: readonly ConsentEvent[];
  consentState: ConsentState;
}>;

type PersonalIdentityRegistrationPlan = Readonly<{
  claimedVersion: number | null;
  claim: RegistrationOperationClaim;
  account: RegistrationParticipant<AccountState>;
  accountEvents: readonly AccountEvent[];
  accountState: AccountState;
  user: RegistrationParticipant<UserState>;
  userEvents: readonly UserEvent[];
  userState: UserState;
  membership: RegistrationParticipant<MembershipState>;
  membershipEvents: readonly MembershipEvent[];
  membershipState: MembershipState;
  consentPlans: readonly RegistrationConsentPlan[];
}>;

/**
 * Read and semantically validate every participant before the display-name
 * reservation is touched. Empty event streams are missing participants; a
 * present stream must have one valid creation event, only known lifecycle
 * events, the claimed identity and metadata, and the required final state.
 */
async function planPersonalIdentityRegistration(
  args: Readonly<{
    eventStore: EventStore & Readonly<{ appendToStreams: NonNullable<EventStore["appendToStreams"]> }>;
    params: Readonly<{
      givenName?: string;
      familyName?: string;
      foundersBetaAccessStartedAt?: string;
      context: EventStoreContext;
    }>;
    operation: RegistrationOperation;
    identity: RegistrationIdentity;
    claimedVersion: number | null;
    email: string;
    phone: string;
  }>,
): Promise<PersonalIdentityRegistrationPlan> {
  const { eventStore, identity, operation, params } = args;
  const { accountId, userId, membershipId, displayName } = identity;
  const participantDisagreement = () => new RegistrationOperationParticipantDisagreementError();
  const consentDisagreement = () => new RegistrationOperationConsentDisagreementError();

  const account = await readRegistrationParticipant<AccountState, AccountEvent>(
    eventStore,
    `identity.account-${accountId}`,
    initialAccountState,
    evolveAccount,
    accountRegistrationHistory,
    participantDisagreement,
  );
  const user = await readRegistrationParticipant<UserState, UserEvent>(
    eventStore,
    `identity.user-${userId}`,
    initialUserState,
    evolveUser,
    userRegistrationHistory,
    participantDisagreement,
  );
  const membership = await readRegistrationParticipant<MembershipState, MembershipEvent>(
    eventStore,
    `identity.membership-${membershipId}`,
    initialMembershipState,
    evolveMembership,
    membershipRegistrationHistory,
    participantDisagreement,
  );
  const consents = await Promise.all(
    identity.consents.map(async (consent) => ({
      consent,
      participant: await readRegistrationParticipant<ConsentState, ConsentEvent>(
        eventStore,
        `identity.consent-${consent.consentId}`,
        initialConsentState,
        evolveConsent,
        consentRegistrationHistory,
        consentDisagreement,
      ),
    })),
  );

  if (
    account.storedEvents.length > 0 &&
    (account.state.id !== accountId ||
      account.state.status !== "active" ||
      account.storedEvents.some((event) => event.eventType === "identity.account.closed") ||
      account.state.accountType !== "personal" ||
      typeof account.state.name !== "string" ||
      account.state.displayName !== displayName ||
      normalizeAccountDisplayNameKey(account.state.displayName) !== identity.displayNameKey)
  ) {
    throw participantDisagreement();
  }
  if (
    user.storedEvents.length > 0 &&
    (user.state.id !== userId ||
      user.state.status !== "active" ||
      !registrationUserContactAgrees(user.state, operation))
  ) {
    throw participantDisagreement();
  }
  if (
    membership.storedEvents.length > 0 &&
    (membership.state.id !== membershipId ||
      membership.state.status !== "active" ||
      membership.state.roleKey !== "owner" ||
      membership.state.userId !== userId ||
      membership.state.accountId !== accountId)
  ) {
    throw participantDisagreement();
  }
  for (const { consent, participant } of consents) {
    if (
      participant.storedEvents.length > 0 &&
      (participant.state.id !== consent.consentId ||
        participant.state.status !== "recorded" ||
        participant.state.subjectType !== "user" ||
        participant.state.userId !== userId ||
        participant.state.accountId !== accountId ||
        participant.state.policyKey !== consent.policyKey ||
        participant.state.policyVersion !== consent.policyVersion ||
        participant.state.recordedAt === null ||
        !Number.isFinite(Date.parse(participant.state.recordedAt)) ||
        participant.state.withdrawnAt !== null)
    ) {
      throw consentDisagreement();
    }
  }

  let accountState = account.state;
  const accountEvents: AccountEvent[] = [];
  if (account.storedEvents.length === 0) {
    const created = decideAccount(accountState, {
      type: "CreateAccount",
      accountId,
      name: "",
      accountType: "personal",
      displayName,
    });
    accountEvents.push(...created);
    accountState = created.reduce(evolveAccount, accountState);
  }
  if (params.foundersBetaAccessStartedAt) {
    const betaAccessStartedAt = new Date(params.foundersBetaAccessStartedAt);
    const foundersWindowEndsAt = new Date(betaAccessStartedAt);
    foundersWindowEndsAt.setUTCDate(foundersWindowEndsAt.getUTCDate() + 60);
    const opened = decideAccount(accountState, {
      type: "OpenFoundersWindow",
      betaAccessStartedAt: betaAccessStartedAt.toISOString(),
      foundersWindowEndsAt: foundersWindowEndsAt.toISOString(),
      recipientEmail: args.email,
    });
    accountEvents.push(...opened);
    accountState = opened.reduce(evolveAccount, accountState);
  }

  let userState = user.state;
  const userEvents: UserEvent[] = [];
  if (user.storedEvents.length === 0) {
    const phoneIsOperationContact = operation.contactType === "phone";
    const created = decideUser(userState, {
      type: "CreateUser",
      userId,
      displayName,
      givenName: params.givenName,
      familyName: params.familyName,
      primaryEmail: args.email || null,
      ...(phoneIsOperationContact
        ? {
            primaryContactMethod: {
              contactMethodId: createId("ctm"),
              type: "phone" as const,
              value: args.phone,
              verifiedAt: new Date().toISOString(),
            },
          }
        : {}),
    });
    userEvents.push(...created);
    userState = created.reduce(evolveUser, userState);
  }
  if (args.phone) {
    let phoneContact = userState.contactMethods.find(
      (contact) => contact.type === "phone" && normalizePhoneNumber(contact.value) === normalizePhoneNumber(args.phone),
    );
    if (!phoneContact) {
      const contactMethodId = createId("ctm");
      const added = decideUser(userState, {
        type: "AddContactMethod",
        contactMethodId,
        contactMethodType: "phone",
        value: args.phone,
      });
      userEvents.push(...added);
      userState = added.reduce(evolveUser, userState);
      phoneContact = userState.contactMethods.find((contact) => contact.contactMethodId === contactMethodId);
    }
    if (phoneContact?.verifiedAt === null) {
      const verified = decideUser(userState, {
        type: "VerifyContactMethod",
        contactMethodId: phoneContact.contactMethodId,
        verifiedAt: new Date().toISOString(),
      });
      userEvents.push(...verified);
      userState = verified.reduce(evolveUser, userState);
    }
  }
  if (args.phone) {
    const enabled = decideUser(userState, { type: "EnableAuthMethod", authMethod: "sms-code" });
    userEvents.push(...enabled);
    userState = enabled.reduce(evolveUser, userState);
  }

  let membershipState = membership.state;
  const membershipEvents: MembershipEvent[] = [];
  if (membership.storedEvents.length === 0) {
    const granted = decideMembership(membershipState, {
      type: "GrantMembership",
      membershipId,
      userId,
      accountId,
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    });
    membershipEvents.push(...granted);
    membershipState = granted.reduce(evolveMembership, membershipState);
  }

  // Registration composes the Consent decider directly rather than through the
  // Consent runtime, so it has to carry that runtime's authorization checks
  // itself: the context check the handler performs, and the command check the
  // authorized decider performs. Recording Consent through the unauthorized
  // decider would silently reopen the write-authorization boundary.
  //
  // Reached on exactly the requests that record Consent, which is what the
  // runtime handler does too. Asserting it on a bundle with no requirements
  // would reject registrations that record no Consent at all and therefore
  // never had a write to authorize.
  const consentAuthorization = consents.length > 0 ? authorizeConsentForSelfRegistration(userId, accountId) : null;
  if (consentAuthorization) {
    assertConsentAuthorizationForContext(consentAuthorization, params.context);
  }

  // Each Consent is recorded at exactly the policy key and version carried in
  // the verified resolution, in its signed order. Never from raw client input,
  // and never from a fresh resolve taken here -- resolving at append time is
  // what recorded acceptance of a version the registering client never saw.
  const consentPlans = consents.map(({ consent, participant }) => {
    let consentState = participant.state;
    const consentEvents: ConsentEvent[] = [];
    if (participant.storedEvents.length === 0 && consentAuthorization) {
      const recorded = decideAuthorizedConsent(consentState, {
        command: {
          type: "RecordConsent",
          consentId: consent.consentId,
          subjectType: "user",
          userId,
          accountId,
          policyKey: consent.policyKey,
          policyVersion: consent.policyVersion,
          recordedAt: new Date().toISOString(),
        },
        authorization: consentAuthorization,
      });
      consentEvents.push(...recorded);
      consentState = recorded.reduce(evolveConsent, consentState);
    }
    return { consent, participant, consentEvents, consentState };
  });

  const claim: RegistrationOperationClaim = {
    operationKeyDigest: operation.keyDigest,
    operationKeyVersion: REGISTRATION_OPERATION_KEY_VERSION,
    contactType: operation.contactType,
    accountId,
    userId,
    membershipId,
    displayName,
    displayNameKey: identity.displayNameKey,
    consents: identity.consents,
    claimedAt: new Date().toISOString(),
  };

  return {
    claimedVersion: args.claimedVersion,
    claim,
    account,
    accountEvents,
    accountState,
    user,
    userEvents,
    userState,
    membership,
    membershipEvents,
    membershipState,
    consentPlans,
  };
}

function registrationUserContactAgrees(state: UserState, operation: RegistrationOperation): boolean {
  const primaryContact = state.contactMethods[0];
  if (
    !primaryContact ||
    typeof primaryContact.contactMethodId !== "string" ||
    primaryContact.contactMethodId.trim().length === 0 ||
    typeof primaryContact.value !== "string"
  ) {
    return false;
  }
  if (operation.contactType === "email") {
    return (
      normalizeEmail(state.primaryEmail ?? "") === operation.contactValue &&
      primaryContact?.type === "email" &&
      normalizeEmail(primaryContact.value) === operation.contactValue
    );
  }

  return (
    primaryContact.type === "phone" &&
    normalizePhoneNumber(primaryContact.value) === operation.contactValue &&
    typeof primaryContact.verifiedAt === "string" &&
    Number.isFinite(Date.parse(primaryContact.verifiedAt))
  );
}

/**
 * One all-or-nothing append covering the registration-operation claim, the
 * account, the user, the membership, and every Consent in the ordered bundle.
 * Existing participants contribute zero-event version guards, so a late writer
 * rolls back every earlier participant in this transaction.
 */
async function appendPersonalIdentityRegistration(
  args: Readonly<{
    services: IdentityServices;
    eventStore: EventStore & Readonly<{ appendToStreams: NonNullable<EventStore["appendToStreams"]> }>;
    params: Readonly<{ context: EventStoreContext }>;
    operation: RegistrationOperation;
    identity: RegistrationIdentity;
    plan: PersonalIdentityRegistrationPlan;
  }>,
) {
  const { eventStore, identity, operation, params, plan } = args;
  const { accountId, userId, membershipId } = identity;
  const results = await eventStore.appendToStreams([
    registrationParticipantInput(
      operation.streamId,
      plan.claimedVersion === null ? "no_stream" : plan.claimedVersion,
      plan.claimedVersion === null
        ? [{ type: REGISTRATION_OPERATION_CLAIMED_EVENT_TYPE, data: plan.claim as unknown as JsonObject }]
        : [],
      params.context,
    ),
    registrationParticipantInput(plan.account.streamId, plan.account.version, plan.accountEvents, params.context),
    registrationParticipantInput(plan.user.streamId, plan.user.version, plan.userEvents, params.context),
    registrationParticipantInput(
      plan.membership.streamId,
      plan.membership.version,
      plan.membershipEvents,
      params.context,
    ),
    ...plan.consentPlans.map((consentPlan) =>
      registrationParticipantInput(
        consentPlan.participant.streamId,
        consentPlan.participant.version,
        consentPlan.consentEvents,
        params.context,
      ),
    ),
  ]);

  const snapshots: IdentityMutationSnapshot[] = [
    mutationSnapshot("account", accountId, {
      version: committedParticipantVersion(results, plan.account.streamId, plan.account.version),
      state: plan.accountState,
    }),
    mutationSnapshot("membership", membershipId, {
      version: committedParticipantVersion(results, plan.membership.streamId, plan.membership.version),
      state: plan.membershipState,
    }),
    ...plan.consentPlans.map((consentPlan) =>
      mutationSnapshot(
        "consent",
        consentPlan.consent.consentId,
        {
          version: committedParticipantVersion(
            results,
            consentPlan.participant.streamId,
            consentPlan.participant.version,
          ),
          state: consentPlan.consentState,
        },
        { fallbackStatus: "recorded" },
      ),
    ),
    mutationSnapshot("user", userId, {
      version: committedParticipantVersion(results, plan.user.streamId, plan.user.version),
      state: plan.userState,
    }),
  ];

  // Strictly after the registration commits, and never able to convert a
  // committed registration into a failed response. Its idempotency key is
  // stable per operation because the account id now is.
  await publishRegistrationOutcomeFact(args.services, params.context, accountId);

  return { userId, accountId, membershipId, snapshots };
}

async function publishRegistrationOutcomeFact(
  services: IdentityServices,
  context: EventStoreContext,
  accountId: AccountId,
) {
  if (!services.eventStore) {
    return;
  }

  try {
    await publishIdentityCsatOutcomeFact(services.eventStore, context, {
      outcomeCode: "registration.completed",
      subjectAccountId: accountId,
      subjectKind: "account",
      subject: { entityType: "account", entityId: accountId },
      idempotencyKey: `identity:registration:${accountId}`,
    });
  } catch {
    // A cross-context outcome fact is not part of the registration atom. The
    // account, user, membership and consent bundle are already committed, and
    // reporting a failure here would tell the caller to retry work that
    // succeeded.
  }
}

async function createGuestAccountForAuth(
  services: IdentityServices,
  params: Readonly<{
    email: string;
    displayName: string;
    context: EventStoreContext;
  }>,
) {
  const accountId = createId("acc") as AccountId;
  const displayName = params.displayName.trim() || params.email.trim();

  const result = await services.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: {
      type: "CreateAccount",
      accountId,
      name: "",
      accountType: "personal",
      displayName,
    },
    context: params.context,
  });

  return { accountId, snapshots: [mutationSnapshot("account", accountId, result)] };
}

/**
 * The Identity-internal identity of one guest display-name convergence.
 *
 * Derived here, from the Account and the name it is converging to, exactly as
 * `deriveRegistrationOperation` derives registration's operation key from the
 * contact the caller already supplies. No route, client, or contract gains an
 * operation field: a caller-supplied key is precisely the shape the
 * caller-inventory defect class bites, and this rename's natural identity is
 * the Account itself.
 *
 * It is what makes the reservation write reclaimable. The reservation and the
 * Account append are two separate commits, so an identical retry has to be
 * able to take back the row its own earlier attempt left behind -- and no
 * other operation may.
 */
export const GUEST_ACCOUNT_DISPLAY_NAME_CONVERGENCE_OPERATION_NAMESPACE =
  "identity.guest-account-display-name-convergence";

export const GUEST_ACCOUNT_DISPLAY_NAME_CONVERGENCE_OPERATION_VERSION = "v1";

export function deriveGuestAccountDisplayNameConvergenceOperationKey(
  params: Readonly<{ accountId: string; displayNameKey: string }>,
) {
  return [
    GUEST_ACCOUNT_DISPLAY_NAME_CONVERGENCE_OPERATION_NAMESPACE,
    GUEST_ACCOUNT_DISPLAY_NAME_CONVERGENCE_OPERATION_VERSION,
    params.accountId,
    params.displayNameKey,
  ].join(":");
}

/**
 * Claim the display name for one guest convergence.
 *
 * Deliberately not a call into `reservePersonalAccountDisplayName`: that
 * function is registration-path surface, it pre-checks the `identity_accounts`
 * projection, and it can adopt a claim-less stranded row. None of that belongs
 * here. What is reused is the shape that matters -- the `ON CONFLICT` state
 * predicate, which re-asserts the row this writer is entitled to overwrite. A
 * key-only upsert here would let an anonymous guest steal any held display
 * name.
 *
 * Because a guest Account holds no reservation before it converges and
 * converges at most once, an identical retry always conflicts on
 * `display_name_key` and is reclaimed by the operation-key predicate; it never
 * reaches the table's `account_id` UNIQUE constraint, which the
 * `ON CONFLICT (display_name_key)` clause does not cover.
 */
async function reserveGuestAccountDisplayName(
  services: IdentityServices,
  params: Readonly<{
    accountId: string;
    displayName: string;
    displayNameKey: string;
    operationKey: string;
  }>,
) {
  const reservation = await services.db.query<{ display_name_key: string }>(
    `INSERT INTO identity_account_display_name_reservations (
       display_name_key,
       account_id,
       display_name,
       operation_key,
       created_at
     )
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (display_name_key) DO UPDATE
        SET account_id = EXCLUDED.account_id,
            display_name = EXCLUDED.display_name
      WHERE identity_account_display_name_reservations.operation_key = EXCLUDED.operation_key
     RETURNING display_name_key`,
    [params.displayNameKey, params.accountId, params.displayName, params.operationKey],
  );
  if (reservation.rows.length === 0) {
    throw new IdentityDisplayNameConflictError();
  }
}

/**
 * Give back the reservation this convergence took, once the Account append is
 * known to have committed nothing.
 *
 * Definitiveness is decided from committed Account state, never from the shape
 * of the error: an append that actually landed and then failed to report must
 * keep the reservation that names it, or the converged Account loses its
 * display name to the next comer.
 *
 * Best effort by construction, and it matches on all three of
 * `display_name_key`, `operation_key`, and `account_id`, so it can only ever
 * delete the row this operation wrote. If it fails, the row stays bound to
 * this operation and an identical retry still reclaims it.
 */
async function releaseGuestAccountDisplayNameReservation(
  services: IdentityServices,
  params: Readonly<{
    accountId: string;
    displayName: string;
    displayNameKey: string;
    operationKey: string;
  }>,
) {
  try {
    const state = await services.accounts.getAccountState(params.accountId);
    if (state?.displayName === params.displayName) {
      return;
    }

    await services.db.query(
      `DELETE FROM identity_account_display_name_reservations
        WHERE display_name_key = $1
          AND operation_key = $2
          AND account_id = $3`,
      [params.displayNameKey, params.operationKey, params.accountId],
    );
  } catch {
    // Cleanup is an optimization, never a gate, and it must never replace the
    // failure the caller is already reporting.
  }
}

/**
 * Converge one unclaimed guest Account display name from the placeholder to
 * the name its Guest Contact bound.
 *
 * Auth calls this from every success branch of `POST /guest-checkout/contact`,
 * including the two that write nothing, so it has to be always-required
 * reconciliation rather than a first-attempt-only side effect.
 *
 * The order is load-bearing. Every refusal is decided from committed Account
 * aggregate state first, so a refused convergence writes no reservation row at
 * all; only then is the name claimed; only then is the event appended, under
 * the `expectedVersion` the command handler takes from that same guard read,
 * so a stream that advanced in between loses rather than clobbers. Nothing
 * here reads `identity_accounts` or `identity_memberships`: a projection can
 * lag its stream, and renaming on a lagging read is the defect class this
 * repository has already paid for once.
 *
 * Claim state is guarded structurally rather than by a membership read --
 * every claim path revokes the guest token, so Auth cannot reach this after a
 * claim. The residual claim-in-flight window renames only the guest's own
 * Account to its own bound contact name, which is the Account the claim itself
 * settles on.
 */
async function convergeGuestAccountDisplayNameForAuth(
  services: IdentityServices,
  params: Readonly<{
    accountId: string;
    displayName: string;
    context: EventStoreContext;
  }>,
) {
  const displayName = normalizeLabel(params.displayName);
  if (!displayName) {
    throw new IdentityGuestDisplayNameConvergenceRefusedError("display_name_required");
  }

  const state = await services.accounts.getAccountState(params.accountId);
  if (!state) {
    throw new IdentityGuestDisplayNameConvergenceRefusedError("account_not_found");
  }
  if (state.status === "closed") {
    throw new IdentityGuestDisplayNameConvergenceRefusedError("account_closed");
  }
  if (state.displayName !== displayName && state.displayName !== GUEST_ACCOUNT_PLACEHOLDER_DISPLAY_NAME) {
    throw new IdentityGuestDisplayNameConvergenceRefusedError("display_name_not_placeholder");
  }

  const displayNameKey = normalizeAccountDisplayNameKey(displayName);
  const reservation = {
    accountId: params.accountId,
    displayName,
    displayNameKey,
    operationKey: deriveGuestAccountDisplayNameConvergenceOperationKey({
      accountId: params.accountId,
      displayNameKey,
    }),
  };

  await reserveGuestAccountDisplayName(services, reservation);

  let result: Awaited<ReturnType<IdentityServices["accounts"]["commandHandler"]>>;
  try {
    result = await services.accounts.commandHandler({
      streamId: `identity.account-${params.accountId}`,
      command: {
        type: "ConvergeGuestAccountDisplayName",
        displayName,
      },
      context: params.context,
    });
  } catch (error) {
    await releaseGuestAccountDisplayNameReservation(services, reservation);
    throw error;
  }

  return {
    accountId: params.accountId,
    displayName: result.state.displayName,
    // False on an identical replay: the decider yielded no event, so the
    // handler short-circuited with the loaded state and version.
    converged: result.storedEvents.length > 0,
    snapshots: [mutationSnapshot("account", params.accountId, result)],
  };
}

async function createUserForAuth(
  services: IdentityServices,
  params: Readonly<{
    email: string;
    displayName: string;
    context: EventStoreContext;
  }>,
) {
  const userId = createId("usr") as UserId;
  const displayName = params.displayName.trim() || params.email.trim();

  const result = await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "CreateUser",
      userId,
      displayName,
      primaryEmail: params.email,
    },
    context: params.context,
  });

  return { userId, snapshots: [mutationSnapshot("user", userId, result)] };
}

async function grantGuestAccountForAuth(
  services: IdentityServices,
  params: Readonly<{
    accountId: string;
    userId: string;
    roleKey: GrantableRoleKey;
    context: EventStoreContext;
  }>,
) {
  const membershipId = createId("mbr") as MembershipId;
  const result = await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId: params.userId as UserId,
      accountId: params.accountId as AccountId,
      roleKey: params.roleKey,
      assignmentAuthority: { type: "system" },
    },
    context: params.context,
  });

  if (services.eventStore) {
    await publishIdentityCsatOutcomeFact(services.eventStore, params.context, {
      outcomeCode: "onboarding.completed",
      subjectAccountId: params.accountId,
      subjectKind: "account",
      subject: { entityType: "account", entityId: params.accountId },
      idempotencyKey: `identity:onboarding:guest-account:${params.accountId}:${params.userId}`,
    });
  }

  return { membershipId, snapshots: [mutationSnapshot("membership", membershipId, result)] };
}

async function enablePasswordCredentialForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    credentialId: string;
    context: EventStoreContext;
  }>,
) {
  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "password" },
    context: params.context,
  });
  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: params.credentialId,
    },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function registerPasskeyCredentialForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    credentialId: string;
    context: EventStoreContext;
  }>,
) {
  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "passkey" },
    context: params.context,
  });
  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "RegisterPasskeyCredential",
      credentialId: params.credentialId,
    },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function enableSmsCodeForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    context: EventStoreContext;
  }>,
) {
  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "sms-code" },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

class SocialLoginLinkConflictError extends Error {
  constructor() {
    super("Social login is already linked to another user.");
  }
}

function roleKeyValidationError() {
  return {
    error: {
      code: "validation_failed",
      message: `Role key is invalid. Valid role keys: ${formatGrantableRoleKeys()}.`,
    },
  };
}

async function linkSocialLoginForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    providerName: "google" | "facebook";
    providerSubject: string;
    email: string;
    context: EventStoreContext;
  }>,
) {
  const existingLink = await services.users.getUserBySocialLogin({
    providerName: params.providerName,
    providerSubject: params.providerSubject,
  });

  if (existingLink && existingLink.user_id !== params.userId) {
    throw new SocialLoginLinkConflictError();
  }

  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "social-login" },
    context: params.context,
  });

  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "LinkSocialLogin",
      providerName: params.providerName,
      providerSubject: params.providerSubject,
      email: params.email,
      linkedAt: new Date().toISOString(),
    },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function verifyEmailContactMethodForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    email: string;
    context: EventStoreContext;
  }>,
) {
  const user = await services.users.getUserState(params.userId);
  const email = normalizeEmail(params.email);
  const contactMethod = user?.contactMethods.find((method) => method.type === "email" && method.value === email);
  if (!contactMethod) {
    return { userId: params.userId, snapshots: [] };
  }
  if (contactMethod.verifiedAt) {
    return { userId: params.userId, snapshots: [] };
  }

  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "VerifyContactMethod",
      contactMethodId: contactMethod.contactMethodId,
      verifiedAt: new Date().toISOString(),
    },
    context: params.context,
  });

  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function acceptInvitationForUserFromAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    userId: string;
    acceptanceTokenHash: string;
    context: EventStoreContext;
  }>,
) {
  const invitation = await services.invitations.getInvitationState(params.invitationId);
  const acceptedAt = new Date().toISOString();
  if (!invitation?.id || !invitation.accountId || !invitation.roleKey || !invitation.email) {
    throw new IdentityDomainError("Invitation is unavailable.");
  }
  validateInvitationAcceptanceToken(invitation, params.acceptanceTokenHash, acceptedAt);
  const roleKey = parseGrantableRoleKey(invitation.roleKey);
  if (!roleKey) {
    throw new IdentityDomainError("Platform-admin can only be assigned by platform bootstrap.");
  }

  const invitationResult = await services.invitations.commandHandler({
    streamId: `identity.invitation-${params.invitationId}`,
    command: {
      type: "AcceptInvitation",
      userId: params.userId as UserId,
      acceptanceTokenHash: params.acceptanceTokenHash,
      acceptedAt,
    },
    context: params.context,
  });
  const membershipId = createId("mbr") as MembershipId;
  const membershipResult = await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId: params.userId as UserId,
      accountId: invitation.accountId,
      roleKey,
      assignmentAuthority: { type: "system" },
    },
    context: params.context,
  });
  if (services.eventStore) {
    await publishIdentityCsatOutcomeFact(services.eventStore, params.context, {
      outcomeCode: "onboarding.completed",
      subjectAccountId: invitation.accountId,
      subjectKind: "account",
      subject: { entityType: "invitation", entityId: params.invitationId },
      idempotencyKey: `identity:onboarding:invitation:${params.invitationId}:${params.userId}`,
    });
  }
  return {
    membershipId,
    snapshots: [
      mutationSnapshot("invitation", params.invitationId, invitationResult),
      mutationSnapshot("membership", membershipId, membershipResult),
    ],
  };
}

async function requirePendingInvitationForAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
  }>,
) {
  const invitation = await services.invitations.getInvitationState(params.invitationId);
  if (
    !invitation?.id ||
    !invitation.accountId ||
    !invitation.email ||
    !invitation.roleKey ||
    !invitation.expiresAt ||
    invitation.status !== "pending"
  ) {
    throw new IdentityDomainError("Invitation is unavailable.");
  }

  if (Date.parse(invitation.expiresAt) <= Date.now()) {
    throw new IdentityDomainError("Invitation is unavailable.");
  }

  return invitation;
}

async function issueInvitationAcceptanceTokenForAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    tokenHash: string;
    expiresAt: string;
    context: EventStoreContext;
  }>,
) {
  const invitation = await requirePendingInvitationForAuth(services, params);
  const result = await services.invitations.commandHandler({
    streamId: `identity.invitation-${params.invitationId}`,
    command: {
      type: "IssueInvitationAcceptanceToken",
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
    },
    context: params.context,
  });

  return {
    invitationId: params.invitationId,
    accountId: invitation.accountId,
    email: invitation.email,
    roleKey: invitation.roleKey,
    expiresAt: params.expiresAt,
    snapshots: [mutationSnapshot("invitation", params.invitationId, result)],
  };
}

async function verifyInvitationAcceptanceTokenForAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    acceptanceTokenHash: string;
  }>,
) {
  const invitation = await requirePendingInvitationForAuth(services, params);
  validateInvitationAcceptanceToken(invitation, params.acceptanceTokenHash, new Date().toISOString());

  return {
    invitationId: params.invitationId,
    accountId: invitation.accountId,
    email: invitation.email,
    roleKey: invitation.roleKey,
    expiresAt: invitation.expiresAt,
  };
}

function requirePermission(readPermission: PermissionKey, writePermission = readPermission) {
  return async (c: Context<IdentityApiEnv>, next: () => Promise<void>) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required.",
          },
        },
        401,
      );
    }

    const requiredPermission = c.req.method === "GET" || c.req.method === "HEAD" ? readPermission : writePermission;

    if (!hasPermission(actor, requiredPermission)) {
      return c.json(
        {
          error: {
            code: "authorization_forbidden",
            message: "Forbidden.",
          },
        },
        403,
      );
    }

    await next();
  };
}

async function getCurrentActorMembershipDisplay(services: IdentityServices, actor: ResolvedActor) {
  const projected = await services.memberships.getActiveMembershipForUserAccount(actor.userId, actor.accountId);
  if (projected) {
    return projected;
  }

  const state = await services.memberships.getMembershipState(actor.membershipId);
  if (
    state?.status !== "active" ||
    state.userId !== actor.userId ||
    state.accountId !== actor.accountId ||
    !state.id ||
    !state.roleKey
  ) {
    return null;
  }

  return {
    membership_id: state.id,
    role_key: state.roleKey,
  };
}

export function buildIdentityApi(services: IdentityServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/internal/auth/guest-accounts", async (c) => {
    const body = await c.req.json();
    const account = await createGuestAccountForAuth(services, {
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      context: getBootstrapContext(c),
    });

    return c.json(account, 201);
  });

  app.post("/internal/auth/users", async (c) => {
    const body = await c.req.json();
    const user = await createUserForAuth(services, {
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      context: getBootstrapContext(c),
    });

    return c.json(user, 201);
  });

  // The account id is a path parameter because this route has no independent
  // actor identity -- `/api/identity/internal/auth/` runs with `actor` set to
  // null -- so it trusts the account it is called with, exactly as the sibling
  // claim route does. That a token issued for one Account can never direct
  // this at another is proven in Auth, where the actor identity actually
  // exists and is already cross-checked against the guest token row.
  app.post("/internal/auth/guest-accounts/:id/display-name", async (c) => {
    const body = await c.req.json();
    try {
      const convergence = await convergeGuestAccountDisplayNameForAuth(services, {
        accountId: c.req.param("id"),
        displayName: String(body.displayName ?? ""),
        context: getBootstrapContext(c),
      });

      return c.json(convergence);
    } catch (error) {
      // Both refusals are 409 rather than 5xx on purpose: they are settled
      // rulings about this Account and this name, and retrying either would
      // only ask the same question again.
      if (error instanceof IdentityGuestDisplayNameConvergenceRefusedError) {
        return c.json(
          {
            error: {
              code: "guest_display_name_convergence_refused",
              reason: error.reason,
              message: t("identity.api.guest.display.name.convergence.refused"),
            },
          },
          409,
        );
      }

      if (error instanceof IdentityDisplayNameConflictError) {
        return c.json(
          {
            error: {
              code: "display_name_already_taken",
              message: t("identity.api.display.name.already.taken"),
            },
          },
          409,
        );
      }

      throw error;
    }
  });

  app.post("/internal/auth/guest-accounts/:id/claim", async (c) => {
    const body = await c.req.json();
    const roleKey = parseGrantableRoleKey(body.roleKey ?? "owner");
    if (!roleKey) {
      return c.json(roleKeyValidationError(), 400);
    }
    const membership = await grantGuestAccountForAuth(services, {
      accountId: c.req.param("id"),
      userId: String(body.userId ?? ""),
      roleKey,
      context: getBootstrapContext(c),
    });

    return c.json(membership, 201);
  });

  // The mint. Anonymous by design: knowing what must be agreed to in order to
  // register is public information, and the value's authority comes from the
  // signature, not from who asked for it.
  app.get("/internal/auth/registration-consent", (c) =>
    c.json(
      mintRegistrationConsentResolution({
        requirements: resolveRegistrationConsentRequirements(),
        resolvedAt: new Date().toISOString(),
        signingKeys: resolveRegistrationConsentSigningKeys(),
      }),
    ),
  );

  app.post("/internal/auth/personal-identities", async (c) => {
    const body = await c.req.json();
    let identity: Awaited<ReturnType<typeof createPersonalIdentityForAuth>>;
    try {
      identity = await createPersonalIdentityForAuth(services, {
        email: typeof body.email === "string" && body.email.trim() ? body.email : null,
        phone: typeof body.phone === "string" && body.phone.trim() ? body.phone : null,
        displayName: String(body.displayName ?? ""),
        givenName: typeof body.givenName === "string" ? body.givenName : undefined,
        familyName: typeof body.familyName === "string" ? body.familyName : undefined,
        registrationConsent: body.registrationConsent,
        foundersBetaAccessStartedAt:
          typeof body.foundersBetaAccessStartedAt === "string" ? body.foundersBetaAccessStartedAt : undefined,
        context: getBootstrapContext(c),
      });
    } catch (error) {
      if (error instanceof RegistrationConsentRejectedError) {
        return c.json(
          {
            error: {
              code: error.rejection.code,
              reason: error.rejection.reason,
              message: error.rejection.message,
            },
          },
          400,
        );
      }

      if (error instanceof RegistrationOperationContactRequiredError) {
        return c.json(
          {
            error: {
              code: "registration_operation_contact_required",
              message: error.message,
            },
          },
          400,
        );
      }

      // A distinct classification, not a generic conflict: this registration
      // appended nothing because the operation was already claimed against a
      // different ordered consent bundle.
      if (error instanceof RegistrationOperationConsentDisagreementError) {
        return c.json(
          {
            error: {
              code: "registration_operation_consent_disagreement",
              message: error.message,
            },
          },
          409,
        );
      }

      if (error instanceof RegistrationOperationParticipantDisagreementError) {
        return c.json(
          {
            error: {
              code: "registration_operation_participant_disagreement",
              message: error.message,
            },
          },
          409,
        );
      }

      if (error instanceof IdentityDisplayNameConflictError) {
        return c.json(
          {
            error: {
              code: "display_name_already_taken",
              message: t("identity.api.display.name.already.taken"),
            },
          },
          409,
        );
      }

      throw error;
    }

    return c.json(identity, 201);
  });

  app.post("/internal/auth/users/:id/sms-code", async (c) => {
    const credential = await enableSmsCodeForAuth(services, {
      userId: c.req.param("id"),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...credential });
  });

  app.post("/internal/auth/users/:id/password-credential", async (c) => {
    const body = await c.req.json();
    const credential = await enablePasswordCredentialForAuth(services, {
      userId: c.req.param("id"),
      credentialId: String(body.credentialId ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...credential });
  });

  app.post("/internal/auth/users/:id/passkey-credential", async (c) => {
    const body = await c.req.json();
    const credential = await registerPasskeyCredentialForAuth(services, {
      userId: c.req.param("id"),
      credentialId: String(body.credentialId ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...credential });
  });

  app.post("/internal/auth/users/:id/social-login-link", async (c) => {
    const body = await c.req.json();
    const providerName = String(body.providerName ?? "");
    if (providerName !== "google" && providerName !== "facebook") {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: "Social login provider is unsupported.",
          },
        },
        400,
      );
    }

    try {
      const link = await linkSocialLoginForAuth(services, {
        userId: c.req.param("id"),
        providerName,
        providerSubject: String(body.providerSubject ?? ""),
        email: String(body.email ?? ""),
        context: getBootstrapContext(c),
      });
      return c.json({ ok: true, ...link });
    } catch (error) {
      if (error instanceof SocialLoginLinkConflictError) {
        return c.json(
          {
            error: {
              code: "social_login_already_linked",
              message: "Social login is already linked to another user.",
            },
          },
          409,
        );
      }

      throw error;
    }
  });

  app.post("/internal/auth/users/:id/email-verification", async (c) => {
    const body = await c.req.json();
    const verification = await verifyEmailContactMethodForAuth(services, {
      userId: c.req.param("id"),
      email: String(body.email ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...verification });
  });

  app.post("/internal/auth/invitations/:id/accept", async (c) => {
    const body = await c.req.json();
    try {
      const membership = await acceptInvitationForUserFromAuth(services, {
        invitationId: c.req.param("id"),
        userId: String(body.userId ?? ""),
        acceptanceTokenHash: String(body.acceptanceTokenHash ?? ""),
        context: getBootstrapContext(c),
      });
      return c.json(membership);
    } catch (error) {
      if (error instanceof IdentityDomainError && error.message === "Invitation is unavailable.") {
        return c.json({ error: { code: "not_found", message: "Invitation is unavailable." } }, 404);
      }
      if (error instanceof IdentityDomainError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }

      throw error;
    }
  });

  app.post("/internal/auth/invitations/:id/acceptance-token", async (c) => {
    const body = await c.req.json();
    try {
      const token = await issueInvitationAcceptanceTokenForAuth(services, {
        invitationId: c.req.param("id"),
        tokenHash: String(body.tokenHash ?? ""),
        expiresAt: String(body.expiresAt ?? ""),
        context: getBootstrapContext(c),
      });
      return c.json(token);
    } catch (error) {
      if (error instanceof IdentityDomainError && error.message === "Invitation is unavailable.") {
        return c.json({ error: { code: "not_found", message: "Invitation is unavailable." } }, 404);
      }
      if (error instanceof IdentityDomainError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }

      throw error;
    }
  });

  app.post("/internal/auth/invitations/:id/verify-acceptance-token", async (c) => {
    const body = await c.req.json();
    try {
      return c.json(
        await verifyInvitationAcceptanceTokenForAuth(services, {
          invitationId: c.req.param("id"),
          acceptanceTokenHash: String(body.acceptanceTokenHash ?? ""),
        }),
      );
    } catch (error) {
      if (error instanceof IdentityDomainError && error.message === "Invitation is unavailable.") {
        return c.json({ error: { code: "not_found", message: "Invitation is unavailable." } }, 404);
      }
      if (error instanceof IdentityDomainError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }

      throw error;
    }
  });

  app.get("/current-actor-display", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required.",
          },
        },
        401,
      );
    }

    const [account, membership, projectedUser, userState] = await Promise.all([
      services.accounts.getAccountForRead(actor.accountId),
      getCurrentActorMembershipDisplay(services, actor),
      services.users.getUser(actor.userId),
      services.users.getUserState(actor.userId),
    ]);
    const user = userState
      ? {
          user_id: actor.userId,
          display_name: userState.displayName || projectedUser?.display_name || null,
          primary_email: userState.primaryEmail ?? projectedUser?.primary_email ?? null,
        }
      : projectedUser;

    return c.json(
      buildCurrentActorDisplay(actor, {
        account,
        membership,
        user,
      }),
    );
  });

  app.use("/accounts", requirePermission("accounts.view", "accounts.manage"));
  app.use("/accounts/*", requirePermission("accounts.view", "accounts.manage"));
  app.use("/users", requirePermission("security.manage"));
  app.use("/users/*", requirePermission("security.manage"));
  app.use("/memberships", requirePermission("memberships.view", "memberships.manage"));
  app.use("/memberships/*", requirePermission("memberships.view", "memberships.manage"));
  app.use("/invitations", requirePermission("memberships.manage"));
  app.use("/invitations/*", requirePermission("memberships.manage"));
  app.use("/api-keys", requirePermission("security.manage"));
  app.use("/api-keys/*", requirePermission("security.manage"));
  app.use("/access-hub", requirePermission("accounts.view"));
  app.use("/access-hub/*", requirePermission("accounts.view"));

  app.route("/access-hub", accessHubRoutes(services.accessHub));
  app.route("/accounts", accountRoutes(services.accounts));
  app.route("/accounts/:accountId/shipping-addresses", shippingAddressRoutes(services.shippingAddresses));
  app.route("/users", userRoutes(services.users));
  app.route("/memberships", membershipRoutes(services.memberships, services.accounts));
  app.route("/invitations", invitationRoutes(services.invitations, services.accounts));
  app.route(
    "/api-keys",
    apiKeyRoutes({ ...services.apiKeys, db: services.db, auth: services.auth, getUser: services.users.getUser }),
  );
  app.route("/consents", consentRoutes(services.consents));
  app.route(
    "/consents/terms-of-service",
    termsOfServiceConsentRoutes({
      db: services.db,
      policies: services.policies,
      consents: services.consents,
    }),
  );
  app.route("/preferences", userPreferencesRoutes(services.preferences));

  app.post("/api-keys/resolve", async (c) => {
    const body = await c.req.json();
    const secret = String(body.secret ?? "");
    const keyPrefix = secret.slice(0, 12);
    const apiKeySecret = await getApiKeySecretByPrefix(services.db, keyPrefix);
    if (!apiKeySecret || !services.auth.verifySecret(secret, apiKeySecret.secret_hash)) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Invalid API key.",
          },
        },
        401,
      );
    }
    let result: Awaited<ReturnType<IdentityServices["apiKeys"]["commandHandler"]>>;
    try {
      result = await services.apiKeys.commandHandler({
        streamId: `identity.api-key-${apiKeySecret.api_key_id}`,
        command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
        context: getBootstrapContext(c),
      });
    } catch (error) {
      if (error instanceof IdentityDomainError) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: "Invalid API key.",
            },
          },
          401,
        );
      }
      throw error;
    }
    return c.json({
      apiKeyId: apiKeySecret.api_key_id,
      userId: apiKeySecret.user_id as UserId,
      keyPrefix,
      version: result.version,
      status: result.state.status,
    });
  });

  return app;
}

export function buildIdentityPublicApi(services: IdentityServices) {
  const app = new Hono<IdentityApiEnv>();
  app.get("/founders-cohort", async (c) => c.json(await services.foundersCohort.getCount()));
  return app;
}
