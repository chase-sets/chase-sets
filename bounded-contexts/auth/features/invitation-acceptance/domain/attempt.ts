import { createHash } from "node:crypto";
import type { StoredEvent } from "@chase-sets/event-core/storage";

export const ATTEMPT_MAX_EVENTS = 16;
export const ATTEMPT_MAX_BYTES = 32 * 1024;
export const ATTEMPT_STAGES = [
  "registration-started",
  "registered",
  "ceremony-started",
  "ceremony-stored",
  "acceptance-started",
  "accepted",
  "email-started",
  "email-verified",
  "credential-started",
  "credential-attached",
  "store-started",
  "credential-stored",
  "session-started",
  "completed",
] as const;
export type AttemptStage = (typeof ATTEMPT_STAGES)[number];
export type AttemptBinding = Readonly<{
  version: 1;
  intent: "invitation-acceptance";
  attemptId: string;
  invitationId: string;
  accountId: string;
  roleKey: string;
  emailFingerprint: string;
  userId: string;
  membershipId: string;
  credentialId: string;
  sessionId: string;
  credentialKind: "password" | "passkey";
  ceremony: Readonly<{ id: string | null; externalCredentialId: string | null }>;
}>;
export type AttemptState = Readonly<{
  binding: AttemptBinding;
  digest: string;
  stage: AttemptStage | null;
  version: number;
  registrationStartedAt: string | null;
}>;

export class InvitationAttemptError extends Error {
  constructor(
    public readonly code: "invitation_attempt_invalid" | "invitation_attempt_conflict" | "invitation_attempt_ambiguous",
  ) {
    super("Invitation acceptance could not be confirmed. Check its status or sign in.");
  }
}

export function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvitationAttemptError("invitation_attempt_invalid");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !(key in object)))
    throw new InvitationAttemptError("invitation_attempt_invalid");
  return object;
}

export function parseAttemptBinding(value: unknown): AttemptBinding {
  const data = closed(value, [
    "version",
    "intent",
    "attemptId",
    "invitationId",
    "accountId",
    "roleKey",
    "emailFingerprint",
    "userId",
    "membershipId",
    "credentialId",
    "sessionId",
    "credentialKind",
    "ceremony",
  ]);
  if (
    data.version !== 1 ||
    data.intent !== "invitation-acceptance" ||
    typeof data.attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.attemptId) ||
    typeof data.emailFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(data.emailFingerprint) ||
    typeof data.roleKey !== "string" ||
    !["owner", "manager", "fulfillment", "viewer"].includes(data.roleKey) ||
    (data.credentialKind !== "password" && data.credentialKind !== "passkey")
  )
    throw new InvitationAttemptError("invitation_attempt_invalid");
  for (const [key, prefix] of [
    ["invitationId", "ivt"],
    ["accountId", "acc"],
    ["userId", "usr"],
    ["membershipId", "mbr"],
    ["credentialId", "crd"],
    ["sessionId", "ses"],
  ]) {
    if (typeof data[key] !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,80}$`).test(data[key]))
      throw new InvitationAttemptError("invitation_attempt_invalid");
  }
  const ceremony = closed(data.ceremony, ["id", "externalCredentialId"]);
  if (
    data.credentialKind === "password"
      ? ceremony.id !== null
      : typeof ceremony.id !== "string" || !/^cmd_[A-Za-z0-9_-]{1,80}$/.test(ceremony.id)
  )
    throw new InvitationAttemptError("invitation_attempt_invalid");
  if (
    ceremony.externalCredentialId !== null &&
    (data.credentialKind !== "passkey" ||
      typeof ceremony.externalCredentialId !== "string" ||
      !/^[A-Za-z0-9_-]{1,1024}$/.test(ceremony.externalCredentialId))
  )
    throw new InvitationAttemptError("invitation_attempt_invalid");
  return data as AttemptBinding;
}

export function bindingDigest(binding: AttemptBinding): string {
  const canonical = parseAttemptBinding(binding);
  return createHash("sha256")
    .update(
      JSON.stringify([
        canonical.version,
        canonical.intent,
        canonical.attemptId,
        canonical.invitationId,
        canonical.accountId,
        canonical.roleKey,
        canonical.emailFingerprint,
        canonical.userId,
        canonical.membershipId,
        canonical.credentialId,
        canonical.sessionId,
        canonical.credentialKind,
        canonical.ceremony.id,
        canonical.ceremony.externalCredentialId,
      ]),
    )
    .digest("hex");
}

export function foldAttempt(events: readonly StoredEvent[], tenantId: string): AttemptState | null {
  if (!events.length) return null;
  if (events.length > ATTEMPT_MAX_EVENTS || Buffer.byteLength(JSON.stringify(events), "utf8") > ATTEMPT_MAX_BYTES)
    throw new InvitationAttemptError("invitation_attempt_ambiguous");
  let state: AttemptState | null = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.tenantId !== tenantId || event.streamVersion !== index + 1)
      throw new InvitationAttemptError("invitation_attempt_ambiguous");
    if (index === 0) {
      if (event.eventType !== "auth.invitation-acceptance.started")
        throw new InvitationAttemptError("invitation_attempt_ambiguous");
      const binding = parseAttemptBinding(event.payload);
      if (event.streamId !== `auth.invitation-acceptance-${binding.attemptId}`)
        throw new InvitationAttemptError("invitation_attempt_ambiguous");
      state = { binding, digest: bindingDigest(binding), stage: null, version: 1, registrationStartedAt: null };
    } else {
      const data = closed(event.payload, ["bindingDigest", "stage", "at"]);
      if (
        !state ||
        event.eventType !== "auth.invitation-acceptance.checkpoint" ||
        data.bindingDigest !== state.digest ||
        data.stage !== ATTEMPT_STAGES[index - 1] ||
        typeof data.at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.at) ||
        !Number.isFinite(Date.parse(data.at))
      )
        throw new InvitationAttemptError("invitation_attempt_ambiguous");
      const previous: AttemptState = state;
      state = {
        binding: previous.binding,
        digest: previous.digest,
        stage: data.stage as AttemptStage,
        version: event.streamVersion,
        registrationStartedAt: data.stage === "registration-started" ? data.at : previous.registrationStartedAt,
      };
    }
  }
  return state;
}
