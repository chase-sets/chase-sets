import { createHash } from "node:crypto";
import type { ObjectStorage } from "@chase-sets/object-storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { RETURN_INTAKE_EVIDENCE_RETENTION_DAYS, type ReturnIntakeEvidenceAttachment } from "../domain/facility-intake";

export const RETURN_INTAKE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export { RETURN_INTAKE_EVIDENCE_RETENTION_DAYS } from "../domain/facility-intake";

export type ReturnIntakeEvidenceSecurityScanner = Readonly<{
  scan(
    input: Readonly<{ body: Uint8Array; contentType: string; filename: string | null }>,
  ): Promise<"clean" | "rejected">;
}>;

export type ReturnIntakeEvidenceStorage = Pick<ObjectStorage, "putObject" | "getObject" | "deleteObjects">;

export type ReturnIntakeEvidenceUpload = Readonly<{
  body: Uint8Array;
  contentType: string;
  filename: string | null;
}>;

export class ReturnIntakeEvidenceError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "invalid-content-type"
      | "invalid-content"
      | "too-large"
      | "security-rejected"
      | "storage-unavailable",
  ) {
    super(message);
    this.name = "ReturnIntakeEvidenceError";
  }
}

const contentTypeExtensions = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

function facilityStorageSegment(facilityId: string): string {
  return facilityId.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}

function evidenceStorageKey(
  facilityId: string,
  attachmentId: string,
  sha256: string,
  contentType: keyof typeof contentTypeExtensions,
): string {
  return `return-intake/${facilityStorageSegment(facilityId)}/${attachmentId}/${sha256}.${contentTypeExtensions[contentType]}`;
}

function hasExpectedSignature(contentType: keyof typeof contentTypeExtensions, body: Uint8Array): boolean {
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

export const defaultReturnIntakeEvidenceSecurityScanner: ReturnIntakeEvidenceSecurityScanner = {
  async scan({ body }) {
    const searchable = new TextDecoder().decode(body.slice(0, Math.min(body.length, 4096))).toUpperCase();
    return searchable.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "rejected" : "clean";
  },
};

export async function storeReturnIntakeEvidence(
  input: Readonly<{
    upload: ReturnIntakeEvidenceUpload;
    facilityId: string;
    uploadedAt: string;
    storage: ReturnIntakeEvidenceStorage | undefined;
    securityScanner?: ReturnIntakeEvidenceSecurityScanner;
  }>,
): Promise<ReturnIntakeEvidenceAttachment> {
  if (!input.storage) {
    throw new ReturnIntakeEvidenceError("Intake evidence storage is unavailable.", "storage-unavailable");
  }
  const contentType = input.upload.contentType.trim().toLowerCase();
  if (!(contentType in contentTypeExtensions)) {
    throw new ReturnIntakeEvidenceError("Evidence must be a JPEG, PNG, or WebP image.", "invalid-content-type");
  }
  if (input.upload.body.byteLength === 0 || input.upload.body.byteLength > RETURN_INTAKE_EVIDENCE_MAX_BYTES) {
    throw new ReturnIntakeEvidenceError("Evidence must be non-empty and no larger than 10 MB.", "too-large");
  }
  const safeContentType = contentType as keyof typeof contentTypeExtensions;
  if (!hasExpectedSignature(safeContentType, input.upload.body)) {
    throw new ReturnIntakeEvidenceError("Evidence content does not match its declared image type.", "invalid-content");
  }
  const scanStatus = await (input.securityScanner ?? defaultReturnIntakeEvidenceSecurityScanner).scan({
    ...input.upload,
    contentType: safeContentType,
  });
  if (scanStatus !== "clean") {
    throw new ReturnIntakeEvidenceError("Evidence was rejected by the security scan.", "security-rejected");
  }
  const uploadedAtMs = Date.parse(input.uploadedAt);
  if (Number.isNaN(uploadedAtMs)) {
    throw new ReturnIntakeEvidenceError("Evidence upload timestamp is invalid.", "invalid-content");
  }
  const attachmentId = createId("rie");
  const sha256 = createHash("sha256").update(input.upload.body).digest("hex");
  const storageKey = evidenceStorageKey(input.facilityId, attachmentId, sha256, safeContentType);
  const stored = await input.storage.putObject({
    key: storageKey,
    body: input.upload.body,
    contentType: safeContentType,
    cacheControl: "private, no-store",
    visibility: "private",
  });
  return {
    attachmentId,
    storageKey: stored.key,
    contentType: safeContentType,
    byteSize: input.upload.body.byteLength,
    sha256,
    uploadedAt: new Date(uploadedAtMs).toISOString(),
    retentionUntil: new Date(uploadedAtMs + RETURN_INTAKE_EVIDENCE_RETENTION_DAYS * 86_400_000).toISOString(),
    securityScanStatus: "clean",
  };
}

export async function verifyStoredReturnIntakeEvidence(
  input: Readonly<{
    facilityId: string;
    attachments: readonly ReturnIntakeEvidenceAttachment[];
    storage: ReturnIntakeEvidenceStorage | undefined;
  }>,
): Promise<void> {
  if (!input.storage) {
    throw new ReturnIntakeEvidenceError("Intake evidence storage is unavailable.", "storage-unavailable");
  }
  const storage = input.storage;
  await Promise.all(
    input.attachments.map(async (attachment) => {
      const expectedKey = evidenceStorageKey(
        input.facilityId,
        attachment.attachmentId,
        attachment.sha256,
        attachment.contentType,
      );
      if (attachment.storageKey !== expectedKey) {
        throw new ReturnIntakeEvidenceError("Evidence does not belong to this facility intake.", "invalid-content");
      }
      const stored = await storage.getObject(expectedKey);
      if (!stored) {
        throw new ReturnIntakeEvidenceError("Evidence object was not found.", "invalid-content");
      }
      const sha256 = createHash("sha256").update(stored.body).digest("hex");
      if (
        stored.contentType !== attachment.contentType ||
        stored.body.byteLength !== attachment.byteSize ||
        sha256 !== attachment.sha256
      ) {
        throw new ReturnIntakeEvidenceError("Evidence object does not match its audited metadata.", "invalid-content");
      }
    }),
  );
}
