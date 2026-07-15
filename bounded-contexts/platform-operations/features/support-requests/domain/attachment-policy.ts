export const SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportEvidenceAttachmentContentType = (typeof SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES)[number];

export const SUPPORT_EVIDENCE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_EVIDENCE_ATTACHMENT_MAX_COUNT = 5;

export function isSupportEvidenceAttachmentContentType(value: string): value is SupportEvidenceAttachmentContentType {
  return SUPPORT_EVIDENCE_ATTACHMENT_CONTENT_TYPES.some((contentType) => contentType === value);
}
