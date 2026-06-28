import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
  getMutationResultCommandReceipt,
  type FreshWriteReceipt,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
export { createPaymentsApiClient, PaymentsApiError, paymentsApi } from "../../client";
export type {
  PaymentsAccountOrderInput,
  PaymentsApiClientOptions,
  PaymentsPaymentDetail,
  PaymentsSavedCheckoutInstrument,
} from "../../client";
export { normalizeRequestedBalanceCreditAmount } from "../../features/payments/api/balance-credit-request";
import { createPaymentsApiClient } from "../../client";

export type PaymentsRequestApiClientOptions = Readonly<{
  headers?: HeadersInit;
  afterWriteSource?: unknown;
  nowMs?: number;
}>;

function maxCommitPosition(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(right) > BigInt(left) ? right : left;
}

function mergeCommitPositions(positions: readonly SourceCommitPosition[]) {
  const sources = new Map<string, SourceCommitPosition>();
  for (const position of positions) {
    const current = sources.get(position.sourceContextName);
    if (!current) {
      sources.set(position.sourceContextName, {
        sourceContextName: position.sourceContextName,
        maxGlobalPosition: position.maxGlobalPosition,
        eventIds: [...position.eventIds],
      });
      continue;
    }

    sources.set(position.sourceContextName, {
      sourceContextName: position.sourceContextName,
      maxGlobalPosition:
        maxCommitPosition(current.maxGlobalPosition, position.maxGlobalPosition) ?? position.maxGlobalPosition,
      eventIds: [...new Set([...current.eventIds, ...position.eventIds])],
    });
  }

  return [...sources.values()].sort((left, right) => left.sourceContextName.localeCompare(right.sourceContextName));
}

function freshWriteReceiptFromAfterWriteSource(source: unknown, nowMs: number): FreshWriteReceipt | null {
  const receipt = getMutationResultCommandReceipt(source);
  if (!receipt) {
    return null;
  }

  const sources = mergeCommitPositions(receipt.commitPositions ?? []);
  if (!receipt.commitPosition && sources.length === 0) {
    return null;
  }

  return {
    observedAtMs: nowMs,
    ...(receipt.commitPosition ? { commitPosition: receipt.commitPosition } : {}),
    sources,
  };
}

export function hasPaymentsFreshReadAfterWriteSource(source: unknown): boolean {
  return freshWriteReceiptFromAfterWriteSource(source, Date.now()) !== null;
}

export function createPaymentsRequestApiHeaders(
  options: PaymentsRequestApiClientOptions = {},
): HeadersInit | undefined {
  const receipt = freshWriteReceiptFromAfterWriteSource(options.afterWriteSource, options.nowMs ?? Date.now());
  if (!options.headers && !receipt) {
    return undefined;
  }

  const headers = new Headers(options.headers);
  if (receipt && !headers.has(CHASE_SETS_READ_AFTER_WRITE_HEADER)) {
    headers.set(CHASE_SETS_READ_AFTER_WRITE_HEADER, encodeFreshWriteReceipt(receipt));
  }
  if (receipt && !headers.has(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)) {
    headers.set(CHASE_SETS_READ_TARGET_CONTEXT_HEADER, "payments");
  }

  return headers;
}

export function createPaymentsRequestApiClient(request: Request, options: PaymentsRequestApiClientOptions = {}) {
  return createPaymentsApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "payments" }),
    headers: createPaymentsRequestApiHeaders(options),
  });
}
