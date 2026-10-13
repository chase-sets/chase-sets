import { createHash } from "node:crypto";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import type { IdentityAuthMutationClient } from "@chase-sets/identity/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  consumeChallenge,
  getPasswordCredentialByUserId,
  upsertPasswordCredential,
  upsertPasskeyCredential,
} from "../../../support/auth-support/store";
import { verifyPasskeyRegistration } from "../../../support/auth-support/webauthn";
import { AUTH_ROLE_PERMISSIONS } from "../../../support/auth-support/constants";
import { startInteractiveAuth, type AuthServices } from "../../../support/runtime-support/services";
import { resolveUnaffirmedRegistrationConsent, createOwnedUserDisplayName } from "../../../support/api-support/support";
import { ATTEMPT_STAGES, InvitationAttemptError, type AttemptState } from "../domain/attempt";
import { beginAttempt, checkpoint, readAttempt, withInvitationAttemptLock } from "./attempt-store";
import { readInvitationAttemptId } from "./attempt-request";
import { invitationAttemptRollout } from "./rollout";

import type { InvitationAttemptResult } from "./result";
type JourneyInput = Readonly<{
  attemptId: string;
  invitationId: string;
  token: string;
  password?: string;
  challengeId?: string;
  challenge?: string;
  webauthnResponse?: unknown;
  externalCredentialId?: string;
  label?: string;
}>;

export function parseJourneyInput(value: unknown, key: string | undefined): JourneyInput {
  const attemptId = readInvitationAttemptId(value, key);
  if (!attemptId || !value || typeof value !== "object" || Array.isArray(value))
    throw new InvitationAttemptError("invitation_attempt_invalid");
  const data = value as Record<string, unknown>;
  const allowed = [
    "attemptId",
    "invitationId",
    "token",
    "password",
    "challengeId",
    "challenge",
    "webauthnResponse",
    "externalCredentialId",
    "label",
  ];
  if (
    Object.keys(data).some((field) => !allowed.includes(field)) ||
    typeof data.invitationId !== "string" ||
    !/^ivt_[A-Za-z0-9_-]{1,80}$/.test(data.invitationId) ||
    typeof data.token !== "string" ||
    !data.token ||
    data.token.length > 4096
  )
    throw new InvitationAttemptError("invitation_attempt_invalid");
  for (const field of allowed.filter((field) => field !== "webauthnResponse")) {
    if (data[field] !== undefined && (typeof data[field] !== "string" || data[field].length > 4096))
      throw new InvitationAttemptError("invitation_attempt_invalid");
  }
  if (
    data.webauthnResponse !== undefined &&
    (typeof data.webauthnResponse !== "string" || data.webauthnResponse.length > 16384)
  )
    throw new InvitationAttemptError("invitation_attempt_invalid");
  return data as JourneyInput;
}

function operation(state: AttemptState) {
  const binding = state.binding;
  return {
    version: 1 as const,
    attemptId: binding.attemptId,
    invitationId: binding.invitationId,
    accountId: binding.accountId,
    roleKey: binding.roleKey,
    emailFingerprint: binding.emailFingerprint,
    userId: binding.userId,
    membershipId: binding.membershipId,
    bindingDigest: state.digest,
  };
}

async function storedCredential(services: AuthServices, state: AttemptState) {
  const binding = state.binding;
  if (binding.credentialKind === "password") {
    const row = await getPasswordCredentialByUserId(services.db, binding.userId);
    return row?.credential_id === binding.credentialId ? row : null;
  }
  const result = await services.db.query<{ credential_id: string; user_id: string }>(
    "SELECT credential_id, user_id FROM identity_passkey_credentials WHERE credential_id = $1 AND user_id = $2",
    [binding.credentialId, binding.userId],
  );
  return result.rows[0] ?? null;
}

export async function lookupInvitationAttempt(
  services: AuthServices,
  identity: IdentityAuthMutationClient,
  input: JourneyInput,
  context: EventStoreContext,
): Promise<InvitationAttemptResult> {
  const state = await readAttempt(services.eventStore, input.attemptId, context);
  if (!state || state.binding.invitationId !== input.invitationId)
    return { type: "ambiguous", attemptId: input.attemptId };
  const authority = await identity.readInvitationAcceptanceAuthority({
    invitationId: input.invitationId,
    acceptanceTokenHash: services.auth.hashSecret(input.token),
    operation: operation(state),
  });
  if (
    state.version >= ATTEMPT_STAGES.indexOf("credential-attached") + 2 &&
    (!authority.user?.authMethods.includes(state.binding.credentialKind) ||
      (state.binding.credentialKind === "password"
        ? authority.user.passwordCredentialId !== state.binding.credentialId
        : !authority.user.passkeyCredentialIds.includes(state.binding.credentialId)) ||
      !(await storedCredential(services, state)))
  )
    throw new InvitationAttemptError("invitation_attempt_ambiguous");
  return { type: authority.accepted ? "accepted-reauth-required" : "confirming", attemptId: input.attemptId };
}

