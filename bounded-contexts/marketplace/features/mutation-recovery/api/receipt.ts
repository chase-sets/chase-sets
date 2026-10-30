import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  attachResponseMetadata,
  encodeCommitReceipt,
  getMutationResultCommandReceipt,
} from "@chase-sets/http/responses";

export function marketplaceReceiptHeaders(value: unknown): Headers {
  const receipt = getMutationResultCommandReceipt(value);
  const headers = new Headers();
  if (receipt) {
    headers.set("Chase-Sets-Consistency", receipt.mode);
    if (receipt.commitPosition) headers.set("Chase-Sets-Commit-Position", receipt.commitPosition);
    headers.set("Chase-Sets-Commit-Event-Ids", receipt.commitEventIds.join(","));
    headers.set("Chase-Sets-Commit-Receipt", encodeCommitReceipt(receipt.commitPositions));
  }
  return headers;
}

export function withMarketplaceAttemptReceipt<T>(value: T, event: StoredEvent): T {
  // The attempt is the final participant in the atomic append, after all business facts.
  return attachResponseMetadata(value, {
    headers: new Headers({
      "Chase-Sets-Consistency": "eventual",
      "Chase-Sets-Commit-Position": event.globalPosition,
      "Chase-Sets-Commit-Event-Ids": event.eventId,
      "Chase-Sets-Commit-Receipt": encodeCommitReceipt([
        { sourceContextName: "marketplace", maxGlobalPosition: event.globalPosition, eventIds: [event.eventId] },
      ]),
    }),
  });
}

export function marketplaceReceiptResponse(response: Response, value: unknown): Response {
  marketplaceReceiptHeaders(value).forEach((header, name) => response.headers.set(name, header));
  return response;
}
