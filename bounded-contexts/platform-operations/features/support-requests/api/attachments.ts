import { createHash } from "node:crypto";
import type { PrivateObjectStore, PrivatePutResult } from "@chase-sets/object-storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import {
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT,
  type SupportEvidenceAttachmentContentType,
} from "../domain/attachment-policy";
import {
  createSupportEvidenceAttachmentReference,
  parseSupportEvidenceAttachmentReference,
  supportEvidenceAttachmentExtension,
} from "../domain/attachment-reference";
import {
  attachmentOperationStreamId,
  canonicalJson,
  createAttachmentManifest,
  decideAttachmentOperation,
  replayAttachmentOperation,
  type AttachmentOperationCommand,
  type AttachmentOperationEvent,
} from "../domain/attachment-operation";
import type { SupportEvidenceCanonicalizationQueue, SupportEvidenceCanonicalImage } from "./evidence-canonicalization";
import { validateSupportAttachmentOperationId } from "./attachment-intake";

export type SupportEvidenceAttachmentStorage = Pick<PrivateObjectStore, "putPrivate" | "verifyPrivate" | "readPrivate">;
export type SupportEvidenceAttachmentUpload = Readonly<{
  body: Uint8Array;
  contentType: string;
  filename: string | null;
}>;
export type StoredSupportEvidenceAttachment = Readonly<{
  attachmentId: string;
  reference: string;
  contentType: SupportEvidenceAttachmentContentType;
  byteSize: number;
}>;
export const SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS = 30_000;

export class SupportEvidenceAttachmentError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid-content-type"
      | "invalid-content"
      | "too-large"
      | "too-many"
      | "operation-conflict"
      | "storage-unavailable",
  ) {
    super(message);
    this.name = "SupportEvidenceAttachmentError";
  }
}
function unavailable(): never {
  throw new SupportEvidenceAttachmentError("Support evidence storage is unavailable.", "storage-unavailable");
}
function storageSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}
export function attachmentStorageKey(
  supportRequestId: string,
  attachmentId: string,
  sha256: string,
  contentType: SupportEvidenceAttachmentContentType,
): string {
  return `support-evidence/${storageSegment(supportRequestId)}/${attachmentId}/${sha256}.${supportEvidenceAttachmentExtension(contentType)}`;
}

