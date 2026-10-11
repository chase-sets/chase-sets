import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import {
  resolvePromotionReferenceHierarchyReadOnly,
  type CatalogItemPromotableSourceObservationNormalized,
} from "../source-observation-promotion-reference-hierarchy";
import type { CatalogProviderIntegrationProfile } from "../provider-integration-profiles";
import type { CatalogProviderPromotionResolvedCatalogMapping } from "./provider-promotion-command-planner";
import type { PromotionTargetSession } from "./promotion-target-exclusion";

export const promotionProfileAuthorityLock = "LOCK TABLE catalog_provider_integration_profile_versions IN SHARE MODE";

export function promotionMaterialCategory(streamId: string) {
  if (streamId.startsWith("catalog.source-observation-")) return "source";
  // Item histories include empty targets and negative unlink/inactive evidence.
  if (streamId.startsWith("catalog.item-")) return "item";
  if (streamId.startsWith("catalog.promotion-target-")) return "binding";
  if (streamId.startsWith("catalog.reference-type-") || streamId.startsWith("catalog.reference-record-"))
    return "reference-authority";
  throw new Error(`promotion-target-outside-material-set:${streamId}`);
}

export function buildPromotionMaterialGuards(
  versions: ReadonlyMap<string, number>,
  context: EventStoreContext,
): readonly AppendToStreamInput[] {
  return [...versions]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([streamId, version]) => {
      promotionMaterialCategory(streamId);
      if (!Number.isSafeInteger(version) || version < 0) throw new Error("promotion-target-invalid-guard");
      return { streamId, expectedVersion: version, events: [], context };
    });
}

export async function guardPromotionMaterial(input: {
  deps: CatalogRuntimeDeps;
  session: Pick<PromotionTargetSession, "guard">;
  profile: CatalogProviderIntegrationProfile;
  mapping: CatalogProviderPromotionResolvedCatalogMapping;
  normalized: CatalogItemPromotableSourceObservationNormalized;
}): Promise<void> {
  const versions = new Map<string, number>();
  const deps: CatalogRuntimeDeps = {
    ...input.deps,
    eventStore: {
      ...input.deps.eventStore,
      async readStream(request) {
        promotionMaterialCategory(request.streamId);
        const events = await input.deps.eventStore.readStream(request);
        versions.set(
          request.streamId,
          Math.max(versions.get(request.streamId) ?? 0, events.at(-1)?.streamVersion ?? 0),
        );
        return events;
      },
    },
  };
  const resolved = await resolvePromotionReferenceHierarchyReadOnly({
    deps,
    profile: input.profile,
    normalized: input.normalized,
  });
  // The Yu-Gi-Oh! lookup resolves a projected id without folding it; fence that
  // actual selected reference too, without inventing a selection-generation owner.
  for (const id of Object.values(resolved.referenceRecordIdsByTypeKey)) {
    const streamId = `catalog.reference-record-${id}`;
    if (!versions.has(streamId)) await readCompleteStream(deps.eventStore, { streamId });
  }
  for (const [streamId, version] of versions) input.session.guard(streamId, version);
}
