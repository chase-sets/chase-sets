import type { SavedListId, SavedListLineId, SavedListVisibility } from "../domain/contracts";

// Presentation contract for a shared Saved List as it renders to a viewer.
//
// This is the render-ready view the privacy-safe public projection populates:
// it carries only fields that are safe to publish and only the values the
// owner's disclosure settings expose. Notes, private tags, owned quantities,
// cost, locations, and P&L never enter this shape. The projection owner
// resolves visibility, redaction, and valuation upstream; this slice only
// renders what it is handed and never widens the surface.

export type SavedListPreviewVisibility = Exclude<SavedListVisibility, "private">;

export type SavedListPreviewDisclosure = Readonly<{
  showTrackedQuantities: boolean;
  showEstimatedValue: boolean;
}>;

export type SavedListPreviewOwner = Readonly<{
  displayName: string;
  // Present only when the owner publishes a public profile; unlisted lists and
  // profile-private owners resolve this to null so no profile link leaks.
  profileHref: string | null;
  avatarUrl: string | null;
}>;

export type SavedListPreviewLineAvailability = "active" | "retired" | "removed";

export type SavedListPreviewMoney = Readonly<{
  amount: string;
  currencyCode: string;
}>;

export type SavedListPreviewLine = Readonly<{
  lineId: SavedListLineId;
  position: number;
  productName: string;
  productHref: string | null;
  optionLabels: readonly string[];
  imageUrl: string | null;
  availability: SavedListPreviewLineAvailability;
  // Null whenever quantity disclosure is off or the line was removed upstream.
  trackedQuantity: number | null;
  // Null whenever value disclosure is off, the estimate is missing, or the
  // Product was retired and can no longer be valued.
  estimatedValue: SavedListPreviewMoney | null;
}>;

export type SavedListPreviewValuation = Readonly<{
  totalEstimatedValue: SavedListPreviewMoney | null;
  valuedLineCount: number;
  totalLineCount: number;
  asOf: string | null;
}>;

export type SavedListPreviewPage = Readonly<{
  page: number;
  pageSize: number;
  totalPages: number;
}>;

export type SavedListPreviewContent = Readonly<{
  listId: SavedListId;
  title: string;
  description: string | null;
  visibility: SavedListPreviewVisibility;
  owner: SavedListPreviewOwner;
  coverImageUrl: string | null;
  disclosure: SavedListPreviewDisclosure;
  lines: readonly SavedListPreviewLine[];
  lineCount: number;
  // Null whenever value disclosure is off; the section is then fully absent.
  valuation: SavedListPreviewValuation | null;
  pagination: SavedListPreviewPage;
  changedAt: string;
  version: number;
  canSaveCopy: boolean;
  // Public lists are index-eligible only under an explicit posture resolved
  // upstream; unlisted lists always resolve this to false.
  seoIndexable: boolean;
}>;

export type SavedListPreviewUnavailableReason = "revoked" | "not-found" | "archived";

export type SavedListPreview =
  | Readonly<{ status: "available"; content: SavedListPreviewContent }>
  | Readonly<{ status: "unavailable"; reason: SavedListPreviewUnavailableReason }>;

export type { SavedListId, SavedListLineId };
