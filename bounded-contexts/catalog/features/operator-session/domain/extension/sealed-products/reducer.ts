import { z } from "zod";
import {
  parseTcgplayerSealedProductObservationPost,
  tcgplayerSealedProductObservationLimits as limits,
  type TcgplayerSealedProductDetail,
  type TcgplayerSealedProductObservationPost,
} from "./contract";
import { sealedProductLines, validSealedSelection, type SealedSelection } from "./collector";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = z.number().int().min(1).max(2_147_483_647);
// The provider shape is checked independently before the closed Catalog grammar.
// Object schemas deliberately project only catalog facts, dropping prices at every depth.
const providerDetail = z.object({
  productTypeName: z.string(),
  rarityName: z.string(),
  sealed: z.boolean(),
  productName: z.string(),
  setId: identifier,
  setCode: z.string(),
  productId: identifier,
  setName: z.string(),
  productLineId: identifier,
  productStatusId: identifier,
  productLineName: z.string(),
  customAttributes: z.object({
    number: z.string().optional(),
    releaseDate: z.string().optional(),
    cardType: z.array(z.string()).optional(),
    detailNote: z.string().optional(),
    barcode: z.string().optional(),
    gtin: z.string().optional(),
    upc: z.string().optional(),
    packCount: z.union([identifier, z.string()]).optional(),
  }),
  barcode: z.string().optional(),
  gtin: z.string().optional(),
  upc: z.string().optional(),
  formattedAttributes: z.object({ Artist: z.string().optional() }).optional(),
  skus: z
    .array(z.object({ sku: identifier, condition: z.string(), variant: z.string(), language: z.string() }))
    .min(1)
    .max(limits.maxSkus),
});
export function reduceSealedProducts(
  details: unknown[],
  selection: SealedSelection,
  observedAt: string,
): TcgplayerSealedProductObservationPost[] | null {
  if (!validSealedSelection(selection)) return null;
  const products: TcgplayerSealedProductDetail[] = [];
  for (const entry of details) {
    if (!object(entry) || !object(entry.body)) return null;
    if (Object.hasOwn(entry.body, "errors") && (!Array.isArray(entry.body.errors) || entry.body.errors.length !== 0))
      return null;
    const decoded = providerDetail.safeParse(entry.body);
    if (!decoded.success) return null;
    const body = decoded.data;
    if (
      body.productId !== entry.productId ||
      body.productLineId !== selection.productLineId ||
      body.productLineName !== sealedProductLines().find((line) => line.id === selection.productLineId)?.name ||
      body.setId !== selection.setId ||
      body.setName !== selection.setName
    )
      return null;
    const reduced = {
      ...body,
      // Validate single-card detail fields too, but never post them.
      sealed: true,
    };
    const parsed = parseTcgplayerSealedProductObservationPost({ contractVersion: 1, observedAt, products: [reduced] });
    if (!parsed.ok) return null;
    if (body.sealed) products.push(parsed.post.products[0]!);
  }
  if (new Set(products.map((product) => product.productId)).size !== products.length) return null;
  const posts: TcgplayerSealedProductObservationPost[] = [];
  for (const product of products) {
    let post = posts.at(-1);
    if (
      !post ||
      post.products.length === limits.maxProducts ||
      new TextEncoder().encode(JSON.stringify({ ...post, products: [...post.products, product] })).byteLength >
        limits.maxPostBytes
    ) {
      post = { contractVersion: 1, observedAt, products: [] };
      posts.push(post);
    }
    post.products.push(product);
    if (
      !parseTcgplayerSealedProductObservationPost(post).ok ||
      new TextEncoder().encode(JSON.stringify(post)).byteLength > limits.maxPostBytes
    )
      return null;
  }
  return posts;
}
