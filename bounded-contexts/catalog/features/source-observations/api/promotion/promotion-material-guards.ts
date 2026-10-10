import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import { evolveBlueprint, initialBlueprintState } from "../../../blueprints/domain/domain";
import { evolveCategory, initialCategoryState } from "../../../categories/domain/domain";
import { evolveField, initialFieldState } from "../../../fields/domain/domain";
import {
  resolvePromotionReferenceHierarchyReadOnly,
  type CatalogItemPromotableSourceObservationNormalized,
} from "../source-observation-promotion-reference-hierarchy";
import type { CatalogProviderIntegrationProfile } from "../provider-integration-profiles";
import type { CatalogProviderPromotionResolvedCatalogMapping } from "./provider-promotion-command-planner";
import type { PromotionTargetSession } from "./promotion-target-exclusion";

export async function guardPromotionMaterial(input: {
  deps: CatalogRuntimeDeps;
  session: Pick<PromotionTargetSession, "guard">;
  profile: CatalogProviderIntegrationProfile;
  mapping: CatalogProviderPromotionResolvedCatalogMapping;
  normalized: CatalogItemPromotableSourceObservationNormalized;
}): Promise<void> {
  async function guard<S extends { id: string | null; key: string | null; status: string }, E extends DomainEvent>(
    streamId: string,
    key: string,
    initial: S,
    evolve: AggregateEvolver<S, E>,
  ) {
    const events = await readCompleteStream(input.deps.eventStore, { streamId });
    const state = events.map(createPassthroughDomainEventCodec<E>().decode).reduce(evolve, initial);
    if (!state.id || !streamId.endsWith(`-${state.id}`) || state.key !== key || state.status !== "active")
      throw new Error(`promotion-target-invalid-material:${streamId}`);
    input.session.guard(streamId, events.at(-1)?.streamVersion ?? 0);
  }
  await guard(
    `catalog.blueprint-${input.mapping.blueprintId}`,
    input.profile.catalogFieldMapping.blueprintKey,
    initialBlueprintState,
    evolveBlueprint,
  );
  await guard(
    `catalog.category-${input.mapping.categoryId}`,
    input.profile.catalogFieldMapping.categoryKey,
    initialCategoryState,
    evolveCategory,
  );
  for (const [name, id] of Object.entries(input.mapping.fieldIds)) {
    const key =
      name === "inkColor"
        ? "ink-color"
        : input.profile.catalogFieldMapping.fieldKeys[name as keyof typeof input.profile.catalogFieldMapping.fieldKeys];
    if (!key) throw new Error(`promotion-target-missing-field-key:${name}`);
    await guard(`catalog.field-${id}`, key, initialFieldState, evolveField);
  }
  const deps: CatalogRuntimeDeps = {
    ...input.deps,
    eventStore: {
      ...input.deps.eventStore,
      async readStream(request) {
        const events = await input.deps.eventStore.readStream(request);
        if (events.length < (request.limit ?? 500))
          input.session.guard(request.streamId, events.at(-1)?.streamVersion ?? (request.fromVersion ?? 1) - 1);
        return events;
      },
    },
  };
  await resolvePromotionReferenceHierarchyReadOnly({ deps, profile: input.profile, normalized: input.normalized });
}
