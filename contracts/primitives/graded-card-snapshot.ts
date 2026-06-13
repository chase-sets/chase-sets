import { z } from "zod";

const nullableTextSchema = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

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
