import { createHash } from "node:crypto";
import { z } from "zod";
import { sourceObservationLinkExternalKey, type SourceObservationState } from "../../domain/domain";
import { canonicalPromotionReferenceText } from "./promotion-reference-canonicalization";

const keyText = z.string().min(1).max(2048);
export const promotionTargetKeySchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("member"), observationId: keyText }).strict(),
  z.object({ level: z.enum(["item", "product"]), providerKey: keyText, externalKey: keyText }).strict(),
]);
export type PromotionTargetKey = z.infer<typeof promotionTargetKeySchema>;
export type PromotionReferenceKey = Exclude<PromotionTargetKey, { level: "member" }>;

export function canonicalPromotionTargetKey(key: PromotionTargetKey): PromotionTargetKey {
  promotionTargetKeySchema.parse(key);
  return promotionTargetKeySchema.parse(
    key.level === "member"
      ? key
      : {
          level: key.level,
          providerKey: canonicalPromotionReferenceText(key.providerKey),
          externalKey: canonicalPromotionReferenceText(key.externalKey),
        },
  );
}

export function promotionTargetKeyIdentity(key: PromotionTargetKey): string {
  key = canonicalPromotionTargetKey(key);
  return JSON.stringify(
    key.level === "member" ? [key.level, key.observationId] : [key.level, key.providerKey, key.externalKey],
  );
}

export function promotionTargetBindingStream(key: PromotionTargetKey): string {
  return `catalog.promotion-target-${createHash("sha256").update(promotionTargetKeyIdentity(key)).digest("hex")}`;
}

export function retainedPromotionTargetBindingStream(key: PromotionTargetKey): string {
  promotionTargetKeySchema.parse(key);
  const identity = JSON.stringify(
    key.level === "member" ? [key.level, key.observationId] : [key.level, key.providerKey, key.externalKey],
  );
  return `catalog.promotion-target-${createHash("sha256").update(identity).digest("hex")}`;
}

export function sourceObservationTargetId(observationId: string): string {
  return `cat_source_${createHash("sha256").update(observationId).digest("hex")}`;
}

export function sourceObservationTargetKeys(source: SourceObservationState): readonly PromotionTargetKey[] {
  if (!source.id || !source.normalized || !source.providerKey || !source.externalKey) {
    throw new Error("promotion-target-invalid-source");
  }
  return [
    { level: "member", observationId: source.id },
    {
      level: "product",
      providerKey: source.providerKey,
      externalKey: sourceObservationLinkExternalKey(source.languageCode, source.externalKey),
    },
    ...(source.normalized.externalCatalogItemReferences ?? []).map((reference) => ({
      level: "item" as const,
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    })),
    ...(source.normalized.externalProductReferences ?? []).map((reference) => ({
      level: "product" as const,
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    })),
  ].map((key) => promotionTargetKeySchema.parse(key));
}
