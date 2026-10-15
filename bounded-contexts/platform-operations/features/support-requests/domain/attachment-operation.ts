import { createHash } from "node:crypto";
import { parseStrictTypedUlid } from "@chase-sets/primitives/typed-ids";
import { createSupportEvidenceAttachmentReference } from "./attachment-reference";
import {
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT,
  isSupportEvidenceAttachmentContentType,
  type SupportEvidenceAttachmentContentType,
} from "./attachment-policy";

export type AttachmentOperationOwner = Readonly<{
  tenantId: string;
  accountId: string;
  supportRequestId: string;
  operationId: string;
}>;
export type AttachmentEncoderFingerprint = Readonly<{
  profile: string;
  sharp: string;
  libvips: string;
  platform: string;
  arch: string;
  libc: string;
}>;
export type AttachmentManifestItem = Readonly<{
  index: number;
  attachmentId: string;
  canonicalSha256: string;
  contentType: SupportEvidenceAttachmentContentType;
  byteSize: number;
}>;
export type AttachmentManifest = Readonly<{
  owner: AttachmentOperationOwner;
  profile: string;
  encoderFingerprint: AttachmentEncoderFingerprint;
  items: readonly AttachmentManifestItem[];
  manifestFingerprint: string;
}>;
type PutAdmission = Readonly<{ index: number; attempt: number }>;
type PutSettlement = PutAdmission & Readonly<{ outcome: "completed" | "failed" }>;
type StoredIndex = Readonly<{ index: number }>;
export type AttachmentCleanupReason =
  | "verification-conflict"
  | "verification-absent"
  | "put-failed"
  | "human-request"
  | "abandoned";
type CleanupRequirement = Readonly<{ reason: AttachmentCleanupReason }>;
export type AttachmentReferenceClaim = Readonly<{
  evidenceId: string;
  attachments: readonly string[];
  submittedAt: string;
}>;
/** One fenced cleanup attempt: it binds the exact manifest and the binding revision whose receipt the claim guarded. */
export type AttachmentCleanupClaim = Readonly<{
  attempt: number;
  manifestFingerprint: string;
  bindingId: string;
  bindingRevision: number;
  claimedAt: string;
}>;
type CleanupOutcome = Readonly<{ attempt: number }>;
type CleanupFailure = CleanupOutcome & Readonly<{ reason: "delete-failed" | "confirm-failed" }>;
/** What the decider needs to admit a claim; the runtime derives it from the binding and stored event times. */
export type AttachmentCleanupAuthority = Readonly<{
  bindingId: string;
  bindingRevision: number;
  now: string;
  lastPutAdmittedAt: string | null;
}>;
export type AttachmentOperationEvent =
  | Readonly<{ type: "support.attachment-operation.staged"; data: AttachmentManifest }>
  | Readonly<{ type: "support.attachment-operation.put-admitted"; data: PutAdmission }>
  | Readonly<{ type: "support.attachment-operation.put-settled"; data: PutSettlement }>
  | Readonly<{ type: "support.attachment-operation.stored"; data: StoredIndex }>
  | Readonly<{ type: "support.attachment-operation.cleanup-required"; data: CleanupRequirement }>
  | Readonly<{ type: "support.attachment-operation.reference-claimed"; data: AttachmentReferenceClaim }>
  | Readonly<{ type: "support.attachment-operation.reference-claim-released"; data: Readonly<{ evidenceId: string }> }>
  | Readonly<{ type: "support.attachment-operation.referenced"; data: Readonly<{ evidenceId: string }> }>
  | Readonly<{ type: "support.attachment-operation.cleanup-claimed"; data: AttachmentCleanupClaim }>
  | Readonly<{ type: "support.attachment-operation.deleted-unreferenced"; data: CleanupOutcome }>
  | Readonly<{ type: "support.attachment-operation.cleanup-failed"; data: CleanupFailure }>;
