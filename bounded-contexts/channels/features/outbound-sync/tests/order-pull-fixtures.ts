import {
  allocateOrderPullBudget,
  deriveOrderPullId,
  orderPullLawVersion,
  type OrderPullAuthority,
  type OrderPullPayload,
} from "../domain/order-pull";
import { orderPullCheckpointDigest, type OrderPullPage, type OrderPullProgress } from "../domain/order-pull-progress";

// Explicitly synthetic cursor authority. These fixtures qualify no provider surface.
export const syntheticAuthority: OrderPullAuthority = {
  revision: 3,
  lawVersion: orderPullLawVersion,
  selector: { identity: "synthetic-ready-to-ship-selector", version: 1, pageSize: 100, traversal: "snapshot-cursor" },
  nIntakeReadMax: 8,
  nListReadMax: 2,
  fMax: 5,
  providerCadenceMs: 10_000,
  providerCallTimeoutMs: 10_000,
  mappingJournalMs: 20_000,
  maxPostsPerOrder: 4,
  postTimeoutMs: 5_000,
  reportTimeoutMs: 10_000,
};

export function syntheticPayload(overrides: Partial<OrderPullPayload> = {}): OrderPullPayload {
  const pullId = deriveOrderPullId("connection_synthetic", 1);
  const checkpoint = {
    burstId: pullId,
    policyRevision: 3,
    selector: syntheticAuthority.selector,
    traversal: null,
    gapCount: 0,
    drained: false,
    followUpTail: false,
  };
  const budget = allocateOrderPullBudget(syntheticAuthority, 2, 0);
  if (budget.kind !== "fits") throw new Error("invalid synthetic fixture");
  return {
    kind: "order-pull",
    version: 2,
    connectionId: "connection_synthetic",
    pullId,
    policyRevision: 3,
    lawVersion: orderPullLawVersion,
    selector: syntheticAuthority.selector,
    bounds: budget.bounds,
    followUpReferences: [],
    checkpoint,
    checkpointDigest: orderPullCheckpointDigest(checkpoint),
    work: { chunkId: null, references: [], postedReferences: [], acceptedReferences: [] },
    predecessor: null,
    providerNotBefore: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

export function syntheticPage(
  orderReferences: readonly string[] = [],
  overrides: Partial<OrderPullPage> = {},
): OrderPullPage {
  return {
    sessionDigest: "a".repeat(64),
    frontier: "synthetic-frontier",
    cursor: null,
    nextCursor: null,
    totalOrders: orderReferences.length,
    orderReferences,
    everyRowReadyToShip: true,
    ...overrides,
  };
}
export function syntheticProgress(
  payload: OrderPullPayload,
  overrides: Partial<OrderPullProgress> = {},
): OrderPullProgress {
  return {
    previousDigest: payload.checkpointDigest,
    pages: [syntheticPage()],
    postedReferences: [],
    gaps: [],
    followUpTail: false,
    ...overrides,
  };
}
