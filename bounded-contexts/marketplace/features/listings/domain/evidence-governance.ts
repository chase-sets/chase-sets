import { activeListingPhotos, type MarketplaceListingPhoto } from "./domain";

/**
 * Listing Evidence asset governance.
 *
 * Beyond the existing per-file upload byte limit, the evidence set is bounded
 * by a total active-entry count and a total stored-byte budget, and every
 * decoded image is validated against a maximum pixel budget so a small,
 * highly-compressed "image bomb" cannot expand into an unbounded raster during
 * normalization. All checks fail safely with a stable diagnostic rather than
 * silently truncating or crashing the upload path.
 */
export class MarketplaceEvidenceGovernanceError extends Error {
  public constructor(
    message: string,
    public readonly code: EvidenceGovernanceCode,
  ) {
    super(message);
    this.name = "MarketplaceEvidenceGovernanceError";
  }
}

export type EvidenceGovernanceCode =
  | "too-many-evidence"
  | "total-bytes-exceeded"
  | "pixel-budget-exceeded"
  | "invalid-dimensions";

/**
 * Default maximum decoded pixels (width * height) accepted for a single source
 * image (~24 MP). sharp's own `limitInputPixels` guards the decoder; this is
 * the domain-level budget applied to the reported dimensions.
 */
export const DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS = 24_000_000;

/** Sum of every stored asset byte (source + variants) for one evidence entry. */
export function listingPhotoStoredBytes(photo: MarketplaceListingPhoto): number {
  return photo.assetSet.source.byteSize + photo.assetSet.variants.reduce((sum, variant) => sum + variant.byteSize, 0);
}

export function totalActiveEvidenceStoredBytes(evidence: readonly MarketplaceListingPhoto[]): number {
  return activeListingPhotos(evidence).reduce((sum, photo) => sum + listingPhotoStoredBytes(photo), 0);
}

export type EvidenceCountByteGovernance = Readonly<{
  existingEvidence: readonly MarketplaceListingPhoto[];
  additions: readonly MarketplaceListingPhoto[];
  maxEvidenceCount: number;
  maxTotalStoredBytes: number;
}>;

/**
 * Asserts that adding `additions` keeps the active evidence set within the
 * configured count and total-byte budgets. Replacement callers pass the
 * post-replacement `existingEvidence` (with the replaced entry already
 * demoted) so the superseded asset does not double-count.
 */
export function assertEvidenceCountAndBytesWithinBudget(input: EvidenceCountByteGovernance): void {
  const existingActive = activeListingPhotos(input.existingEvidence);
  const projectedCount = existingActive.length + input.additions.length;
  if (projectedCount > input.maxEvidenceCount) {
    throw new MarketplaceEvidenceGovernanceError(
      `A listing can carry at most ${input.maxEvidenceCount} evidence images.`,
      "too-many-evidence",
    );
  }

  const projectedBytes =
    existingActive.reduce((sum, photo) => sum + listingPhotoStoredBytes(photo), 0) +
    input.additions.reduce((sum, photo) => sum + listingPhotoStoredBytes(photo), 0);
  if (projectedBytes > input.maxTotalStoredBytes) {
    throw new MarketplaceEvidenceGovernanceError(
      "This listing's evidence images exceed the total storage budget. Remove or replace images and try again.",
      "total-bytes-exceeded",
    );
  }
}

/**
 * Image-bomb / malformed-dimension guard applied to a decoded source image
 * before normalization stores any variant.
 */
export function assertDecodedImageWithinBudget(
  dimensions: Readonly<{ width: number; height: number }>,
  options: Readonly<{ maxSourcePixels?: number }> = {},
): void {
  const { width, height } = dimensions;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MarketplaceEvidenceGovernanceError(
      "Listing evidence image dimensions could not be read.",
      "invalid-dimensions",
    );
  }
  const maxSourcePixels = options.maxSourcePixels ?? DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS;
  if (width * height > maxSourcePixels) {
    throw new MarketplaceEvidenceGovernanceError(
      "Listing evidence image is too large to process safely.",
      "pixel-budget-exceeded",
    );
  }
}