export type AttachmentOperationCommand =
  | Readonly<{ type: "StageSupportAttachmentOperation"; data: AttachmentManifest }>
  | Readonly<{ type: "AdmitSupportAttachmentPut"; data: PutAdmission }>
  | Readonly<{ type: "SettleSupportAttachmentPut"; data: PutSettlement }>
  | Readonly<{ type: "RecordSupportAttachmentStored"; data: StoredIndex }>
  | Readonly<{ type: "RequireSupportAttachmentCleanup"; data: CleanupRequirement }>
  | Readonly<{ type: "ClaimSupportAttachmentReference"; data: AttachmentReferenceClaim }>
  | Readonly<{ type: "ReleaseSupportAttachmentReferenceClaim"; data: Readonly<{ evidenceId: string }> }>
  | Readonly<{ type: "ConfirmSupportAttachmentReferenced"; data: Readonly<{ evidenceId: string }> }>
  | Readonly<{ type: "ClaimSupportAttachmentCleanup"; data: AttachmentCleanupClaim }>
  | Readonly<{ type: "ConfirmSupportAttachmentDeleted"; data: CleanupOutcome }>
  | Readonly<{ type: "RecordSupportAttachmentCleanupFailed"; data: CleanupFailure }>;
export type AttachmentOperationState = Readonly<{
  status:
    | "absent"
    | "staged"
    | "partially-stored"
    | "stored"
    | "cleanup-required"
    | "reference-claimed"
    | "referenced"
    | "cleanup-claimed"
    | "deleted-unreferenced";
  referenceClaim: AttachmentReferenceClaim | null;
  cleanupClaim: AttachmentCleanupClaim | null;
  cleanupAttempts: number;
  manifest: AttachmentManifest | null;
  stored: readonly number[];
  attempts: Readonly<Record<number, readonly Readonly<{ attempt: number; outcome: "completed" | "failed" | null }>[]>>;
}>;

export class AttachmentOperationError extends Error {
  constructor(
    public readonly code:
      | "operation-conflict"
      | "invalid-operation-history"
      | "operation-terminal"
      | "cleanup-not-eligible"
      | "cleanup-unauthorized",
  ) {
    super(code);
  }
}

/** A put may hold the key until its 30-second storage deadline; cleanup waits five more minutes beyond it. */
export const SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS = 30_000 + 5 * 60_000;
const cleanupReasons: readonly string[] = [
  "verification-conflict",
  "verification-absent",
  "put-failed",
  "human-request",
  "abandoned",
];
const cleanupPhases: readonly AttachmentOperationState["status"][] = [
  "cleanup-required",
  "cleanup-claimed",
  "deleted-unreferenced",
];
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function hasUnsettledAttachmentPut(state: AttachmentOperationState): boolean {
  return Object.values(state.attempts).some((attempts) => attempts.some((attempt) => attempt.outcome === null));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) invalid();
  return JSON.stringify(value);
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;
const safeId = /^[A-Za-z0-9_-]{1,100}$/;
function invalid(): never {
  throw new AttachmentOperationError("invalid-operation-history");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) invalid();
  return record;
}
function validateOwner(owner: AttachmentOperationOwner) {
  object(owner, ["tenantId", "accountId", "supportRequestId", "operationId"]);
  for (const [field, prefix] of [
    ["tenantId", "tnt_"],
    ["accountId", "acc_"],
    ["supportRequestId", "sup_"],
  ] as const)
    if (typeof owner[field] !== "string" || !owner[field].startsWith(prefix) || !safeId.test(owner[field])) invalid();
  try {
    parseStrictTypedUlid(owner.operationId, "sao");
  } catch {
    invalid();
  }
}

export function attachmentOperationStreamId(
  owner: Pick<AttachmentOperationOwner, "supportRequestId" | "operationId">,
): string {
  return `support.attachment-operation-${owner.supportRequestId}-${owner.operationId}`;
}

