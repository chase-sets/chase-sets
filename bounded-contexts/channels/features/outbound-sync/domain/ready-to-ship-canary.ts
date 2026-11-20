import { assertClosedRecord } from "../../connections/domain/validation";
import { assertTcgplayerOrderRecord, type TcgplayerOrderObservation } from "../../tcgplayer-orders/domain/contracts";
import type { OrderPullAuthority } from "./order-pull-codec";

const pageClaimPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const salePrefix = "ready-to-ship-canary:";
export const canaryReservationPrefix = "cor_canary_";
export const canaryMaxOrders = 3;
export const canaryLifetimeMs = 300_000;
export const canaryAuthority = {
  revision: 1,
  lawVersion: "ready-to-ship-intake/v2",
  selector: { identity: "sealed-ready-to-ship-page", version: 1, pageSize: 500, traversal: "snapshot-cursor" },
  nIntakeReadMax: canaryMaxOrders,
  nListReadMax: 1,
  fMax: 0,
  providerCadenceMs: 1,
  providerCallTimeoutMs: 1,
  mappingJournalMs: 20_000,
  maxPostsPerOrder: 3,
  postTimeoutMs: 5_000,
  reportTimeoutMs: 10_000,
} as const satisfies OrderPullAuthority;

export type CanaryHandoff = Readonly<{
  pageClaim: string;
  sealDigest: string;
  finishedAt: string;
  expiresAt: string;
  target: Readonly<{ connectionId: string; pairingId: string }>;
  sales: readonly TcgplayerOrderObservation[];
}>;

export const canarySalePullId = (pageClaim: string) => `${salePrefix}${pageClaim}`;
export function canaryPageClaim(pullId: unknown): string | null {
  return isCanarySalePullId(pullId) ? pullId.slice(salePrefix.length) : null;
}
export function isCanarySalePullId(pullId: unknown): pullId is string {
  return typeof pullId === "string" && pullId.startsWith(salePrefix);
}

export function assertCanaryHandoff(value: unknown): asserts value is CanaryHandoff {
  assertClosedRecord(
    value,
    ["pageClaim", "sealDigest", "finishedAt", "expiresAt", "target", "sales"],
    "canary handoff",
  );
  assertClosedRecord(value.target, ["connectionId", "pairingId"], "canary target");
  if (
    typeof value.pageClaim !== "string" ||
    !pageClaimPattern.test(value.pageClaim) ||
    typeof value.sealDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sealDigest) ||
    ![value.target.connectionId, value.target.pairingId].every(
      (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    ) ||
    !instant(value.finishedAt) ||
    !instant(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.finishedAt) ||
    Date.parse(value.expiresAt) - Date.parse(value.finishedAt) > canaryLifetimeMs ||
    !Array.isArray(value.sales) ||
    value.sales.length < 1 ||
    value.sales.length > canaryMaxOrders
  )
    invalid();
  const seen = new Set<string>();
  for (const sale of value.sales) {
    assertTcgplayerOrderRecord(sale);
    if (
      sale.kind !== "order" ||
      sale.pullId !== canarySalePullId(value.pageClaim) ||
      sale.cancelled ||
      !sale.lines.length ||
      seen.has(sale.orderNumber)
    )
      invalid();
    seen.add(sale.orderNumber);
  }
}

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function invalid(): never {
  throw new Error("invalid-canary-handoff");
}
