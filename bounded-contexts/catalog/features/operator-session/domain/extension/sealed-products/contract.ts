import { z } from "zod";
import { tcgplayerSetNameUnits } from "../set-names/contract";

export const sealedProductLines = () =>
  tcgplayerSetNameUnits.flatMap((unit) => {
    const game = unit.unitKey.split(":")[1];
    const name =
      game === "mtg" ? "Magic" : game === "pokemon" ? "Pokemon" : game === "lorcana" ? "Disney Lorcana" : null;
    return name === null || unit.productLineId === null ? [] : [{ id: unit.productLineId, name }];
  });
export const sealedRequestMaxProducts = 12_000;

// Shared browser/server grammar. No provider response, price, or credential fields cross it.
// Issue: https://github.com/chase-sets/chase-sets/issues/10040
export const tcgplayerSealedProductObservationLimits = Object.freeze({
  maxPostBytes: 2 * 1024 * 1024,
  maxProducts: 24,
  maxSkus: 250,
  maxIdentifier: 2_147_483_647,
});

const identifier = z.number().int().min(1).max(tcgplayerSealedProductObservationLimits.maxIdentifier);
const label = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{C}\p{Zl}\p{Zp}]+$/u)
  .refine((value) => !/(?:TCGAuthTicket\s*=|\bBearer\s|\bCookie\s*:)/i.test(value));
const barcode = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[0-9]+$/);
const sku = z.strictObject({ sku: identifier, condition: label, variant: label, language: label });
const product = z.strictObject({
  productTypeName: label,
  rarityName: label,
  sealed: z.literal(true),
  productName: label,
  setId: identifier,
  setCode: label,
  productId: identifier,
  setName: label,
  productLineId: identifier,
  productStatusId: identifier,
  productLineName: label,
  customAttributes: z.strictObject({
    number: label.optional(),
    releaseDate: label.optional(),
    cardType: z.array(label).min(1).max(256).optional(),
    detailNote: label.optional(),
    barcode: barcode.optional(),
    gtin: barcode.optional(),
    upc: barcode.optional(),
    packCount: z
      .union([
        identifier,
        z
          .string()
          .min(1)
          .max(10)
          .regex(/^[0-9]+$/)
          .refine((value) => Number(value) >= 1 && Number(value) <= 2_147_483_647),
      ])
      .optional(),
  }),
  barcode: barcode.optional(),
  gtin: barcode.optional(),
  upc: barcode.optional(),
  formattedAttributes: z.strictObject({ Artist: label.optional() }).optional(),
  skus: z
    .array(sku)
    .min(1)
    .max(tcgplayerSealedProductObservationLimits.maxSkus)
    .refine((values) => new Set(values.map((value) => value.sku)).size === values.length),
});

const post = z
  .strictObject({
    contractVersion: z.literal(1),
    observedAt: z.iso.datetime({ precision: 3 }),
    products: z.array(product).min(1).max(tcgplayerSealedProductObservationLimits.maxProducts),
  })
  .refine(({ products }) => {
    const first = products[0]!;
    return (
      new Set(products.map((entry) => entry.productId)).size === products.length &&
      products.every(
        (entry) =>
          entry.productLineName === first.productLineName &&
          entry.productLineId === first.productLineId &&
          entry.setName === first.setName &&
          entry.setId === first.setId,
      )
    );
  });

export type TcgplayerSealedProductDetail = z.infer<typeof product>;
export type TcgplayerSealedProductObservationPost = z.infer<typeof post>;

export function parseTcgplayerSealedProductObservationPost(
  value: unknown,
): Readonly<{ ok: true; post: TcgplayerSealedProductObservationPost }> | Readonly<{ ok: false; code: "invalid-body" }> {
  const result = post.safeParse(value);
  return result.success ? { ok: true, post: result.data } : { ok: false, code: "invalid-body" };
}