export function deriveSupportEvidenceAttachmentId(
  input: AttachmentOperationOwner & Readonly<{ index: number; canonicalSha256: string }>,
): string {
  validateOwner({
    tenantId: input.tenantId,
    accountId: input.accountId,
    supportRequestId: input.supportRequestId,
    operationId: input.operationId,
  });
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    input.index >= SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT ||
    typeof input.canonicalSha256 !== "string" ||
    !sha256.test(input.canonicalSha256)
  )
    invalid();
  const tuple = [
    "support-evidence-attachment-id/v1",
    input.tenantId,
    input.accountId,
    input.supportRequestId,
    input.operationId,
    input.index,
    input.canonicalSha256,
  ].join("\n");
  const bytes = createHash("sha256").update(tuple).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "sea_",
    bits = 0,
    buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

export function createAttachmentManifest(
  input: Readonly<{
    owner: AttachmentOperationOwner;
    profile: string;
    encoderFingerprint: AttachmentEncoderFingerprint;
    images: readonly Omit<AttachmentManifestItem, "index" | "attachmentId">[];
  }>,
): AttachmentManifest {
  validateOwner(input.owner);
  object(input.encoderFingerprint, ["profile", "sharp", "libvips", "platform", "arch", "libc"]);
  if (
    input.profile !== "support-evidence-raster/v1" ||
    input.encoderFingerprint.profile !== input.profile ||
    Object.values(input.encoderFingerprint).some(
      (value) => typeof value !== "string" || value.length < 1 || value.length > 100,
    ) ||
    input.images.length < 1 ||
    input.images.length > SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT
  )
    invalid();
  const items = input.images.map((image, index) => {
    object(image, ["canonicalSha256", "contentType", "byteSize"]);
    if (
      typeof image.canonicalSha256 !== "string" ||
      !sha256.test(image.canonicalSha256) ||
      !isSupportEvidenceAttachmentContentType(image.contentType) ||
      !Number.isSafeInteger(image.byteSize) ||
      image.byteSize < 1 ||
      image.byteSize > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES
    )
      invalid();
    return {
      index,
      attachmentId: deriveSupportEvidenceAttachmentId({
        ...input.owner,
        index,
        canonicalSha256: image.canonicalSha256,
      }),
      ...image,
    };
  });
  const authority = { owner: input.owner, profile: input.profile, encoderFingerprint: input.encoderFingerprint, items };
  return { ...authority, manifestFingerprint: digest(canonicalJson(authority)) };
}

function validateManifest(value: unknown): AttachmentManifest {
  const record = object(value, ["owner", "profile", "encoderFingerprint", "items", "manifestFingerprint"]);
  if (!Array.isArray(record.items)) invalid();
  const images = record.items.map((item) => {
    const i = object(item, ["index", "attachmentId", "canonicalSha256", "contentType", "byteSize"]);
    return { canonicalSha256: i.canonicalSha256, contentType: i.contentType, byteSize: i.byteSize };
  });
  const expected = createAttachmentManifest({
    owner: record.owner,
    profile: record.profile,
    encoderFingerprint: record.encoderFingerprint,
    images,
  } as Parameters<typeof createAttachmentManifest>[0]);
  if (canonicalJson(expected) !== canonicalJson(value)) invalid();
  return expected;
}

