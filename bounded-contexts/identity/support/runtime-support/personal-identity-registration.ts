import { createHash } from "node:crypto";
import type { DomainEvent } from "@chase-sets/event-core/domain";
import type { EventRecordToStore, EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, ConsentId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import { decideAccount, evolveAccount, initialAccountState } from "../../features/accounts/domain/domain";
import {
  registrationConsentSnapshotsMatch,
  resolveGuardedRegistrationConsentSnapshot,
  type ConsentPublicationRegistry,
  type RegistrationConsentSubmission,
} from "../../features/consents/domain/consent-activation";
import { consentBundles } from "../../features/consents/domain/consent-bundle";
import { decideConsent, initialConsentState } from "../../features/consents/domain/domain";
import { decideMembership, initialMembershipState } from "../../features/memberships/domain/domain";
import { decideUser, evolveUser, initialUserState } from "../../features/users/domain/domain";
import { publishIdentityCsatOutcomeFact } from "../request-support/csat-outcome-facts";
import { IdentityDomainError } from "./common";
import type { IdentityServices } from "./services";

export type IdentityMutationSnapshot = Readonly<{
  aggregate: "account" | "api-key" | "consent" | "invitation" | "membership" | "user";
  id: string;
  version: number;
  status: string;
}>;

export type PersonalIdentityRegistrationResult = Readonly<{
  userId: UserId;
  accountId: AccountId;
  membershipId: MembershipId;
  snapshots: readonly IdentityMutationSnapshot[];
}>;

type CompletedRegistrationPayload = Readonly<{
  operationId: string;
  requestFingerprint: string;
  result: PersonalIdentityRegistrationResult;
}>;

export class IdentityDisplayNameConflictError extends Error {
  constructor() {
    super("Display name is already taken.");
    this.name = "IdentityDisplayNameConflictError";
  }
}

export function normalizeAccountDisplayNameKey(displayName: string) {
  return displayName.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function registrationOperationStreamId(operationId: string) {
  return `identity.personal-identity-operation-${sha256(operationId)}`;
}

function displayNameReservationStreamId(displayNameKey: string) {
  return `identity.account-display-name-${sha256(displayNameKey)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeDomainEvents(events: readonly DomainEvent[]): readonly EventRecordToStore[] {
  return events.map((event) => ({
    eventType: event.type,
    payload: event.data,
  }));
}

function requestFingerprint(
  input: Readonly<{
    email: string;
    phone: string;
    displayName: string;
    givenName?: string;
    familyName?: string;
    registrationConsent: RegistrationConsentSubmission;
  }>,
) {
  return sha256(
    JSON.stringify({
      email: input.email,
      phone: input.phone,
      displayName: input.displayName,
      givenName: input.givenName ?? "",
      familyName: input.familyName ?? "",
      registrationConsent: input.registrationConsent,
    }),
  );
}

function readCompletedRegistration(
  events: readonly Readonly<{ eventType: string; payload: unknown }>[],
): CompletedRegistrationPayload | null {
  const completed = events.find((event) => event.eventType === "identity.personal-identity.provisioned");
  if (!completed || !completed.payload || typeof completed.payload !== "object") {
    return null;
  }
  return completed.payload as CompletedRegistrationPayload;
}

function requireMatchingCompletion(completed: CompletedRegistrationPayload, operationId: string, fingerprint: string) {
  if (completed.operationId !== operationId || completed.requestFingerprint !== fingerprint) {
    throw new IdentityDomainError("Registration operation identity was already used for different input.");
  }
  return completed.result;
}

function isConcurrencyConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict");
}

export async function createPersonalIdentityForAuth(
  services: IdentityServices,
  params: Readonly<{
    email?: string | null;
    phone?: string | null;
    displayName: string;
    givenName?: string;
    familyName?: string;
    registrationConsent: RegistrationConsentSubmission;
    foundersBetaAccessStartedAt?: string;
    context: EventStoreContext;
  }>,
  consentPublications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
): Promise<PersonalIdentityRegistrationResult> {
  const eventStore = services.eventStore;
  if (!eventStore?.appendToStreams) {
    throw new Error("Atomic personal identity registration requires multi-stream event storage.");
  }

  const operationId = params.registrationConsent.operationId.trim();
  if (!operationId || operationId.length > 200) {
    throw new IdentityDomainError("Registration operation identity is invalid.");
  }

  const email = params.email?.trim() ?? "";
  const phone = params.phone?.trim() ?? "";
  const displayName = params.displayName.trim() || email || phone;
  const fingerprint = requestFingerprint({
    email,
    phone,
    displayName,
    givenName: params.givenName,
    familyName: params.familyName,
    registrationConsent: params.registrationConsent,
  });
  const operationStreamId = registrationOperationStreamId(operationId);
  const priorCompletion = readCompletedRegistration(await eventStore.readStream({ streamId: operationStreamId }));
  if (priorCompletion) {
    return requireMatchingCompletion(priorCompletion, operationId, fingerprint);
  }

  const guardedConsent = await resolveGuardedRegistrationConsentSnapshot(
    services.policies,
    eventStore,
    consentPublications,
  );
  if (!registrationConsentSnapshotsMatch(params.registrationConsent.snapshot, guardedConsent.snapshot)) {
    throw new IdentityDomainError("Registration consent bundle is stale.");
  }
  if (guardedConsent.snapshot.requirements.length > 0 && params.registrationConsent.affirmed !== true) {
    throw new IdentityDomainError("Registration requires affirmation of the active consent bundle.");
  }

  const displayNameKey = normalizeAccountDisplayNameKey(displayName);
  if (displayNameKey) {
    const existingAccount = await services.db.query<{ account_id: string }>(
      `SELECT account_id
       FROM identity_accounts
       WHERE lower(regexp_replace(btrim(display_name), '[[:space:]]+', ' ', 'g')) = $1
       LIMIT 1`,
      [displayNameKey],
    );
    if (existingAccount.rows.length > 0) {
      throw new IdentityDisplayNameConflictError();
    }
  }

  const userId = createId("usr") as UserId;
  const accountId = createId("acc") as AccountId;
  const membershipId = createId("mbr") as MembershipId;
  const recordedAt = new Date().toISOString();
  const primaryContactMethod = phone
    ? {
        contactMethodId: createId("ctm"),
        type: "phone" as const,
        value: phone,
        verifiedAt: recordedAt,
      }
    : undefined;

  let accountState = initialAccountState;
  const accountEvents = [
    ...decideAccount(accountState, {
      type: "CreateAccount",
      accountId,
      name: "",
      accountType: "personal",
      displayName,
    }),
  ];
  accountState = accountEvents.reduce(evolveAccount, accountState);
  if (params.foundersBetaAccessStartedAt) {
    const betaAccessStartedAt = new Date(params.foundersBetaAccessStartedAt);
    const foundersWindowEndsAt = new Date(betaAccessStartedAt);
    foundersWindowEndsAt.setUTCDate(foundersWindowEndsAt.getUTCDate() + 60);
    const foundersEvents = decideAccount(accountState, {
      type: "OpenFoundersWindow",
      betaAccessStartedAt: betaAccessStartedAt.toISOString(),
      foundersWindowEndsAt: foundersWindowEndsAt.toISOString(),
      recipientEmail: email,
    });
    accountEvents.push(...foundersEvents);
  }

  let userState = initialUserState;
  const userEvents = [
    ...decideUser(userState, {
      type: "CreateUser",
      userId,
      displayName,
      givenName: params.givenName,
      familyName: params.familyName,
      primaryEmail: email || null,
      ...(primaryContactMethod ? { primaryContactMethod } : {}),
    }),
  ];
  userState = userEvents.reduce(evolveUser, userState);
  if (phone) {
    userEvents.push(...decideUser(userState, { type: "EnableAuthMethod", authMethod: "sms-code" }));
  }

  const membershipEvents = decideMembership(initialMembershipState, {
    type: "GrantMembership",
    membershipId,
    userId,
    accountId,
    roleKey: "owner",
    assignmentAuthority: { type: "system" },
  });
  const consentPlans = guardedConsent.snapshot.requirements.map((requirement) => {
    const consentId = createId("cns") as ConsentId;
    return {
      consentId,
      events: decideConsent(initialConsentState, {
        type: "RecordConsent",
        consentId,
        subjectType: consentBundles.registration.subjectType,
        userId,
        accountId,
        policyKey: requirement.policyKey,
        policyVersion: requirement.version,
        recordedAt,
      }),
    };
  });
  const snapshots: IdentityMutationSnapshot[] = [
    { aggregate: "account", id: accountId, version: accountEvents.length, status: "active" },
    { aggregate: "membership", id: membershipId, version: membershipEvents.length, status: "active" },
    ...consentPlans.map(
      ({ consentId, events }): IdentityMutationSnapshot => ({
        aggregate: "consent",
        id: consentId,
        version: events.length,
        status: "recorded",
      }),
    ),
    { aggregate: "user", id: userId, version: userEvents.length, status: "active" },
  ];
  const result: PersonalIdentityRegistrationResult = { userId, accountId, membershipId, snapshots };

  const finalConsent = await resolveGuardedRegistrationConsentSnapshot(
    services.policies,
    eventStore,
    consentPublications,
  );
  if (!registrationConsentSnapshotsMatch(params.registrationConsent.snapshot, finalConsent.snapshot)) {
    throw new IdentityDomainError("Registration consent bundle is stale.");
  }

  try {
    await eventStore.appendToStreams([
      ...finalConsent.policyStreamGuards.map((guard) => ({
        streamId: guard.streamId,
        expectedVersion: guard.version,
        events: [],
        context: params.context,
      })),
      {
        streamId: operationStreamId,
        expectedVersion: "no_stream",
        events: [
          {
            eventType: "identity.personal-identity.provisioned",
            payload: {
              operationId,
              requestFingerprint: fingerprint,
              result,
            },
          },
        ],
        context: params.context,
      },
      ...(displayNameKey
        ? [
            {
              streamId: displayNameReservationStreamId(displayNameKey),
              expectedVersion: "no_stream" as const,
              events: [
                {
                  eventType: "identity.account-display-name.reserved",
                  payload: { displayNameKey, accountId, displayName },
                },
              ],
              context: params.context,
            },
          ]
        : []),
      {
        streamId: `identity.account-${accountId}`,
        expectedVersion: "no_stream",
        events: encodeDomainEvents(accountEvents),
        context: params.context,
      },
      {
        streamId: `identity.user-${userId}`,
        expectedVersion: "no_stream",
        events: encodeDomainEvents(userEvents),
        context: params.context,
      },
      {
        streamId: `identity.membership-${membershipId}`,
        expectedVersion: "no_stream",
        events: encodeDomainEvents(membershipEvents),
        context: params.context,
      },
      ...consentPlans.map(({ consentId, events }) => ({
        streamId: `identity.consent-${consentId}`,
        expectedVersion: "no_stream" as const,
        events: encodeDomainEvents(events),
        context: params.context,
      })),
    ]);
  } catch (error) {
    if (!isConcurrencyConflict(error)) {
      throw error;
    }

    const completion = readCompletedRegistration(await eventStore.readStream({ streamId: operationStreamId }));
    if (completion) {
      return requireMatchingCompletion(completion, operationId, fingerprint);
    }

    const currentConsent = await resolveGuardedRegistrationConsentSnapshot(
      services.policies,
      eventStore,
      consentPublications,
    );
    if (!registrationConsentSnapshotsMatch(params.registrationConsent.snapshot, currentConsent.snapshot)) {
      throw new IdentityDomainError("Registration consent bundle is stale.");
    }
    if (
      displayNameKey &&
      (await eventStore.readStream({ streamId: displayNameReservationStreamId(displayNameKey) })).length > 0
    ) {
      throw new IdentityDisplayNameConflictError();
    }
    throw error;
  }

  await publishIdentityCsatOutcomeFact(eventStore, params.context, {
    outcomeCode: "registration.completed",
    subjectAccountId: accountId,
    subjectKind: "account",
    subject: { entityType: "account", entityId: accountId },
    idempotencyKey: `identity:registration:${accountId}`,
  });

  return result;
}
