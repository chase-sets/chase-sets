import { z } from "zod";
import { parseTcgplayerSealedProductObservationPost, sealedRequestMaxProducts } from "./contract";

// Issue: https://github.com/chase-sets/chase-sets/issues/12011
export const sealedPartHeader = "X-Catalog-Sealed-Part-Index";
export const sealedAnswerLimits = {
  maxParts: 500,
  maxBytes: 16 * 1024 * 1024,
  maxProducts: sealedRequestMaxProducts,
} as const;

const manifest = z
  .strictObject({
    kind: z.literal("complete"),
    partDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(sealedAnswerLimits.maxParts),
    productCount: z.number().int().min(0).max(sealedAnswerLimits.maxProducts),
    verifiedEmpty: z.boolean(),
  })
  .refine(({ partDigests, productCount, verifiedEmpty }) =>
    partDigests.length === 0
      ? productCount === 0 && verifiedEmpty
      : productCount >= partDigests.length && !verifiedEmpty,
  );
const failure = z.strictObject({
  kind: z.literal("failure"),
  code: z.enum(["provider-request-failed", "provider-response-unqualified", "provider-collection-incomplete"]),
  endpointCode: z
    .enum([
      "http-not-success",
      "non-json",
      "body-cap-exceeded",
      "timeout",
      "network-error",
      "invalid-response",
      "unavailable",
      "refused",
      "invalid-product-line-id",
    ])
    .nullable(),
});

export function parseSealedAnswer(value: unknown, part: string | null) {
  if (part === null) {
    const parsed = z.union([manifest, failure]).safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) >= sealedAnswerLimits.maxParts) return null;
  const parsed = parseTcgplayerSealedProductObservationPost(value);
  return parsed.ok ? { kind: "part" as const, partIndex: Number(part), post: parsed.post } : null;
}

export type SealedAnswer = NonNullable<ReturnType<typeof parseSealedAnswer>>;
