import type { SupportEvidenceAttachmentContentType } from "./attachment-policy";

const contentTypeExtensions = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const satisfies Readonly<Record<SupportEvidenceAttachmentContentType, string>>;

const extensionContentTypes = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export type SupportEvidenceAttachmentReference = Readonly<{
  attachmentId: string;
  sha256: string;
  contentType: SupportEvidenceAttachmentContentType;
}>;

export function createSupportEvidenceAttachmentReference(input: SupportEvidenceAttachmentReference): string {
  return `support-attachment:v1:${input.attachmentId}:${input.sha256}:${contentTypeExtensions[input.contentType]}`;
}

export function parseSupportEvidenceAttachmentReference(value: string): SupportEvidenceAttachmentReference | null {
  const match = /^support-attachment:v1:(sea_[a-zA-Z0-9]+):([a-f0-9]{64}):(jpg|png|webp)$/.exec(value);
  if (!match) {
    return null;
  }
  const attachmentId = match[1];
  const sha256 = match[2];
  const extension = match[3] as keyof typeof extensionContentTypes;
  if (!attachmentId || !sha256) {
    return null;
  }
  return { attachmentId, sha256, contentType: extensionContentTypes[extension] };
}

export function supportEvidenceAttachmentExtension(contentType: SupportEvidenceAttachmentContentType): string {
  return contentTypeExtensions[contentType];
}
