import {
  ProviderWriteRefused,
  isPaymentCreateWriter,
  providerWriteIdempotencyKey,
  requireProviderWrite,
  type EvidenceWindowProviderWrite,
  type PaymentCreateRejection,
  type ProviderWriteBinding,
  type ProviderWriteCorrelation,
  type ProviderWriteEnvelope,
  type ProviderWriteWindow,
  type ProviderCancelGovernance,
  type ProviderWriteRow,
} from "@chase-sets/evidence-window-provider-write";
import { providerWriteDigest, validateProviderMaterial } from "@chase-sets/evidence-window-provider-write/material";
import { ProviderAdapterError, type ProviderFailureCategory } from "@chase-sets/http/provider-errors";

export class PaymentCreateRejected extends ProviderAdapterError {
  constructor(
    readonly rejection: PaymentCreateRejection,
    message = "Payment create was rejected by the provider.",
    category: ProviderFailureCategory = "provider_declined",
  ) {
    super(category, message, rejection.status);
    this.name = "PaymentCreateRejected";
  }
}

export async function readPaymentCreateRejection(
  journal: EvidenceWindowProviderWrite,
  originalWireKey: string,
): Promise<PaymentCreateRejection | null> {
  const match = /^evidence-window\/v1:([0-9a-f]{32}):[1-6]:([1-9][0-9]?):(?:create|dispose)$/.exec(originalWireKey);
  if (!match || Number(match[2]) > 64) return null;
  const rows = await journal.readWindow(match[1]!);
  return (
    rows.find((row) => row.state === "failed" && providerWriteIdempotencyKey(row.key) === originalWireKey)?.rejection ??
    null
  );
}

export type GovernedProviderWriteOptions = Readonly<{
  evidenceWindowCorrelation?: ProviderWriteCorrelation;
  evidenceWindowProviderWrite?: EvidenceWindowProviderWrite;
  savedResponseUsability?: (row: ProviderWriteRow) => Promise<"qualified-unused" | "consumed" | "unqualified">;
}>;

export async function executeGovernedProviderWrite<T>(
  options: GovernedProviderWriteOptions,
  input: Readonly<{
    window?: ProviderWriteWindow;
    binding: ProviderWriteBinding;
    envelope: ProviderWriteEnvelope;
    governance?: ProviderCancelGovernance | undefined;
    send: (envelope: ProviderWriteEnvelope, idempotencyKey: string) => Promise<T>;
    retrieve: (reference: string) => Promise<T>;
    response: (response: T) => Readonly<{ reference: string | null; expiresAt?: string | null; captured?: boolean }>;
    definitiveFailure: (error: unknown) => boolean;
  }>,
): Promise<T> {
  const journal = options.evidenceWindowProviderWrite;
  const current = await options.evidenceWindowCorrelation?.currentOpenWindow();
  const window = input.window ?? current;
  if (!window || !journal) throw new ProviderWriteRefused("window-ineligible");
  validateProviderMaterial(input.binding, input.envelope);
  const reservation = await journal.reserveOrResolve({
    windowId: window.windowId,
    binding: input.binding,
    envelope: input.envelope,
    retentionSeconds: 3600,
    ...(input.governance?.kind === "governed" ? { originalKey: input.governance.rowKey } : {}),
  });
  let row = requireProviderWrite(reservation);
  const key = providerWriteIdempotencyKey(row.key);
  const paymentCreate = isPaymentCreateWriter(input.binding.writerKind);
  if (
    input.governance?.kind === "governed" &&
    (providerWriteIdempotencyKey(input.governance.rowKey) !== key ||
      input.governance.idempotencyKey !== key ||
      input.governance.expectedVersion !== row.version)
  ) {
    throw new ProviderWriteRefused("binding-drift");
  }
  if (row.state === "succeeded") {
    if (row.key.objectClass === 6) {
      // Actual saved-response usability must be qualified before activation.
      requireProviderWrite(
        await journal.admitSavedResponse(
          row.key,
          {
            ...input.binding,
            usability: (await options.savedResponseUsability?.(row)) ?? "unqualified",
          },
          new Date().toISOString(),
        ),
      );
      if (!row.envelope || (await providerWriteDigest(row.envelope)) !== row.digest)
        throw new ProviderWriteRefused("unsafe-material");
      validateProviderMaterial(input.binding, row.envelope);
      try {
        return await input.send(row.envelope, key);
      } catch {
        throw new ProviderWriteRefused("write-unresolved");
      }
    } else if (row.providerReference) {
      let response: T;
      try {
        response = await input.retrieve(row.providerReference);
      } catch {
        throw new ProviderWriteRefused("write-unresolved");
      }
      if (
        row.key.objectClass === 2 &&
        row.key.operation === "create" &&
        row.observedClass !== 1 &&
        input.response(response).captured
      ) {
        requireProviderWrite(await journal.observeCapture(row.key, row.version));
      }
      return response;
    } else throw new ProviderWriteRefused("write-unresolved");
  } else if (row.state !== "pending") {
    if (paymentCreate && row.state === "failed" && row.rejection) throw new PaymentCreateRejected(row.rejection);
    throw new ProviderWriteRefused(row.state === "failed" ? "write-failed" : "write-unresolved");
  }
  if (row.state === "pending" && reservation.kind === "existing") {
    row = requireProviderWrite(await journal.claimReplay(row.key, row.version, new Date().toISOString()));
  }
  if (
    !row.envelope ||
    !row.digest ||
    (await providerWriteDigest(row.envelope)) !== row.digest ||
    (await providerWriteDigest(input.envelope)) !== row.digest
  )
    throw new ProviderWriteRefused("unsafe-material");
  validateProviderMaterial(input.binding, row.envelope);
  // reserveOrResolve distinguishes the first committed send from uncertainty recovery.
  // The caller must not reconstruct the form between this check and send.
  let response: T;
  if (Date.now() >= Date.parse(row.replayDeadline)) throw new ProviderWriteRefused("replay-expired");
  try {
    response = await input.send(row.envelope, key);
  } catch (error) {
    if (paymentCreate) {
      if (error instanceof PaymentCreateRejected) {
        requireProviderWrite(
          await journal.complete(row.key, row.version, { state: "failed", rejection: error.rejection }),
        );
        throw error;
      }
    } else if (input.definitiveFailure(error)) {
      requireProviderWrite(await journal.complete(row.key, row.version, { state: "failed" }));
    }
    throw new ProviderWriteRefused("write-unresolved");
  }
  const metadata = input.response(response);
  const completed = requireProviderWrite(
    await journal.complete(row.key, row.version, {
      state: "succeeded",
      providerReference: metadata.reference,
      responseExpiresAt: metadata.expiresAt ?? null,
    }),
  );
  if (metadata.captured && completed.key.objectClass === 2 && completed.key.operation === "create") {
    requireProviderWrite(await journal.observeCapture(completed.key, completed.version));
  }
  return response;
}
