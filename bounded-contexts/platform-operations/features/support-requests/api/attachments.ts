import { createHash } from "node:crypto";
import type { ObjectStorage } from "@chase-sets/object-storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES,
  SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT,
  isSupportEvidenceAttachmentContentType,
  type SupportEvidenceAttachmentContentType,
} from "../domain/attachment-policy";
import {
  createSupportEvidenceAttachmentReference,
  parseSupportEvidenceAttachmentReference,
  supportEvidenceAttachmentExtension,
} from "../domain/attachment-reference";

export type SupportEvidenceAttachmentStorage = Pick<ObjectStorage, "putObject" | "getObject" | "deleteObjects">;

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

export type SupportEvidenceAttachmentSecurityScanner = Readonly<{
  scan(
    input: Readonly<{ body: Uint8Array; contentType: string; filename: string | null }>,
  ): Promise<"clean" | "rejected">;
}>;

export class SupportEvidenceAttachmentError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "invalid-content-type"
      | "invalid-content"
      | "too-large"
      | "too-many"
      | "security-rejected"
      | "storage-unavailable",
  ) {
    super(message);
    this.name = "SupportEvidenceAttachmentError";
  }
}

type PreparedAttachment = StoredSupportEvidenceAttachment & Readonly<{ body: Uint8Array; storageKey: string }>;

function storageSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}

function attachmentStorageKey(
  supportRequestId: string,
  attachmentId: string,
  sha256: string,
  contentType: SupportEvidenceAttachmentContentType,
): string {
  return `support-evidence/${storageSegment(supportRequestId)}/${attachmentId}/${sha256}.${supportEvidenceAttachmentExtension(contentType)}`;
}

function hasExpectedSignature(contentType: SupportEvidenceAttachmentContentType, body: Uint8Array): boolean {
  if (contentType === "image/jpeg") {
    return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  }
  if (contentType === "image/png") {
    return (
      body.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => body[index] === byte)
    );
  }
  return (
    body.length >= 12 &&
    new TextDecoder().decode(body.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(body.slice(8, 12)) === "WEBP"
  );
}

export const defaultSupportEvidenceAttachmentSecurityScanner: SupportEvidenceAttachmentSecurityScanner = {
  async scan({ body }) {
    const searchable = new TextDecoder().decode(body.slice(0, Math.min(body.length, 4096))).toUpperCase();
    return searchable.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "rejected" : "clean";
  },
};

async function prepareAttachment(
  supportRequestId: string,
  upload: SupportEvidenceAttachmentUpload,
  securityScanner: SupportEvidenceAttachmentSecurityScanner,
): Promise<PreparedAttachment> {
  const contentType = upload.contentType.trim().toLowerCase();
  if (!isSupportEvidenceAttachmentContentType(contentType)) {
    throw new SupportEvidenceAttachmentError("Evidence must be a JPEG, PNG, or WebP image.", "invalid-content-type");
  }
  if (upload.body.byteLength === 0) {
    throw new SupportEvidenceAttachmentError("Evidence photos cannot be empty.", "invalid-content");
  }
  if (upload.body.byteLength > SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES) {
    throw new SupportEvidenceAttachmentError("Each evidence photo must be 10 MB or smaller.", "too-large");
  }
  if (!hasExpectedSignature(contentType, upload.body)) {
    throw new SupportEvidenceAttachmentError(
      "Evidence content does not match its declared image type.",
      "invalid-content",
    );
  }
  if ((await securityScanner.scan({ ...upload, contentType })) !== "clean") {
    throw new SupportEvidenceAttachmentError("Evidence was rejected by the security scan.", "security-rejected");
  }

  const attachmentId = createId("sea");
  const sha256 = createHash("sha256").update(upload.body).digest("hex");
  return {
    attachmentId,
    reference: createSupportEvidenceAttachmentReference({ attachmentId, sha256, contentType }),
    contentType,
    byteSize: upload.body.byteLength,
    body: upload.body,
    storageKey: attachmentStorageKey(supportRequestId, attachmentId, sha256, contentType),
  };
}

export async function storeSupportEvidenceAttachments(
  input: Readonly<{
    supportRequestId: string;
    uploads: readonly SupportEvidenceAttachmentUpload[];
    storage: SupportEvidenceAttachmentStorage | undefined;
    securityScanner?: SupportEvidenceAttachmentSecurityScanner;
  }>,
): Promise<readonly StoredSupportEvidenceAttachment[]> {
  if (!input.storage) {
    throw new SupportEvidenceAttachmentError("Support evidence storage is unavailable.", "storage-unavailable");
  }
  if (input.uploads.length === 0) {
    throw new SupportEvidenceAttachmentError("Choose at least one evidence photo.", "invalid-content");
  }
  if (input.uploads.length > SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT) {
    throw new SupportEvidenceAttachmentError("Upload no more than 5 evidence photos at once.", "too-many");
  }

  const scanner = input.securityScanner ?? defaultSupportEvidenceAttachmentSecurityScanner;
  const prepared = await Promise.all(
    input.uploads.map((upload) => prepareAttachment(input.supportRequestId, upload, scanner)),
  );
  const storedKeys: string[] = [];
  try {
    for (const attachment of prepared) {
      const stored = await input.storage.putObject({
        key: attachment.storageKey,
        body: attachment.body,
        contentType: attachment.contentType,
        cacheControl: "private, no-store",
        visibility: "private",
      });
      storedKeys.push(stored.key);
    }
  } catch (error) {
    await input.storage.deleteObjects(storedKeys).catch(() => undefined);
    if (error instanceof SupportEvidenceAttachmentError) {
      throw error;
    }
    throw new SupportEvidenceAttachmentError("Support evidence storage is unavailable.", "storage-unavailable");
  }

  return prepared.map(({ attachmentId, reference, contentType, byteSize }) => ({
    attachmentId,
    reference,
    contentType,
    byteSize,
  }));
}

export async function readSupportEvidenceAttachment(
  input: Readonly<{
    supportRequestId: string;
    reference: string;
    storage: SupportEvidenceAttachmentStorage | undefined;
  }>,
): Promise<Readonly<{ body: Uint8Array; contentType: SupportEvidenceAttachmentContentType }> | null> {
  if (!input.storage) {
    throw new SupportEvidenceAttachmentError("Support evidence storage is unavailable.", "storage-unavailable");
  }
  const parsed = parseSupportEvidenceAttachmentReference(input.reference);
  if (!parsed) {
    return null;
  }
  const storageKey = attachmentStorageKey(
    input.supportRequestId,
    parsed.attachmentId,
    parsed.sha256,
    parsed.contentType,
  );
  const object = await input.storage.getObject(storageKey);
  if (!object || object.contentType !== parsed.contentType) {
    return null;
  }
  const sha256 = createHash("sha256").update(object.body).digest("hex");
  if (sha256 !== parsed.sha256) {
    return null;
  }
  return { body: object.body, contentType: parsed.contentType };
}
