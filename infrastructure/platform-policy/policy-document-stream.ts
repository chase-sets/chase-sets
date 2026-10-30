/** The authoritative stream namespace for policy-document events. */
export const POLICY_DOCUMENT_STREAM_PREFIX = "platform-policy.document-";

export function policyDocumentStreamId(documentId: string): string {
  return `${POLICY_DOCUMENT_STREAM_PREFIX}${documentId}`;
}

export function policyDocumentIdFromStreamId(streamId: string): string | null {
  return streamId.startsWith(POLICY_DOCUMENT_STREAM_PREFIX)
    ? streamId.slice(POLICY_DOCUMENT_STREAM_PREFIX.length) || null
    : null;
}
