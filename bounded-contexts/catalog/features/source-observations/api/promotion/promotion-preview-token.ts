import { createHash } from "node:crypto";
import type { SourceObservationPromotionPreview } from "../../read-model/queries";

export type SourceObservationPromotionSelection = Readonly<
  { observationIds: readonly string[] } | { scope: SourceObservationPromotionPreview["scope"] }
>;

/**
 * The checkpoint a bulk promotion must present: a digest of what its preview
 * showed. It binds the selection (explicit ids, or the scope the preview
 * resolved), the matched and eligible counts, the eligible content
 * fingerprint, the draft choice, and the validation verdict (coverage and the
 * blocked observations). A fresh preview that differs in any of these yields
 * a different token, so a stale confirmation is refused rather than executed.
 */
export function sourceObservationPromotionPreviewToken(
  selection: SourceObservationPromotionSelection,
  preview: SourceObservationPromotionPreview,
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
