import { createHash } from "node:crypto";
import {
  acceptedReadyToShipInputByteLimit,
  acceptedReadyToShipReferenceLimit,
  assertAcceptedReadyToShipQuery,
} from "../../order-fulfillment-observations/domain/contracts";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";
import { OutboundSyncError } from "./contracts";
import type { OrderPullSelectorBinding } from "./order-pull";

// Codec limits, not additional governed authority fields or population limits.
export const orderPullChunkReferenceLimit = acceptedReadyToShipReferenceLimit;
export const orderPullChunkInputByteLimit = acceptedReadyToShipInputByteLimit;
export const orderPullProgressByteLimit = 1_048_576;

// Preliminary structural checks use the smallest admissible JSON ID overhead.
// Matching, owner reads and persistence still validate the actual connection's complete request.
const minimumConnectionId = "S";

export type OrderPullTraversal = Readonly<{
  sessionDigest: string;
  frontier: string;
  nextCursor: string | null;
  totalOrders: number | null;
  discovered: number;
  pages: number;
  exhausted: boolean;
}>;
export type OrderPullCheckpoint = Readonly<{
  burstId: string;
  policyRevision: number;
  selector: OrderPullSelectorBinding;
  traversal: OrderPullTraversal | null;
  gapCount: number;
  drained: boolean;
  followUpTail: boolean;
}>;
export type OrderPullWork = Readonly<{
  chunkId: number | null;
  references: readonly string[];
  postedReferences: readonly string[];
  acceptedReferences: readonly string[];
}>;
export type OrderPullPage = Readonly<{
  sessionDigest: string;
  frontier: string;
  cursor: string | null;
  nextCursor: string | null;
  totalOrders: number | null;
  orderReferences: readonly string[];
  everyRowReadyToShip: true;
}>;
export const orderPullGapReasons = ["unavailable", "unmappable", "status-raced"] as const;
export type OrderPullProgress = Readonly<{
  previousDigest: string;
  pages: readonly OrderPullPage[];
  postedReferences: readonly string[];
  gaps: readonly Readonly<{ reference: string; reason: (typeof orderPullGapReasons)[number] }>[];
  followUpTail: boolean;
}>;
export type OrderPullPredecessor = Readonly<{
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  checkpointDigest: string;
}>;

export function orderPullCheckpointDigest(checkpoint: OrderPullCheckpoint): string {
  return createHash("sha256").update(canonicalJson(checkpoint)).digest("hex");
}

export function assertOrderPullChunk(
  connectionId: string,
  orderReferences: unknown,
): asserts orderReferences is readonly string[] {
  try {
    // Checks both exported caps over the COMPLETE request, including JSON escaping and connection ID.
    assertAcceptedReadyToShipQuery({ connectionId, orderReferences });
  } catch {
    fail("Invalid accepted-owner reference chunk.");
  }
}

export function assertOrderPullWork(value: unknown, connectionId: string): asserts value is OrderPullWork {
  const work = record(value, ["chunkId", "references", "postedReferences", "acceptedReferences"]);
  if (work.chunkId !== null) integer(work.chunkId, 1);
  for (const key of ["references", "postedReferences", "acceptedReferences"] as const)
    assertOrderPullChunk(connectionId, work[key]);
  const references = work.references as readonly string[];
  if ((work.chunkId === null) !== (references.length === 0)) fail("Empty work has no chunk identity.");
  for (const key of ["postedReferences", "acceptedReferences"] as const) {
    if ((work[key] as readonly string[]).some((ref) => !references.includes(ref))) fail("Work membership mismatch.");
  }
}

export function assertOrderPullCheckpoint(value: unknown): asserts value is OrderPullCheckpoint {
  const checkpoint = record(value, [
    "burstId",
    "policyRevision",
    "selector",
    "traversal",
    "gapCount",
    "drained",
    "followUpTail",
  ]);
  if (typeof checkpoint.burstId !== "string" || !/^copl_[a-f0-9]{40}$/.test(checkpoint.burstId))
    fail("Invalid burst identity.");
  integer(checkpoint.policyRevision, 1);
  assertOrderPullSelector(checkpoint.selector);
  integer(checkpoint.gapCount, 0);
  boolean(checkpoint.drained);
  boolean(checkpoint.followUpTail);
  if (checkpoint.drained && checkpoint.followUpTail) fail("Due follow-up tail cannot drain.");
  if (checkpoint.traversal !== null) {
    const traversal = record(checkpoint.traversal, [
      "sessionDigest",
      "frontier",
      "nextCursor",
      "totalOrders",
      "discovered",
      "pages",
      "exhausted",
    ]);
    digest(traversal.sessionDigest);
    token(traversal.frontier);
    cursor(traversal.nextCursor);
    if (traversal.totalOrders !== null) integer(traversal.totalOrders, 0);
    integer(traversal.discovered, 0);
    integer(traversal.pages, 1);
    boolean(traversal.exhausted);
    if (traversal.exhausted !== (traversal.nextCursor === null)) fail("Invalid traversal terminal cursor.");
    if (
      traversal.totalOrders !== null &&
      (Number(traversal.discovered) > Number(traversal.totalOrders) ||
        (traversal.exhausted && traversal.discovered !== traversal.totalOrders))
    )
      fail("Traversal count mismatch.");
  }
  if (checkpoint.drained && (checkpoint.traversal === null || !(checkpoint.traversal as OrderPullTraversal).exhausted))
    fail("Unread traversal cannot drain.");
}