// A late provider response cannot settle an attempt whose deadline already expired.
async function putWithDeadline(
  storage: SupportEvidenceAttachmentStorage,
  key: string,
  image: SupportEvidenceCanonicalImage,
): Promise<PrivatePutResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      storage
        .putPrivate({
          key,
          body: image.body,
          contentType: image.contentType,
          deadlineMs: SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS,
        })
        .catch((): PrivatePutResult => ({ status: "ambiguous", key, reason: "transport-failed" })),
      new Promise<PrivatePutResult>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "ambiguous", key, reason: "deadline-exceeded" }),
          SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function storeSupportEvidenceAttachments(
  input: Readonly<{
    supportRequestId: string;
    operationId: string;
    context: EventStoreContext;
    eventStore: EventStore;
    uploads: readonly SupportEvidenceAttachmentUpload[];
    storage: SupportEvidenceAttachmentStorage | undefined;
    canonicalizer: SupportEvidenceCanonicalizationQueue | undefined;
  }>,
): Promise<readonly StoredSupportEvidenceAttachment[]> {
  validateSupportAttachmentOperationId(input.operationId);
  const storage = input.storage,
    canonicalizer = input.canonicalizer;
  if (!storage || !canonicalizer) unavailable();
  if (input.uploads.length === 0)
    throw new SupportEvidenceAttachmentError("Choose at least one evidence photo.", "invalid-content");
  if (input.uploads.length > SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT)
    throw new SupportEvidenceAttachmentError("Upload no more than 5 evidence photos at once.", "too-many");
  const images: SupportEvidenceCanonicalImage[] = [];
  for (const upload of input.uploads) {
    const result = await canonicalizer.canonicalize({ body: upload.body, declaredContentType: upload.contentType });
    if (result.kind === "rejected") {
      if (result.code === "busy" || result.code === "canonicalizer-unavailable") unavailable();
      const code =
        result.code === "unsupported-content-type"
          ? "invalid-content-type"
          : result.code === "encoded-too-large" || result.code === "canonical-too-large"
            ? "too-large"
            : "invalid-content";
      throw new SupportEvidenceAttachmentError(
        "Evidence must be a valid JPEG, PNG, or WebP image of at most 10 MB.",
        code,
      );
    }
    if (
      result.image.byteSize !== result.image.body.byteLength ||
      result.image.byteSize > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES ||
      createHash("sha256").update(result.image.body).digest("hex") !== result.image.sha256
    )
      unavailable();
    images.push(result.image);
  }
  const owner = {
    tenantId: input.context.tenantId,
    accountId: input.context.audit.forAccountId,
    supportRequestId: input.supportRequestId,
    operationId: input.operationId,
  };
  const first = images[0]!;
  if (
    images.some(
      (image) =>
        image.profile !== first.profile || canonicalJson(image.fingerprint) !== canonicalJson(first.fingerprint),
    )
  )
    unavailable();
  const manifest = createAttachmentManifest({
    owner,
    profile: first.profile,
    encoderFingerprint: first.fingerprint,
    images: images.map((image) => ({
      canonicalSha256: image.sha256,
      contentType: image.contentType,
      byteSize: image.byteSize,
    })),
  });
  const streamId = attachmentOperationStreamId(owner);
  const load = async () => {
    const storedEvents = await readCompleteStream(input.eventStore, { streamId });
    if (storedEvents.some((event) => event.tenantId !== owner.tenantId || event.forAccountId !== owner.accountId))
      throw new SupportEvidenceAttachmentError(
        "This upload operation belongs to a different owner.",
        "operation-conflict",
      );
    const history = storedEvents.map(
      (event) => ({ type: event.eventType, data: event.payload }) as AttachmentOperationEvent,
    );
    return { history, state: replayAttachmentOperation(history), version: storedEvents.at(-1)?.streamVersion ?? 0 };
  };
  let operation = await load();
  const append = async (command: AttachmentOperationCommand) => {
    const events = decideAttachmentOperation(operation.state, command);
    if (events.length === 0) return;
    await input.eventStore.appendToStream({
      streamId,
      expectedVersion: operation.version === 0 ? "no_stream" : operation.version,
      context: input.context,
      events: events.map((event) => ({ eventType: event.type, payload: event.data })),
    });
    operation = {
      history: [...operation.history, ...events],
      state: replayAttachmentOperation([...operation.history, ...events]),
      version: operation.version + events.length,
    };
  };
  await append({ type: "StageSupportAttachmentOperation", data: manifest });
  if (
    Object.values(operation.state.attempts).some((attempts) => attempts.some((attempt) => attempt.outcome === "failed"))
  ) {
    await append({ type: "RequireSupportAttachmentCleanup", data: { reason: "put-failed" } });
    unavailable();
  }
  for (const item of manifest.items) {
    const key = attachmentStorageKey(owner.supportRequestId, item.attachmentId, item.canonicalSha256, item.contentType);
    const expected = {
      sha256: item.canonicalSha256,
      byteSize: item.byteSize,
      contentType: item.contentType,
      deadlineMs: SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS,
    };
    const before = await storage.verifyPrivate(key, expected);
    if (before.status === "match") {
      await append({ type: "RecordSupportAttachmentStored", data: { index: item.index } });
      continue;
    }
    if (before.status === "unavailable") unavailable();
    if (before.status === "conflict" || operation.state.stored.includes(item.index)) {
      await append({
        type: "RequireSupportAttachmentCleanup",
        data: { reason: before.status === "conflict" ? "verification-conflict" : "verification-absent" },
      });
      unavailable();
    }
    const attempt = (operation.state.attempts[item.index]?.length ?? 0) + 1;
    await append({ type: "AdmitSupportAttachmentPut", data: { index: item.index, attempt } });
    const result = await putWithDeadline(storage, key, images[item.index]!);
    if (result.status === "ambiguous" || result.key !== key) unavailable();
    await append({ type: "SettleSupportAttachmentPut", data: { index: item.index, attempt, outcome: result.status } });
    if (result.status === "failed") {
      await append({ type: "RequireSupportAttachmentCleanup", data: { reason: "put-failed" } });
      unavailable();
    }
    const after = await storage.verifyPrivate(key, expected);
    if (after.status !== "match") {
      if (after.status !== "unavailable")
        await append({
          type: "RequireSupportAttachmentCleanup",
          data: { reason: after.status === "absent" ? "verification-absent" : "verification-conflict" },
        });
      unavailable();
    }
    await append({ type: "RecordSupportAttachmentStored", data: { index: item.index } });
  }
  operation = await load();
  if (
    !["stored", "reference-claimed", "referenced"].includes(operation.state.status) ||
    canonicalJson(operation.state.manifest) !== canonicalJson(manifest)
  )
    unavailable();
  return manifest.items.map((item) => ({
    attachmentId: item.attachmentId,
    reference: createSupportEvidenceAttachmentReference({
      attachmentId: item.attachmentId,
      sha256: item.canonicalSha256,
      contentType: item.contentType,
    }),
    contentType: item.contentType,
    byteSize: item.byteSize,
  }));
}

export async function readSupportEvidenceAttachment(
  input: Readonly<{
    supportRequestId: string;
    reference: string;
    storage: SupportEvidenceAttachmentStorage | undefined;
  }>,
): Promise<Readonly<{ body: Uint8Array; contentType: SupportEvidenceAttachmentContentType }> | null> {
  if (!input.storage) unavailable();
  const parsed = parseSupportEvidenceAttachmentReference(input.reference);
  if (!parsed) return null;
  const key = attachmentStorageKey(input.supportRequestId, parsed.attachmentId, parsed.sha256, parsed.contentType);
  const object = await input.storage.readPrivate(key, {
    maxBytes: SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
    deadlineMs: SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS,
  });
  if (object.status === "unavailable") unavailable();
  if (
    object.status !== "found" ||
    object.body.byteLength > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES ||
    object.byteSize !== object.body.byteLength ||
    (object.providerContentType !== null && object.providerContentType !== parsed.contentType)
  )
    return null;
  if (createHash("sha256").update(object.body).digest("hex") !== parsed.sha256) return null;
  return { body: object.body, contentType: parsed.contentType };
}
