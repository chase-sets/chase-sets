import { createHash } from "node:crypto";
import type { SourceObservationFilterScope, SourceObservationPromotionPreview } from "../../read-model/queries";
import { normalizeBulkJobScope } from "../source-observation-job-serialization";

export type SourceObservationPromotionSelection = Readonly<
  { observationIds: readonly string[] } | { scope: SourceObservationPromotionPreview["scope"] }
>;

/**
 * The review page a promotion was previewed from: its ingestion unit, import
 * scope, profile version and page scope. A preview binds it into its token and
 * an execution presents it again, so a confirmation carried to another unit,
 * import, profile version or page scope is refused, as it was before the check
 * moved into this API.
 */
export type SourceObservationPromotionConfirmation = Readonly<{
  unitKey: string | null;
  importScope: string | null;
  profileVersion: string | null;
  scope: SourceObservationFilterScope;
}>;

/**
 * The checkpoint a bulk promotion must present: a digest of what its preview
 * showed. It binds the selection (explicit ids, or the scope the preview
 * resolved), the matched and eligible counts, the eligible content
 * fingerprint, the draft choice, and the validation verdict (coverage and the
 * blocked observations), and the page it was previewed from. A fresh preview
 * that differs in any of these yields a different token, so a stale
 * confirmation is refused rather than executed.
 */
export function sourceObservationPromotionPreviewToken(
  selection: SourceObservationPromotionSelection,
  preview: SourceObservationPromotionPreview,
  confirmation: SourceObservationPromotionConfirmation,
): string {
  const blockedObservationIds = [
    ...new Set(
      preview.validation.diagnostics
        .filter((diagnostic) => diagnostic.blocking)
        .map((diagnostic) => diagnostic.observationId),
    ),
  ].sort();
  const canonical = JSON.stringify([
    "observationIds" in selection
      ? { observationIds: [...new Set(selection.observationIds)].sort() }
      : { scope: sortedRecord(selection.scope) },
    preview.matched,
    preview.eligible,
    preview.fingerprint || null,
    preview.validation.promoteAsDraft,
    preview.validation.coverage,
    blockedObservationIds,
    [
      confirmation.unitKey,
      confirmation.importScope,
      confirmation.profileVersion,
      sortedRecord(normalizeBulkJobScope(confirmation.scope)),
    ],
  ]);

  return `spp1.${createHash("sha256").update(canonical).digest("base64url")}`;
}

function sortedRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
