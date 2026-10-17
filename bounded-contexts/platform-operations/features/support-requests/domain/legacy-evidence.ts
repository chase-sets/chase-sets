export const LEGACY_RECONSTRUCTION_STREAM = "support.evidence-legacy-reconstruction";
export const LEGACY_RECONSTRUCTED = "SupportEvidenceLegacyReferencesReconstructed";
export const LEGACY_DELETION_CLAIMED = "SupportEvidenceLegacyDeletionClaimed";
export const LEGACY_DELETION_RECORDED = "SupportEvidenceLegacyDeletionRecorded";

export type LegacyEvidenceKey = Readonly<{
  key: string;
  supportRequestId: string;
}>;

export type LegacyReferenceAuthority = Readonly<{
  status: "complete" | "unknown";
  horizon: string;
  count: number;
  digest: string;
  references: readonly string[];
  operationKeys: readonly string[];
}>;

export function parseLegacyEvidenceKey(key: string): LegacyEvidenceKey | null {
  const match = /^support-evidence\/([a-zA-Z0-9_-]+)\/sea_[a-zA-Z0-9]{26}\/[a-f0-9]{64}\.(jpg|png|webp)$/.exec(key);
  return match ? { key, supportRequestId: match[1]! } : null;
}
