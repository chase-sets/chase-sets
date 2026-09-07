import type {
  CommittedExternalChannelSalePayload,
  ExternalChannelSaleKeyV1Payload,
} from "@chase-sets/event-core/public-event-payloads";

export type ExternalChannelSaleKeyV1 = ExternalChannelSaleKeyV1Payload;

export type RecordExternalChannelSaleCommand = Readonly<{
  accountId: string;
  inventoryItemId: string;
  storageLocationId: string;
  saleKey: ExternalChannelSaleKeyV1;
  requestedQuantity: number;
  unitPriceAmount?: string;
  currencyCode?: string;
  soldAt?: string;
  connectionAuditReference?: string;
}>;

export type ExternalChannelSaleConflictField =
  | "accountId"
  | "inventoryItemId"
  | "storageLocationId"
  | "requestedQuantity"
  | "unitPriceAmount"
  | "currencyCode"
  | "soldAt"
  | "collisionPolicyRef"
  | "collisionPolicyRevision"
  | "reasonCode";

export type CommittedExternalChannelSale = CommittedExternalChannelSalePayload;

export type RecordExternalChannelSaleResult = Readonly<{
  status: "committed";
  sale: CommittedExternalChannelSale;
}>;

export type RecordExternalChannelSaleConflict = Readonly<{
  code: "external-channel-sale-conflict";
  saleKey: ExternalChannelSaleKeyV1;
  saleStreamId: string;
  existingFingerprint: string;
  incomingFingerprint: string;
  differingFields: readonly ExternalChannelSaleConflictField[];
}>;

export type ExternalChannelSaleHistoryFailureReason =
  | "empty-existing-stream"
  | "unknown-event"
  | "unsupported-event-version"
  | "duplicate-terminal"
  | "wrong-order-or-version"
  | "trailing-event"
  | "key-stream-mismatch"
  | "target-or-profile-mismatch"
  | "malformed-result"
  | "quantity-law-failure"
  | "stored-fingerprint-mismatch";

export type ExternalChannelSaleHistoryFailure = Readonly<{
  code: "external-channel-sale-history-invalid";
  saleStreamId: string;
  reason: ExternalChannelSaleHistoryFailureReason;
  eventIndex: number | null;
}>;

export type RecordExternalChannelSaleOutcome =
  | RecordExternalChannelSaleResult
  | RecordExternalChannelSaleConflict
  | ExternalChannelSaleHistoryFailure;

export type RecordExternalChannelSale = (
  command: RecordExternalChannelSaleCommand,
) => Promise<RecordExternalChannelSaleOutcome>;
