import { assertTcgplayerOrderRecord, type TcgplayerOrderObservation } from "./contracts";

// Select only captured detail facts. List totals, transactions and addresses cannot author sale lines.
export function composeTcgplayerOrderObservation(pullId: string, detail: unknown): TcgplayerOrderObservation {
  const source = object(detail);
  if (
    !Array.isArray(source.products) ||
    typeof source.createdAt !== "string" ||
    typeof source.orderNumber !== "string" ||
    typeof source.status !== "string"
  )
    invalid();
  const record: TcgplayerOrderObservation = {
    version: 1,
    kind: "order",
    pullId,
    orderNumber: source.orderNumber,
    soldAt: source.createdAt,
    cancelled: source.status === "Canceled",
    lines: source.products.map((value) => {
      const product = object(value);
      if (
        typeof product.quantity !== "number" ||
        typeof product.unitPrice !== "number" ||
        !Number.isFinite(product.unitPrice) ||
        product.unitPrice < 0 ||
        Math.abs(product.unitPrice * 100 - Math.round(product.unitPrice * 100)) > 0.000001
      )
        invalid();
      return {
        productId: numericId(product.productId),
        skuId: numericId(product.skuId),
        quantity: product.quantity,
        unitPriceAmount: product.unitPrice.toFixed(2),
      };
    }),
  };
  assertTcgplayerOrderRecord(record);
  return record;
}
function numericId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d{1,20}$/.test(value) && BigInt(value) > 0n) return BigInt(value).toString();
  invalid();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function invalid(): never {
  throw new Error("invalid-tcgplayer-order-detail");
}
