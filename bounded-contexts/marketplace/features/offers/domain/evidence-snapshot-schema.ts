import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalMarketplaceRequest } from "../../mutation-recovery/domain/contracts";

const text = z.string().min(1).max(4096);
export const offerEvidenceSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    policyHash: text.nullable(),
    snapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    evidence: z
      .array(
        z.strictObject({
          photoId: text,
          slotId: text.nullable(),
          viewKind: text.nullable(),
          sortOrder: z.number().int(),
          sourceHash: text,
          assetRevision: text,
          capturedAt: z.iso.datetime().nullable(),
          uploadedAt: z.iso.datetime(),
          assets: z
            .array(
              z.strictObject({
                role: text,
                storageKey: text,
                publicUrl: text,
                width: z.number().int().positive(),
                height: z.number().int().positive(),
                density: z.union([z.literal(1), z.literal(2), z.null()]),
                mediaType: z.literal("image/webp"),
                byteSize: z.number().int().nonnegative(),
              }),
            )
            .max(20),
        }),
      )
      .max(100),
  })
  .refine(
    ({ schemaVersion, policyHash, evidence, snapshotHash }) =>
      snapshotHash ===
      `sha256:${createHash("sha256")
        .update(canonicalMarketplaceRequest({ schemaVersion, policyHash, evidence }))
        .digest("hex")}`,
    "Invalid evidence snapshot content hash.",
  );