function evolve(state: AttachmentOperationState, event: AttachmentOperationEvent): AttachmentOperationState {
  if (event.type === "support.attachment-operation.staged") {
    if (state.status !== "absent") invalid();
    return { ...state, status: "staged", manifest: validateManifest(event.data) };
  }
  if (event.type === "support.attachment-operation.reference-claimed") {
    object(event.data, ["evidenceId", "attachments", "submittedAt"]);
    if (
      state.status !== "stored" ||
      !state.manifest ||
      Object.values(state.attempts).some((attempts) => attempts.some((attempt) => attempt.outcome !== "completed")) ||
      typeof event.data.evidenceId !== "string" ||
      !safeId.test(event.data.evidenceId) ||
      typeof event.data.submittedAt !== "string" ||
      !Number.isFinite(Date.parse(event.data.submittedAt)) ||
      canonicalJson(event.data.attachments) !== canonicalJson(attachmentManifestReferences(state.manifest))
    )
      invalid();
    return { ...state, status: "reference-claimed", referenceClaim: event.data };
  }
  if (
    event.type === "support.attachment-operation.reference-claim-released" ||
    event.type === "support.attachment-operation.referenced"
  ) {
    object(event.data, ["evidenceId"]);
    if (state.status !== "reference-claimed" || event.data.evidenceId !== state.referenceClaim?.evidenceId) invalid();
    return event.type === "support.attachment-operation.referenced"
      ? { ...state, status: "referenced" }
      : { ...state, status: "stored", referenceClaim: null };
  }
  if (state.status === "reference-claimed" || state.status === "referenced" || state.status === "deleted-unreferenced")
    invalid();
  if (event.type === "support.attachment-operation.cleanup-required") {
    const data = object(event.data, ["reason"]);
    if (
      typeof data.reason !== "string" ||
      !cleanupReasons.includes(data.reason) ||
      cleanupPhases.includes(state.status)
    )
      invalid();
    return { ...state, status: "cleanup-required" };
  }
  if (event.type === "support.attachment-operation.cleanup-claimed") {
    const data = object(event.data, ["attempt", "manifestFingerprint", "bindingId", "bindingRevision", "claimedAt"]);
    if (
      (state.status !== "cleanup-required" && state.status !== "cleanup-claimed") ||
      !state.manifest ||
      hasUnsettledAttachmentPut(state) ||
      data.attempt !== state.cleanupAttempts + 1 ||
      data.manifestFingerprint !== state.manifest.manifestFingerprint ||
      typeof data.bindingId !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(data.bindingId) ||
      typeof data.bindingRevision !== "number" ||
      !Number.isInteger(data.bindingRevision) ||
      data.bindingRevision < 1 ||
      data.bindingRevision > 2147483647 ||
      typeof data.claimedAt !== "string" ||
      !isoInstant.test(data.claimedAt) ||
      new Date(data.claimedAt).toISOString() !== data.claimedAt
    )
      invalid();
    return { ...state, status: "cleanup-claimed", cleanupClaim: event.data, cleanupAttempts: event.data.attempt };
  }
  if (
    event.type === "support.attachment-operation.deleted-unreferenced" ||
    event.type === "support.attachment-operation.cleanup-failed"
  ) {
    const data = object(
      event.data,
      event.type === "support.attachment-operation.cleanup-failed" ? ["attempt", "reason"] : ["attempt"],
    );
    if (
      state.status !== "cleanup-claimed" ||
      data.attempt !== state.cleanupClaim?.attempt ||
      (event.type === "support.attachment-operation.cleanup-failed" &&
        (typeof data.reason !== "string" || !["delete-failed", "confirm-failed"].includes(data.reason)))
    )
      invalid();
    return event.type === "support.attachment-operation.deleted-unreferenced"
      ? { ...state, status: "deleted-unreferenced" }
      : { ...state, status: "cleanup-required", cleanupClaim: null };
  }
  if (!state.manifest || state.status === "cleanup-claimed") invalid();
  // A writer admitted before cleanup was required may still settle; nothing else enters the cleanup phase.
  const pendingWriterSettles =
    state.status === "cleanup-required" && event.type === "support.attachment-operation.put-settled";
  if (state.status === "cleanup-required" && !pendingWriterSettles) invalid();
  if (
    !pendingWriterSettles &&
    Object.values(state.attempts).some((attempts) => attempts.some((attempt) => attempt.outcome === "failed"))
  )
    invalid();
  const data = object(
    event.data,
    event.type === "support.attachment-operation.stored"
      ? ["index"]
      : event.type === "support.attachment-operation.put-admitted"
        ? ["index", "attempt"]
        : ["index", "attempt", "outcome"],
  );
  const index = data.index as number;
  if (!Number.isSafeInteger(index) || index < 0 || index >= state.manifest.items.length) invalid();
  const attempts = state.attempts[index] ?? [];
  switch (event.type) {
    case "support.attachment-operation.put-admitted": {
      if (state.stored.includes(index) || data.attempt !== attempts.length + 1) invalid();
      return {
        ...state,
        attempts: { ...state.attempts, [index]: [...attempts, { attempt: event.data.attempt, outcome: null }] },
      };
    }
    case "support.attachment-operation.put-settled": {
      const attempt = attempts.find((a) => a.attempt === data.attempt);
      if (
        !attempt ||
        attempt.outcome !== null ||
        typeof data.outcome !== "string" ||
        !["completed", "failed"].includes(data.outcome)
      )
        invalid();
      return {
        ...state,
        attempts: {
          ...state.attempts,
          [index]: attempts.map((a) => (a === attempt ? { ...a, outcome: event.data.outcome } : a)),
        },
      };
    }
    case "support.attachment-operation.stored": {
      if (state.stored.includes(index) || attempts.some((a) => a.outcome === "failed")) invalid();
      const stored = [...state.stored, index];
      return {
        ...state,
        stored,
        status: stored.length === state.manifest.items.length ? "stored" : "partially-stored",
      };
    }
    default:
      return invalid();
  }
}

