import type { ResolvedListingEvidenceRequirements } from "../../listing-evidence-policy/domain/policy";
import { activeListingPhotos, type MarketplaceListingPhoto } from "./domain";

/**
 * Generic Listing Evidence coverage evaluator.
 *
 * This is the single authoritative "is the present typed evidence sufficient
 * for the resolved requirement?" function. It is pure and deterministic: it
 * takes a policy-resolved requirement snapshot (produced by
 * `listing-evidence-policy`) plus the listing's evidence
 * set, and returns stable machine codes describing what is unmet — never
 * thrown English policy text. UI copy is looked up from these codes via
 * localization (`evidenceCoverageCodeLocaleKey`).
 *
 * The evaluator knows nothing about graded cards, Mint, Pristine, or any
 * condition vocabulary: a required slot is an opaque configured slot id, so a
 * front+back requirement is two distinct slots that two front photos cannot
 * satisfy, and a slab-label slot is enforced generically.
 *
 * Consumed by the publication and Offer Acceptance gate and the seller
 * readiness UI. This module exposes the evaluator for those workflows.
 */
export type EvidenceCoverageCode =
  | "min-photo-count-unmet"
  | "slot-missing"
  | "slot-view-mismatch"
  | "slot-dimensions-too-small"
  | "slot-expired"
  | "duplicate-source";

export type EvidenceSlotCoverage = Readonly<{
  slotId: string;
  viewKind: string;
  satisfied: boolean;
  /** The active evidence entry that satisfies the slot, if any. */
  matchedPhotoId: string | null;
  /** The slot-level reason it is unmet, if unsatisfied. */
  unmetCode: EvidenceCoverageCode | null;
}>;

export type EvidenceCoverageResult = Readonly<{
  complete: boolean;
  /** Unique, stable machine codes for every unmet requirement. */
  unmetCodes: readonly EvidenceCoverageCode[];
  slots: readonly EvidenceSlotCoverage[];
  activePhotoCount: number;
  minimumPhotoCount: number;
}>;

export type EvaluateEvidenceCoverageOptions = Readonly<{
  /** Evaluation instant (ISO 8601) used for maximum-age checks; omit to skip age checks. */
  now?: string | null;
}>;

/** Stable localization key for a coverage code's buyer/seller-facing copy. */
export function evidenceCoverageCodeLocaleKey(code: EvidenceCoverageCode): string {
  return `marketplace.features.listings.evidenceCoverage.${code}`;
}

function slotFailureFor(
  photo: MarketplaceListingPhoto,
  slot: ResolvedListingEvidenceRequirements["requiredSlots"][number],
  nowMs: number | null,
): EvidenceCoverageCode | null {
  if (slot.viewKind && photo.viewKind && photo.viewKind !== slot.viewKind) {
    return "slot-view-mismatch";
  }
  const source = photo.assetSet.source;
  if (slot.minimumWidthPixels !== null && source.width < slot.minimumWidthPixels) {
    return "slot-dimensions-too-small";
  }
  if (slot.minimumHeightPixels !== null && source.height < slot.minimumHeightPixels) {
    return "slot-dimensions-too-small";
  }
  if (slot.maximumAgeHours !== null && nowMs !== null) {
    const capturedIso = photo.capturedAt ?? photo.uploadedAt;
    const capturedMs = Date.parse(capturedIso);
    if (!Number.isNaN(capturedMs)) {
      const ageHours = (nowMs - capturedMs) / (60 * 60 * 1000);
      if (ageHours > slot.maximumAgeHours) {
        return "slot-expired";
      }
    }
  }
  return null;
}

export function evaluateEvidenceCoverage(
  requirements: ResolvedListingEvidenceRequirements,
  evidence: readonly MarketplaceListingPhoto[],
  options: EvaluateEvidenceCoverageOptions = {},
): EvidenceCoverageResult {
  const active = activeListingPhotos(evidence);
  const nowMs = options.now ? Date.parse(options.now) : null;
  const nowMsOrNull = nowMs !== null && !Number.isNaN(nowMs) ? nowMs : null;

  const unmet = new Set<EvidenceCoverageCode>();
  const consumedSourceHashes = new Set<string>();
  const slots: EvidenceSlotCoverage[] = [];

  const orderedSlots = [...requirements.requiredSlots].sort((left, right) => left.slotId.localeCompare(right.slotId));

  for (const slot of orderedSlots) {
    const candidates = active.filter((photo) => photo.slotId === slot.slotId);
    let matched: MarketplaceListingPhoto | null = null;
    let firstFailure: EvidenceCoverageCode | null = null;

    for (const candidate of candidates) {
      const failure = slotFailureFor(candidate, slot, nowMsOrNull);
      if (failure) {
        firstFailure ??= failure;
        continue;
      }
      if (consumedSourceHashes.has(candidate.assetSet.sourceHash)) {
        // A single asset cannot prove two distinct configured views.
        firstFailure ??= "duplicate-source";
        continue;
      }
      matched = candidate;
      break;
    }

    if (matched) {
      consumedSourceHashes.add(matched.assetSet.sourceHash);
      slots.push({
        slotId: slot.slotId,
        viewKind: slot.viewKind,
        satisfied: true,
        matchedPhotoId: matched.photoId,
        unmetCode: null,
      });
    } else {
      const code = firstFailure ?? "slot-missing";
      unmet.add(code);
      slots.push({
        slotId: slot.slotId,
        viewKind: slot.viewKind,
        satisfied: false,
        matchedPhotoId: null,
        unmetCode: code,
      });
    }
  }

  if (active.length < requirements.minimumPhotoCount) {
    unmet.add("min-photo-count-unmet");
  }

  return {
    complete: unmet.size === 0,
    unmetCodes: [...unmet].sort((left, right) => left.localeCompare(right)),
    slots,
    activePhotoCount: active.length,
    minimumPhotoCount: requirements.minimumPhotoCount,
  };
}
