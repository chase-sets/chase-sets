export type ProviderObjectClass = 1 | 2 | 3 | 4 | 5 | 6;
export type ProviderWriterKind =
  | "customer"
  | "setup-embedded"
  | "setup-hosted"
  | "payment-saved"
  | "payment-checkout"
  | "payment-agentic"
  | "cancel-payment"
  | "cancel-setup"
  | "connect-setup"
  | "connect-manage"
  | "connect-notification";

export type ProviderWriteKey = Readonly<{
  windowId: string;
  objectClass: ProviderObjectClass;
  creationOrdinal: number;
  operation: "create" | "dispose";
}>;

export type ProviderWriteWindow = Readonly<{ windowId: string; expiresAt: string }>;
export type ProviderWriteCorrelation = Readonly<{
  currentOpenWindow: () => Promise<ProviderWriteWindow | null>;
}>;

export type ProviderWriteBinding = Readonly<{
  writerKind: ProviderWriterKind;
  logicalOperationId: string;
  ownerAccountId: string;
}>;

export type ProviderWriteEnvelope = Readonly<{
  bodyKind: "absent" | "form";
  bodyText: string | null;
  method: "POST";
  endpoint: string;
  target: string | null;
  accountScope: "platform" | "connected";
  connectedAccountReference: string | null;
  apiVersion: string;
}>;

/** Private recovery data. Never include this value in logs, public results or events. */
export type ProviderWriteRow = Readonly<{
  key: ProviderWriteKey;
  binding: ProviderWriteBinding;
  envelope: ProviderWriteEnvelope | null;
  digest: string | null;
  state: "pending" | "succeeded" | "failed" | "ambiguous";
  version: number;
  observedClass: ProviderObjectClass | null;
  reusedExisting: boolean;
  replayAttempts: 0 | 1;
  logicalSlot: 1 | 2 | 3 | null;
  providerReference: string | null;
  responseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  replayDeadline: string;
}>;

export type ProviderWriteRefusalCode =
  | "invalid-identity"
  | "unsafe-material"
  | "binding-drift"
  | "window-ineligible"
  | "ordinal-exhausted"
  | "unknown-write"
  | "write-unresolved"
  | "write-failed"
  | "replay-expired"
  | "response-unqualified"
  | "storage-failed";

export type ProviderWriteResult =
  | Readonly<{ kind: "reserved" | "existing"; row: ProviderWriteRow }>
  | Readonly<{ kind: "stale-write-rejected" }>
  | Readonly<{ kind: "refused"; code: ProviderWriteRefusalCode }>;

export type ReserveProviderWrite = Readonly<{
  windowId: string;
  binding: ProviderWriteBinding;
  envelope: ProviderWriteEnvelope;
  retentionSeconds: number;
  originalKey?: ProviderWriteKey;
}>;

export type ProviderWriteCompletion =
  | Readonly<{ state: "succeeded"; providerReference: string | null; responseExpiresAt?: string | null }>
  | Readonly<{ state: "failed" | "ambiguous" }>;

export type EvidenceWindowProviderWrite = Readonly<{
  reserveOrResolve: (input: ReserveProviderWrite) => Promise<ProviderWriteResult>;
  complete: (
    key: ProviderWriteKey,
    expectedVersion: number,
    result: ProviderWriteCompletion,
  ) => Promise<ProviderWriteResult>;
  observeCustomerReuse: (
    input: Readonly<{
      windowId: string;
      ownerAccountId: string;
      providerReference: string;
      retentionSeconds: number;
    }>,
  ) => Promise<ProviderWriteResult>;
  observeCapture: (key: ProviderWriteKey, expectedVersion: number) => Promise<ProviderWriteResult>;
  claimReplay: (key: ProviderWriteKey, expectedVersion: number, now: string) => Promise<ProviderWriteResult>;
  admitSavedResponse: (
    key: ProviderWriteKey,
    binding: ProviderWriteBinding &
      Readonly<{
        usability: "qualified-unused" | "consumed" | "unqualified";
      }>,
    now: string,
  ) => Promise<ProviderWriteResult>;
  readWindow: (windowId: string) => Promise<readonly ProviderWriteRow[]>;
}>;

export type ProviderCancelGovernance =
  | Readonly<{ kind: "ungoverned" }>
  | Readonly<{
      kind: "governed";
      rowKey: ProviderWriteKey;
      expectedVersion: number;
      idempotencyKey: string;
    }>;

export function providerWriteIdempotencyKey(key: ProviderWriteKey): string {
  return `evidence-window/v1:${key.windowId}:${key.objectClass}:${key.creationOrdinal}:${key.operation}`;
}

export class ProviderWriteRefused extends Error {
  constructor(readonly code: ProviderWriteRefusalCode | "stale-write-rejected") {
    super(`evidence-window-provider-write:${code}`);
    this.name = "ProviderWriteRefused";
  }
}

export function requireProviderWrite(result: ProviderWriteResult): ProviderWriteRow {
  if (result.kind === "refused") throw new ProviderWriteRefused(result.code);
  if (result.kind === "stale-write-rejected") throw new ProviderWriteRefused(result.kind);
  return result.row;
}

export const GOVERNED_RETURN_ORIGIN = "https://marketplace.staging.chasesets.com";
export const GOVERNED_SETUP_PATH = "/account/payment-methods";

export function providerWriteUtf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function admitGovernedSetupInput(
  input: Readonly<{
    returnUrlBase?: string | null;
    returnUrlPath?: string | null;
    rawReturnUrl?: string;
  }>,
): void {
  if (
    input.returnUrlBase !== GOVERNED_RETURN_ORIGIN ||
    (input.returnUrlPath != null && input.returnUrlPath !== "" && input.returnUrlPath !== GOVERNED_SETUP_PATH) ||
    (input.rawReturnUrl !== undefined &&
      (providerWriteUtf8Length(input.rawReturnUrl) > 4096 ||
        input.rawReturnUrl !== `${GOVERNED_RETURN_ORIGIN}${GOVERNED_SETUP_PATH}`))
  )
    throw new ProviderWriteRefused("unsafe-material");
}

export function admitGovernedPaymentInput(
  input: Readonly<{
    returnUrlBase?: string | null;
    returnUrlPath?: string | null;
  }>,
  paymentId: string,
): void {
  const path = input.returnUrlPath;
  const accepted = ["/account/payments/", "/checkout/payments/"].some((prefix) =>
    [encodeURIComponent(paymentId), ":paymentId", "{paymentId}"].some((id) => path === `${prefix}${id}`),
  );
  if (input.returnUrlBase !== GOVERNED_RETURN_ORIGIN || (path != null && path !== "" && !accepted)) {
    throw new ProviderWriteRefused("unsafe-material");
  }
}
