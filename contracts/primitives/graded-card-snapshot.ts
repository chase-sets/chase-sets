import { z } from "zod";

const nullableTextSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

/**
 * Graded Item Details: the `gradedCard` snapshot that Inventory attaches to
 * graded stock. Listings carry it and order lines keep part of it. The term is
 * owned by the Graded Item Details entry in `bounded-contexts/inventory/GLOSSARY.md`.
 *
 * - Presence of `gradedCard` is the published classification of graded stock, and readers may branch on presence.
 * - `certificationNumber`, `population` and `conditionDescriptors` are evidence about one item.
 * - `gradingCompany` and `grade` are display copies of the selected Options' labels, written only by Inventory from the selection.
 * - No code validates `gradingCompany` or `grade` against a code table, and no new code branches on their text.
 *
 * Recorded exception:
 *
 * - The company match of `sellerComplianceCohortPolicy` in Platform Operations' `bounded-contexts/platform-operations/features/seller-compliance-cohorts/domain/cohort-window.ts`.
 *
 * Channels' mapping keys stay because they match operator-reviewed mappings.
 */
export const gradedCardSnapshotSchema = z.object({
  gradingCompany: z.string(),
  grade: z.string(),
  certificationNumber: nullableTextSchema,
  population: z
    .object({
      populationAtGrade: z.number().int().nonnegative().nullable(),
      populationHigher: z.number().int().nonnegative().nullable(),
      source: nullableTextSchema,
      asOf: nullableTextSchema,
    })
    .nullish()
    .transform((value) => value ?? null),
  conditionDescriptors: z.array(z.string()),
});

export type GradedCardSnapshot = z.infer<typeof gradedCardSnapshotSchema>;

export function parseGradedCardSnapshot(value: unknown): GradedCardSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const parsed = gradedCardSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Graded card snapshot is invalid.");
  }

  return parsed.data;
}
