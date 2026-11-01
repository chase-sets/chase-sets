import {
  canonicalMarketplaceRequest,
  marketplaceAcceptanceKeySchema,
  marketplaceAttemptIdSchema,
  marketplaceCanonicalRequest,
  marketplaceMutationRecoveryResultSchema,
  marketplaceRecoveryTargetKind,
  type MarketplaceMutationKind,
  type MarketplaceMutationRecoveryResult,
} from "../domain/contracts";
import {
  attachResponseMetadata,
  getMutationResultCommandReceipt,
  encodeCommitReceipt,
} from "@chase-sets/http/responses";

type MarketplaceCommandPhase = "editing" | "submitting" | "confirming" | "succeeded" | "failed-safe" | "ambiguous";

export class MarketplaceCommandRecoveryError extends Error {
  constructor(
    public readonly phase: "failed-safe" | "ambiguous",
    public readonly cause?: unknown,
  ) {
    super(
      phase === "failed-safe"
        ? "The command was not sent."
        : "The result could not be confirmed. Do not submit this action again.",
    );
    this.name = "MarketplaceCommandRecoveryError";
  }
}

export async function marketplaceRequestHash(value: unknown): Promise<string> {
  return hashText(canonicalMarketplaceRequest(value));
}

async function hashText(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recoverMarketplaceCommand<T>(input: {
  attemptId: string;
  mutationKind: MarketplaceMutationKind;
  /** Null for seller-account kinds, whose target is the signed-in account the owner binds. */
  target: string | null;
  request: Record<string, unknown>;
  send: () => Promise<T>;
  lookup: (requestHash: string) => Promise<unknown>;
  isCommandResponse: (error: unknown) => boolean;
  resolveReceipt?: (receipt: { id: string; version: number }) => Promise<T>;
  onPhase?: (phase: MarketplaceCommandPhase) => void;
}): Promise<T | { id: string; version: number }> {
  const parser = input.mutationKind === "offer.accept" ? marketplaceAcceptanceKeySchema : marketplaceAttemptIdSchema;
  if (!parser.safeParse(input.attemptId).success) {
    input.onPhase?.("failed-safe");
    throw new MarketplaceCommandRecoveryError("failed-safe");
  }
  let requestHash: string;
  try {
    requestHash = await marketplaceRequestHash(marketplaceCanonicalRequest(input.mutationKind, input.request));
  } catch (error) {
    input.onPhase?.("failed-safe");
    throw new MarketplaceCommandRecoveryError("failed-safe", error);
  }
  input.onPhase?.("submitting");
  try {
    const result = await input.send();
    input.onPhase?.("succeeded");
    return result;
  } catch (error) {
    if (input.isCommandResponse(error)) {
      input.onPhase?.("failed-safe");
      throw error;
    }
    input.onPhase?.("confirming");
    let recovery: MarketplaceMutationRecoveryResult | null = null;
    let observed: unknown;
    try {
      observed = await input.lookup(requestHash);
      recovery = marketplaceMutationRecoveryResultSchema.parse(observed);
    } catch {
      /* One owner lookup only. */
    }
    const fingerprint = recovery
      ? input.mutationKind === "offer.accept"
        ? await hashText(input.attemptId)
        : await marketplaceRequestHash([
            recovery.actorBinding.accountId,
            input.mutationKind,
            recovery.target,
            input.attemptId,
          ])
      : null;
    if (
      recovery?.ownerStatus === "committed" &&
      recovery.ownerReceipt &&
      recovery.mutationKind === input.mutationKind &&
      recovery.attemptKeyFingerprint === fingerprint &&
      recovery.target.id === (input.target ?? recovery.actorBinding.accountId) &&
      recovery.target.kind === marketplaceRecoveryTargetKind(input.mutationKind) &&
      recovery.canonicalRequestHash === requestHash
    ) {
      const metadata = getMutationResultCommandReceipt(observed);
      const receipt = metadata
        ? attachResponseMetadata(recovery.ownerReceipt, {
            headers: new Headers({
              "Chase-Sets-Consistency": metadata.mode,
              "Chase-Sets-Commit-Receipt": encodeCommitReceipt(metadata.commitPositions),
              ...(metadata.commitPosition ? { "Chase-Sets-Commit-Position": metadata.commitPosition } : {}),
              "Chase-Sets-Commit-Event-Ids": metadata.commitEventIds.join(","),
            }),
          })
        : recovery.ownerReceipt;
      input.onPhase?.("succeeded");
      return input.resolveReceipt ? input.resolveReceipt(receipt) : receipt;
    }
    input.onPhase?.("ambiguous");
    throw new MarketplaceCommandRecoveryError("ambiguous", error);
  }
}