export function assertOrderPullProgress(value: unknown): asserts value is OrderPullProgress {
  const progress = record(value, ["previousDigest", "pages", "postedReferences", "gaps", "followUpTail"]);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > orderPullProgressByteLimit)
    fail("Progress byte limit exceeded.");
  digest(progress.previousDigest);
  boolean(progress.followUpTail);
  if (!Array.isArray(progress.pages) || progress.pages.length > 2) fail("Invalid page allocation.");
  for (const value of progress.pages) {
    const page = record(value, [
      "sessionDigest",
      "frontier",
      "cursor",
      "nextCursor",
      "totalOrders",
      "orderReferences",
      "everyRowReadyToShip",
    ]);
    digest(page.sessionDigest);
    token(page.frontier);
    cursor(page.cursor);
    cursor(page.nextCursor);
    if (page.totalOrders !== null) integer(page.totalOrders, 0);
    assertOrderPullChunk(minimumConnectionId, page.orderReferences);
    if (page.everyRowReadyToShip !== true) fail("Unqualified page rows.");
  }
  assertOrderPullChunk(minimumConnectionId, progress.postedReferences);
  if (!Array.isArray(progress.gaps) || progress.gaps.length > orderPullChunkReferenceLimit) fail("Invalid gaps.");
  for (const value of progress.gaps) {
    const gap = record(value, ["reference", "reason"]);
    assertOrderPullChunk(minimumConnectionId, [gap.reference]);
    if (!orderPullGapReasons.includes(gap.reason as never)) fail("Invalid qualified gap.");
  }
  const gaps = progress.gaps as OrderPullProgress["gaps"];
  const posted = progress.postedReferences as readonly string[];
  if (
    new Set(gaps.map((gap) => gap.reference)).size !== gaps.length ||
    gaps.some((gap) => posted.includes(gap.reference))
  )
    fail("Duplicate disposition.");
}

export function assertOrderPullPredecessor(value: unknown): asserts value is OrderPullPredecessor | null {
  if (value === null) return;
  const predecessor = record(value, ["operationId", "attemptId", "claimGeneration", "checkpointDigest"]);
  token(predecessor.operationId);
  token(predecessor.attemptId);
  integer(predecessor.claimGeneration, 1);
  digest(predecessor.checkpointDigest);
}

/** One qualified page advances only its frozen traversal. Global uniqueness is fenced by the coordinator ledger. */
export function advanceOrderPullTraversal(
  selector: OrderPullSelectorBinding,
  previous: OrderPullTraversal | null,
  page: OrderPullPage,
): OrderPullTraversal {
  assertOrderPullSelector(selector);
  assertOrderPullProgress({
    previousDigest: "0".repeat(64),
    pages: [page],
    postedReferences: [],
    gaps: [],
    followUpTail: false,
  });
  const size = page.orderReferences.length;
  if (
    size > selector.pageSize ||
    previous?.exhausted ||
    page.cursor !== (previous?.nextCursor ?? null) ||
    (page.nextCursor !== null && (page.nextCursor === page.cursor || size === 0)) ||
    (size === selector.pageSize && page.nextCursor === null)
  )
    fail("Traversal cannot advance or full page lacks continuation.");
  if (
    previous &&
    (page.sessionDigest !== previous.sessionDigest ||
      page.frontier !== previous.frontier ||
      page.totalOrders !== previous.totalOrders)
  )
    fail("Frozen traversal changed.");
  const discovered = (previous?.discovered ?? 0) + size;
  const pages = (previous?.pages ?? 0) + 1;
  integer(discovered, 0);
  integer(pages, 1);
  const exhausted = page.nextCursor === null;
  if (page.totalOrders !== null && (discovered > page.totalOrders || (exhausted && discovered !== page.totalOrders)))
    fail("Independent total mismatch.");
  return {
    sessionDigest: page.sessionDigest,
    frontier: page.frontier,
    nextCursor: page.nextCursor,
    totalOrders: page.totalOrders,
    discovered,
    pages,
    exhausted,
  };
}

export function assertOrderPullSelector(value: unknown): asserts value is OrderPullSelectorBinding {
  const selector = record(value, ["identity", "version", "pageSize", "traversal"]);
  if (typeof selector.identity !== "string" || !/^[a-z0-9][a-z0-9./-]{0,127}$/.test(selector.identity))
    fail("Invalid selector identity.");
  integer(selector.version, 1);
  integer(selector.pageSize, 1);
  if (
    Number(selector.pageSize) > orderPullChunkReferenceLimit ||
    (selector.traversal !== "snapshot-cursor" && selector.traversal !== "keyset-frontier")
  )
    fail("Unqualified traversal authority.");
}

export function orderPullProgressKind(
  input: Readonly<{ exhausted: boolean; unread: boolean; pending: boolean; followUpTail: boolean; gapCount: number }>,
) {
  if (!input.exhausted || input.unread || input.followUpTail) return "continuation-required" as const;
  if (input.pending) return "order-pull-pending" as const;
  return input.gapCount > 0 ? ("order-pull-gaps" as const) : ("order-pull-complete" as const);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected a closed progress object.");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    fail("Invalid progress fields.");
  return result;
}
function integer(value: unknown, min: number) {
  if (!Number.isSafeInteger(value) || Number(value) < min) fail("Invalid progress integer.");
}
function boolean(value: unknown) {
  if (typeof value !== "boolean") fail("Invalid progress flag.");
}
function digest(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("Invalid progress digest.");
}
function token(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/=-]{1,512}$/.test(value)) fail("Invalid opaque traversal token.");
}
function cursor(value: unknown) {
  if (value !== null) token(value);
}
function fail(message: string): never {
  throw new OutboundSyncError("invalid-input", message);
}
