import type { ChannelSaleLineV1 } from "../../publication-port/domain/contracts";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { assertClosedRecord, assertRfc3339Instant } from "../../connections/domain/validation";

export const tcgplayerOrderLimits = { lines: 500, pages: 1000, orders: 100000, bytes: 262144 } as const;
export type TcgplayerSaleLine = Readonly<{
  productId: string | null;
  skuId: string | null;
  quantity: number;
  unitPriceAmount: string;
}>;
export type TcgplayerOrderObservation = Readonly<{
  version: 1;
  kind: "order";
  pullId: string;
  orderNumber: string;
  soldAt: string;
  cancelled: boolean;
  lines: readonly TcgplayerSaleLine[];
}>;
export type TcgplayerPullSummary = Readonly<{
  version: 1;
  kind: "summary";
  pullId: string;
  totalOrders: number;
  pages: readonly Readonly<{ offset: number; count: number; totalOrders: number }>[];
  range: Readonly<{ from: string; to: string }>;
  filter: "all" | "unshipped" | "shipped";
  completion: "complete" | "unknown";
  unknownReason: "page-cap" | "detail-missing" | "pagination-drift" | "request-failed" | null;
}>;
export type TcgplayerOrderRecord = TcgplayerOrderObservation | TcgplayerPullSummary;

export function assertTcgplayerOrderRecord(value: unknown): asserts value is TcgplayerOrderRecord {
  assertClosedRecord(
    value,
    [
      "version",
      "kind",
      "pullId",
      "orderNumber",
      "soldAt",
      "cancelled",
      "lines",
      "totalOrders",
      "pages",
      "range",
      "filter",
      "completion",
      "unknownReason",
    ],
    "order record",
  );
  if (value.kind === "order") {
    assertClosedRecord(value, ["version", "kind", "pullId", "orderNumber", "soldAt", "cancelled", "lines"], "order");
    text(value.orderNumber);
    assertRfc3339Instant(value.soldAt);
    if (
      typeof value.cancelled !== "boolean" ||
      !Array.isArray(value.lines) ||
      value.lines.length > tcgplayerOrderLimits.lines
    )
      invalid();
    for (const line of value.lines) {
      assertClosedRecord(line, ["productId", "skuId", "quantity", "unitPriceAmount"], "sale line");
      numericId(line.productId);
      numericId(line.skuId);
      integer(line.quantity, 1, 1000000);
      if (typeof line.unitPriceAmount !== "string" || !/^(0|[1-9]\d{0,9})\.\d{2}$/.test(line.unitPriceAmount))
        invalid();
    }
  } else {
    assertClosedRecord(
      value,
      ["version", "kind", "pullId", "totalOrders", "pages", "range", "filter", "completion", "unknownReason"],
      "pull summary",
    );
    if (value.kind !== "summary") invalid();
    integer(value.totalOrders, 0, tcgplayerOrderLimits.orders);
    if (!Array.isArray(value.pages) || value.pages.length > tcgplayerOrderLimits.pages) invalid();
    for (const page of value.pages) {
      assertClosedRecord(page, ["offset", "count", "totalOrders"], "pull page");
      integer(page.offset, 0, tcgplayerOrderLimits.orders);
      integer(page.count, 0, tcgplayerOrderLimits.orders);
      integer(page.totalOrders, 0, tcgplayerOrderLimits.orders);
    }
    assertClosedRecord(value.range, ["from", "to"], "pull range");
    assertRfc3339Instant(value.range.from);
    assertRfc3339Instant(value.range.to);
    if (Date.parse(value.range.from) > Date.parse(value.range.to)) invalid();
    if (!["all", "unshipped", "shipped"].includes(String(value.filter))) invalid();
    if (value.completion === "complete") {
      if (value.unknownReason !== null) invalid();
    } else if (
      value.completion !== "unknown" ||
      !["page-cap", "detail-missing", "pagination-drift", "request-failed"].includes(String(value.unknownReason))
    )
      invalid();
  }
  if (value.version !== 1) invalid();
  text(value.pullId);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > tcgplayerOrderLimits.bytes) invalid();
}

export async function composeTcgplayerOrderInbound(record: TcgplayerOrderRecord) {
  assertTcgplayerOrderRecord(record);
  const snapshot = structuredClone(record);
  const basis =
    snapshot.kind === "order"
      ? ["tcgplayer-order-admission/v1", snapshot.pullId, snapshot.orderNumber, snapshot]
      : ["tcgplayer-pull-summary/v1", snapshot.pullId, snapshot];
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(basis)))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    inboundKind: "order" as const,
    externalReference: `${snapshot.kind === "order" ? "tcgo" : "tcgp"}.v1:${digest}`,
    payload: { version: 1 as const, records: [snapshot] },
  };
}

export function tcgplayerSaleKey(
  accountId: string,
  connectionId: string,
  orderNumber: string,
  line: TcgplayerSaleLine,
): ChannelSaleLineV1["saleKey"] {
  if (line.productId === null || line.skuId === null) invalid();
  return {
    version: "v1",
    providerKey: "tcgplayer",
    sellerEnvironmentLineage: JSON.stringify(["tcgplayer-connector/v1", accountId, connectionId]),
    orderLineIdentity: JSON.stringify(["tcgplayer-order-line/v1", orderNumber, line.productId, line.skuId]),
  };
}

export function ambiguousLineIndexes(order: TcgplayerOrderObservation): ReadonlySet<number> {
  const keys = order.lines.map((line) => JSON.stringify([line.productId, line.skuId]));
  return new Set(
    order.lines.flatMap((line, index) =>
      line.productId === null || line.skuId === null || keys.indexOf(keys[index]!) !== keys.lastIndexOf(keys[index]!)
        ? [index]
        : [],
    ),
  );
}

export function pullSummaryGap(summary: TcgplayerPullSummary): string | null {
  if (summary.completion !== "complete") return summary.unknownReason;
  if (summary.pages.length === 0) return "missing-page";
  let offset = 0;
  const seen = new Set<number>();
  for (const page of summary.pages) {
    if (
      seen.has(page.offset) ||
      page.offset !== offset ||
      page.totalOrders !== summary.totalOrders ||
      (page.count === 0 && summary.totalOrders !== 0)
    )
      return "pagination-drift";
    seen.add(page.offset);
    offset += page.count;
  }
  return offset === summary.totalOrders ? null : "missing-page";
}

function numericId(value: unknown) {
  if (value !== null && (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value))) invalid();
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid();
}
function integer(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid();
}
function invalid(): never {
  throw new Error("invalid-tcgplayer-order-record");
}
