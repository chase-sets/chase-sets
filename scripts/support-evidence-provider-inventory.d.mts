import type { PrivateObjectStore } from "@chase-sets/object-storage";
import type { createLegacyReferenceReconstruction } from "../bounded-contexts/platform-operations/features/support-requests/api/legacy-reference-reconstruction";

export declare function dryRun(input: {
  storage: Pick<PrivateObjectStore, "listPrivate">;
  legacy: Pick<ReturnType<typeof createLegacyReferenceReconstruction>, "reconstruct">;
  options: {
    environment: string;
    implementationSha: string;
    imageDigest: string;
    boundaryReceiptId: string | null;
    snapshotReceiptId: string | null;
    horizon: string | null;
    requestCap: number;
    requestCostUpperBoundUsd: number;
  };
}): Promise<{
  manifest: Record<string, unknown>;
  receipt: { result: "retention" | "approval-required" };
}>;
