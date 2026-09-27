import {
  ProviderWriteRefused,
  providerWriteIdempotencyKey,
  requireProviderWrite,
  type EvidenceWindowProviderWrite,
  type ProviderWriteBinding,
  type ProviderWriteCorrelation,
  type ProviderWriteEnvelope,
  type ProviderWriteWindow,
  type ProviderCancelGovernance,
  type ProviderWriteRow,
} from "@chase-sets/evidence-window-provider-write";
import { providerWriteDigest, validateProviderMaterial } from "@chase-sets/evidence-window-provider-write/material";

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
    governance?: ProviderCancelGovernance;
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
      // #6734 must qualify actual saved-response usability before activation.
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
    if (input.definitiveFailure(error))
      requireProviderWrite(await journal.complete(row.key, row.version, { state: "failed" }));
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