export async function acceptInvitationAttempt(
  services: AuthServices,
  identity: IdentityAuthMutationClient,
  input: JourneyInput,
  request: Request,
  context: EventStoreContext,
) {
  return withInvitationAttemptLock(services.pool, context.tenantId, input.invitationId, async () => {
    let state = await readAttempt(services.eventStore, input.attemptId, context);
    if (!state && !invitationAttemptRollout.active) return { type: "attempts-not-active" as const };
    const acceptanceTokenHash = services.auth.hashSecret(input.token);
    let authority = await identity.readInvitationAcceptanceAuthority({
      invitationId: input.invitationId,
      acceptanceTokenHash,
      ...(state ? { operation: operation(state) } : {}),
    });
    const kind = input.challengeId ? "passkey" : "password";
    if (
      state &&
      (state.binding.invitationId !== input.invitationId ||
        state.binding.credentialKind !== kind ||
        state.binding.ceremony.id !== (input.challengeId ?? null) ||
        state.binding.ceremony.externalCredentialId !== (input.externalCredentialId ?? null))
    )
      throw new InvitationAttemptError("invitation_attempt_conflict");
    if (!state) {
      if (kind === "password" && !input.password) throw new InvitationAttemptError("invitation_attempt_invalid");
      const userId = authority.user?.userId ?? createId("usr");
      const credential = kind === "password" ? await getPasswordCredentialByUserId(services.db, userId) : null;
      state = await beginAttempt(
        services.eventStore,
        {
          version: 1,
          intent: "invitation-acceptance",
          attemptId: input.attemptId,
          invitationId: input.invitationId,
          accountId: authority.accountId,
          roleKey: authority.roleKey,
          emailFingerprint: createHash("sha256")
            .update(`invitation-recipient:v1:${services.identity.normalizeEmail(authority.email)}`)
            .digest("hex"),
          userId,
          membershipId: createId("mbr"),
          credentialId: credential?.credential_id ?? createId("crd"),
          sessionId: createId("ses"),
          credentialKind: kind,
          ceremony: { id: input.challengeId ?? null, externalCredentialId: input.externalCredentialId ?? null },
        },
        context,
      );
      await services.db.query(
        "INSERT INTO auth_invitation_acceptance_attempts (attempt_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [input.attemptId],
      );
      authority = await identity.readInvitationAcceptanceAuthority({
        invitationId: input.invitationId,
        acceptanceTokenHash,
        operation: operation(state),
      });
    }
    const binding = state.binding;
    const readOwner = () =>
      identity.readInvitationAcceptanceAuthority({
        invitationId: input.invitationId,
        acceptanceTokenHash,
        operation: operation(state!),
      });
    if (state.stage === "completed") return lookupInvitationAttempt(services, identity, input, context);
    const existingCredential =
      kind === "password" ? await getPasswordCredentialByUserId(services.db, binding.userId) : null;
    if (
      kind === "password" &&
      existingCredential &&
      (!input.password ||
        existingCredential.credential_id !== binding.credentialId ||
        !(await services.auth.verifyPassword(input.password, existingCredential.secret_hash)).valid)
    )
      throw new InvitationAttemptError("invitation_attempt_invalid");
    if (
      authority.user?.passwordCredentialId &&
      kind === "password" &&
      (authority.user.passwordCredentialId !== binding.credentialId ||
        !authority.user.authMethods.includes("password") ||
        !existingCredential)
    )
      throw new InvitationAttemptError("invitation_attempt_invalid");
    async function advance(stage: (typeof ATTEMPT_STAGES)[number]) {
      state = await checkpoint(services.eventStore, state!, stage, context);
      if (stage === "completed")
        await services.db.query(
          "INSERT INTO auth_invitation_acceptance_attempts (attempt_id, terminal_at) VALUES ($1, now()) ON CONFLICT (attempt_id) DO UPDATE SET terminal_at = COALESCE(auth_invitation_acceptance_attempts.terminal_at, EXCLUDED.terminal_at)",
          [input.attemptId],
        );
    }
    for (;;) {
      const next = ATTEMPT_STAGES[state.version - 1];
      switch (next) {
        case "ceremony-started":
          await advance(next);
          break;
        case "ceremony-stored": {
          const stored = await storedCredential(services, state);
          if (!stored)
            await withPgTransaction(services.pool, async (db) => {
              if (kind === "password") {
                if (!input.password) throw new InvitationAttemptError("invitation_attempt_ambiguous");
                await upsertPasswordCredential(db, {
                  userId: binding.userId,
                  credentialId: binding.credentialId,
                  secretHash: await services.auth.hashPassword(input.password),
                });
              } else {
                const challenge = await consumeChallenge(db, {
                  challengeId: input.challengeId!,
                  purpose: "passkey-register",
                  challengeValue: input.challenge ?? "",
                });
                if (!challenge || challenge.email !== services.identity.normalizeEmail(authority.email))
                  throw new InvitationAttemptError("invitation_attempt_ambiguous");
                const verified = await verifyPasskeyRegistration(request, {
                  webauthnResponse: input.webauthnResponse,
                  expectedChallenge: challenge.challenge_value,
                  externalCredentialId: input.externalCredentialId ?? null,
                });
                if (!verified) throw new InvitationAttemptError("invitation_attempt_invalid");
                await upsertPasskeyCredential(db, {
                  credentialId: binding.credentialId,
                  userId: binding.userId,
                  ...verified,
                  label: input.label ?? "",
                });
              }
            });
          if (kind === "password") {
            const credential = await getPasswordCredentialByUserId(services.db, binding.userId);
            if (
              !credential ||
              credential.credential_id !== binding.credentialId ||
              !input.password ||
              !(await services.auth.verifyPassword(input.password, credential.secret_hash)).valid
            )
              throw new InvitationAttemptError("invitation_attempt_invalid");
          }
          await advance(next);
          break;
        }
        case "registration-started":
          await readOwner();
          await advance(next);
          break;
        case "registered":
          authority = await readOwner();
          if (!authority.user) {
            const created = await identity.createPersonalIdentity({
              email: authority.email,
              displayName: createOwnedUserDisplayName(authority.email),
              reservedUserId: binding.userId,
              registrationConsent: await resolveUnaffirmedRegistrationConsent(identity),
            });
            if (created.userId !== binding.userId) throw new InvitationAttemptError("invitation_attempt_conflict");
          }
          authority = await readOwner();
          if (!authority.user) throw new InvitationAttemptError("invitation_attempt_ambiguous");
          await advance(next);
          break;
        case "acceptance-started":
          await readOwner();
          await advance(next);
          break;
        case "accepted":
          authority = await readOwner();
          if (!authority.accepted)
            await identity.acceptInvitationForUser({
              invitationId: input.invitationId,
              userId: binding.userId,
              acceptanceTokenHash,
              operation: operation(state),
            });
          authority = await readOwner();
          if (!authority.accepted) throw new InvitationAttemptError("invitation_attempt_ambiguous");
          await advance(next);
          break;
        case "email-started":
          await readOwner();
          await advance(next);
          break;
        case "email-verified":
          authority = await readOwner();
          if (!authority.user?.emailVerified)
            await identity.verifyEmailContactMethod({ userId: binding.userId, email: authority.email });
          if (!(await readOwner()).user?.emailVerified)
            throw new InvitationAttemptError("invitation_attempt_ambiguous");
          await advance(next);
          break;
        case "credential-started":
          await readOwner();
          await advance(next);
          break;
        case "credential-attached":
          authority = await readOwner();
          if (!authority.user) throw new InvitationAttemptError("invitation_attempt_ambiguous");
          if (kind === "password") {
            if (authority.user.passwordCredentialId && authority.user.passwordCredentialId !== binding.credentialId)
              throw new InvitationAttemptError("invitation_attempt_conflict");
            if (!authority.user.passwordCredentialId)
              await identity.enablePasswordCredential({ userId: binding.userId, credentialId: binding.credentialId });
          } else if (!authority.user.passkeyCredentialIds.includes(binding.credentialId)) {
            await identity.registerPasskeyCredential({ userId: binding.userId, credentialId: binding.credentialId });
          }
          await advance(next);
          break;
        case "store-started":
          await readOwner();
          await advance(next);
          break;
        case "credential-stored":
          if (!(await storedCredential(services, state)))
            throw new InvitationAttemptError("invitation_attempt_ambiguous");
          await advance(next);
          break;
        case "session-started":
          await readOwner();
          await advance(next);
          break;
        case "completed": {
          authority = await readOwner();
          if (
            !authority.accepted ||
            !authority.user ||
            !(await storedCredential(services, state)) ||
            !authority.user.authMethods.includes(kind) ||
            (kind === "password"
              ? authority.user.passwordCredentialId !== binding.credentialId
              : !authority.user.passkeyCredentialIds.includes(binding.credentialId))
          )
            throw new InvitationAttemptError("invitation_attempt_ambiguous");
          const existing = await services.sessions.getSessionState(binding.sessionId);
          if (existing) {
            await advance(next);
            return { type: "accepted-reauth-required" as const, attemptId: input.attemptId };
          }
          const result = await startInteractiveAuth(services, {
            userId: binding.userId,
            sessionId: binding.sessionId,
            accountId: binding.accountId,
            authenticationMethod: kind,
            context,
            membershipsOverride: [
              {
                membershipId: binding.membershipId,
                accountId: binding.accountId,
                roleKey: binding.roleKey,
                status: "active",
                rolePermissions: AUTH_ROLE_PERMISSIONS[binding.roleKey as keyof typeof AUTH_ROLE_PERMISSIONS] ?? [],
              },
            ],
            publishAuthenticationOutcome: true,
          });
          await advance(next);
          return {
            ...result,
            attemptId: input.attemptId,
            invitationId: input.invitationId,
            membershipId: binding.membershipId,
          };
        }
        default:
          throw new InvitationAttemptError("invitation_attempt_ambiguous");
      }
    }
  });
}