export function replayAttachmentOperation(events: readonly AttachmentOperationEvent[]): AttachmentOperationState {
  return events.reduce(evolve, {
    status: "absent",
    manifest: null,
    stored: [],
    attempts: {},
    referenceClaim: null,
    cleanupClaim: null,
    cleanupAttempts: 0,
  } as AttachmentOperationState);
}

function admitCleanupClaim(
  state: AttachmentOperationState,
  claim: AttachmentCleanupClaim,
  authority: AttachmentCleanupAuthority | undefined,
): void {
  if (
    !authority ||
    claim.bindingId !== authority.bindingId ||
    claim.bindingRevision !== authority.bindingRevision ||
    claim.claimedAt !== authority.now
  )
    throw new AttachmentOperationError("cleanup-unauthorized");
  // The grace window is eligibility only: an admitted put that never settled blocks the claim forever.
  if (
    (state.status !== "cleanup-required" && state.status !== "cleanup-claimed") ||
    hasUnsettledAttachmentPut(state) ||
    (authority.lastPutAdmittedAt !== null &&
      !(Date.parse(authority.now) >= Date.parse(authority.lastPutAdmittedAt) + SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS))
  )
    throw new AttachmentOperationError("cleanup-not-eligible");
}

export function decideAttachmentOperation(
  state: AttachmentOperationState,
  command: AttachmentOperationCommand,
  cleanupAuthority?: AttachmentCleanupAuthority,
): readonly AttachmentOperationEvent[] {
  if (command.type === "ClaimSupportAttachmentCleanup") {
    admitCleanupClaim(state, command.data, cleanupAuthority);
    const event = { type: "support.attachment-operation.cleanup-claimed", data: command.data } as const;
    evolve(state, event);
    return [event];
  }
  if (command.type === "ConfirmSupportAttachmentDeleted" || command.type === "RecordSupportAttachmentCleanupFailed") {
    object(command.data, command.type === "ConfirmSupportAttachmentDeleted" ? ["attempt"] : ["attempt", "reason"]);
    // A retried confirmation of the attempt that already deleted converges; every other unfenced outcome rejects.
    if (
      command.type === "ConfirmSupportAttachmentDeleted" &&
      state.status === "deleted-unreferenced" &&
      command.data.attempt === state.cleanupClaim?.attempt
    )
      return [];
    const event = (
      command.type === "ConfirmSupportAttachmentDeleted"
        ? { type: "support.attachment-operation.deleted-unreferenced", data: command.data }
        : { type: "support.attachment-operation.cleanup-failed", data: command.data }
    ) as AttachmentOperationEvent;
    evolve(state, event);
    return [event];
  }
  if (command.type === "ClaimSupportAttachmentReference" && state.referenceClaim) {
    if (canonicalJson(command.data) !== canonicalJson(state.referenceClaim))
      throw new AttachmentOperationError("operation-conflict");
    return [];
  }
  if (command.type === "ConfirmSupportAttachmentReferenced" && state.status === "referenced") {
    object(command.data, ["evidenceId"]);
    if (command.data.evidenceId !== state.referenceClaim?.evidenceId) invalid();
    return [];
  }
  if (command.type === "StageSupportAttachmentOperation") {
    const manifest = validateManifest(command.data);
    if (state.manifest) {
      if (canonicalJson(state.manifest) !== canonicalJson(manifest))
        throw new AttachmentOperationError("operation-conflict");
      if (cleanupPhases.includes(state.status)) throw new AttachmentOperationError("operation-terminal");
      return [];
    }
  }
  if (command.type === "RequireSupportAttachmentCleanup") {
    const data = object(command.data, ["reason"]);
    if (typeof data.reason !== "string" || !cleanupReasons.includes(data.reason)) invalid();
    if (cleanupPhases.includes(state.status)) return [];
  }
  if (command.type === "SettleSupportAttachmentPut" && state.status === "cleanup-required") {
    object(command.data, ["index", "attempt", "outcome"]);
    const attempt = state.attempts[command.data.index]?.find((a) => a.attempt === command.data.attempt);
    if (attempt && attempt.outcome !== null && attempt.outcome === command.data.outcome) return [];
    const event = { type: "support.attachment-operation.put-settled", data: command.data } as const;
    evolve(state, event);
    return [event];
  }
  if (cleanupPhases.includes(state.status)) throw new AttachmentOperationError("operation-terminal");
  if (command.type === "RecordSupportAttachmentStored" && state.stored.includes(command.data.index)) {
    object(command.data, ["index"]);
    return [];
  }
  if (
    (state.status === "reference-claimed" || state.status === "referenced") &&
    command.type !== "ReleaseSupportAttachmentReferenceClaim" &&
    command.type !== "ConfirmSupportAttachmentReferenced"
  )
    throw new AttachmentOperationError("operation-terminal");
  if (command.type === "SettleSupportAttachmentPut") {
    object(command.data, ["index", "attempt", "outcome"]);
    const attempt = state.attempts[command.data.index]?.find((a) => a.attempt === command.data.attempt);
    if (attempt && attempt.outcome !== null && attempt.outcome === command.data.outcome) return [];
  }
  const types = {
    StageSupportAttachmentOperation: "support.attachment-operation.staged",
    AdmitSupportAttachmentPut: "support.attachment-operation.put-admitted",
    SettleSupportAttachmentPut: "support.attachment-operation.put-settled",
    RecordSupportAttachmentStored: "support.attachment-operation.stored",
    RequireSupportAttachmentCleanup: "support.attachment-operation.cleanup-required",
    ClaimSupportAttachmentReference: "support.attachment-operation.reference-claimed",
    ReleaseSupportAttachmentReferenceClaim: "support.attachment-operation.reference-claim-released",
    ConfirmSupportAttachmentReferenced: "support.attachment-operation.referenced",
  } as const;
  const event = { type: types[command.type], data: command.data } as AttachmentOperationEvent;
  evolve(state, event);
  return [event];
}

export function attachmentManifestReferences(manifest: AttachmentManifest): readonly string[] {
  return manifest.items.map((item) =>
    createSupportEvidenceAttachmentReference({
      attachmentId: item.attachmentId,
      sha256: item.canonicalSha256,
      contentType: item.contentType,
    }),
  );
}
