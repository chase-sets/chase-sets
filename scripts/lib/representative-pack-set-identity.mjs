import { createHash } from "node:crypto";
import { stableStringify } from "../../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";

export function buildRepresentativeAcceptedPackSetIdentity(acceptedPacks) {
  return createHash("sha256")
    .update(
      stableStringify(
        acceptedPacks.map(({ packId, packVersion, manifestKey, captureContentHash }) => ({
          packId,
          packVersion,
          manifestKey,
          captureContentHash,
        })),
      ),
    )
    .digest("hex");
}
