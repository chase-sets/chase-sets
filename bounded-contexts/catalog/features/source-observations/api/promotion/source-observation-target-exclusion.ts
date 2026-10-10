import { isDeepStrictEqual } from "node:util";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import { resolveLocalizedTextMap } from "../../../../support/runtime-support/common";
import type { CatalogItemId } from "../../../../ids";
import {
  decideCatalogItem,
  evolveCatalogItem,
  initialCatalogItemState,
  type CatalogItemEvent,
  type CatalogItemState,
} from "../../../catalog-items/domain/domain";
import type { SourceObservationDetailRow } from "../../read-model/queries";
import type { CatalogProviderIntegrationProfileVersionReader } from "../source-observation-runtime-contracts";
import {
  loadCatalogItemPromotionProfile,
  previewCatalogItemPromotionPlan,
  requireCatalogItemPromotionObservation,
  requireSourceObservationMappingContract,
} from "../source-observation-promotion-execution";
import { catalogProviderSourceMappingFingerprint } from "./provider-source-observation-normalizer";
import {
  foldPromotionTargetSource,
  locatedPromotionSourceTargets,
  type PromotionTargetDiscovery,
} from "./promotion-target-discovery";
import {
  promotionTargetKeyIdentity,
  sourceObservationTargetId,
  sourceObservationTargetKeys,
} from "./promotion-target-identity";
import type {
  PromotionTargetAuthority,
  PromotionTargetExclusion,
  PromotionTargetSession,
} from "./promotion-target-exclusion";
import type { CatalogPromotionCurrentItem } from "./promotion-display-identity";
import { guardPromotionMaterial } from "./promotion-material-guards";
import { canonicalPromotionReferenceText } from "./promotion-reference-canonicalization";

export function promotionCurrentItem(state: CatalogItemState): CatalogPromotionCurrentItem | null {
  if (!state.id) return null;
  return {
    catalog_item_id: state.id,
    language_code: state.languageCode,
    status: state.status,
    title: resolveLocalizedTextMap(state.title, state.languageCode),
    subtitle: state.subtitle ? resolveLocalizedTextMap(state.subtitle, state.languageCode) : null,
    blueprint_id: state.blueprintId,
    field_values: state.fieldValues,
    category_ids: state.categoryIds,
  };
}

export async function acquireSourceObservationTarget(input: {
  deps: CatalogRuntimeDeps;
  boundary: PromotionTargetExclusion;
  observation: SourceObservationDetailRow;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  selectedTargetId: CatalogItemId | null;
  expectedBlueprintId: string;
  context: EventStoreContext;
  validateAuthority: PromotionTargetAuthority;
}): Promise<PromotionTargetSession> {
  const sourceHistory = await readCompleteStream(input.deps.eventStore, {
    streamId: `catalog.source-observation-${input.observation.observation_id}`,
  });
  const source = foldPromotionTargetSource(input.observation.observation_id, sourceHistory).state;
  if (
    !isDeepStrictEqual(source.normalized, input.observation.normalized) ||
    source.providerKey !== input.observation.provider_key ||
    source.externalKey !== input.observation.external_key ||
    source.status !== input.observation.status ||
    source.promotedCatalogItemId !== input.observation.promoted_catalog_item_id
  ) {
    throw new Error("promotion-target-source-projection-outdated");
  }
  const fallback = sourceObservationTargetId(source.id!);
  const incomingKeys = sourceObservationTargetKeys(source);
  const productOptions = new Map<string, unknown>();
  for (const reference of source.normalized!.externalProductReferences ?? []) {
    const identity = promotionTargetKeyIdentity({
      level: "product",
      providerKey: reference.providerKey,
      externalKey: reference.externalKey,
    });
    const options = reference.selectedOptions ?? [];
    if (productOptions.has(identity) && !isDeepStrictEqual(productOptions.get(identity), options))
      throw new Error("promotion-target-product-options-conflict");
    productOptions.set(identity, options);
  }
  return input.boundary.acquire({
    keys: incomingKeys,
    additionalTargetIds: [...new Set([fallback, ...(input.selectedTargetId ? [input.selectedTargetId] : [])])],
    context: input.context,
    validateAuthority: input.validateAuthority,
    selectTarget: async (evidence, guard) => {
      const reread = evidence.sources.get(source.id!)?.state;
      if (!isDeepStrictEqual(source, reread)) throw new Error("promotion-target-source-changed");
      const candidates = new Set<string>();
      const ownedKeys = new Set([...evidence.keys.keys()]);
      for (const binding of evidence.bindings.values()) if (binding) candidates.add(binding.targetId);
      for (const [id, item] of evidence.items) {
        const ownsKey = [
          ...item.externalCatalogItemReferences.map((key) => ({
            level: "item" as const,
            providerKey: key.providerKey,
            externalKey: key.externalKey,
          })),
          ...item.externalProductReferences.map((key) => ({
            level: "product" as const,
            providerKey: key.providerKey,
            externalKey: key.externalKey,
          })),
        ].some((key) => ownedKeys.has(promotionTargetKeyIdentity(key)));
        if (ownsKey) candidates.add(id);
      }
      for (const retained of evidence.sources.values()) {
        const located = locatedPromotionSourceTargets(evidence, retained);
        for (const id of located) {
          const item = evidence.items.get(id);
          if (!item?.id) {
            if (retained.revisions.some((revision) => revision.promotedCatalogItemId === id))
              throw new Error("promotion-target-missing-recorded-target");
            continue;
          }
          if (item.status !== "active" && item.status !== "draft") throw new Error("promotion-target-inactive");
          const proof = await proveRetainedCreate(input, evidence, retained.revisions, id, guard);
          if (
            proof === "prefix" &&
            (retained.state.id !== source.id ||
              id !== fallback ||
              (input.selectedTargetId && input.selectedTargetId !== id))
          )
            throw new Error("promotion-target-retained-prefix");
          candidates.add(id);
        }
      }
      if (candidates.size > 1) throw new Error("promotion-target-ambiguous");
      const winner = [...candidates][0];
      if (winner && input.selectedTargetId && winner !== input.selectedTargetId)
        throw new Error("promotion-target-bound-elsewhere");
      const target = winner ?? input.selectedTargetId ?? fallback;
      const state = evidence.items.get(target);
      if (!state) throw new Error("promotion-target-missing-target-evidence");
      if (state.id && state.status !== "draft" && state.status !== "active")
        throw new Error("promotion-target-inactive");
      if (
        state.id &&
        (state.languageCode !== source.languageCode ||
          (state.blueprintId !== input.expectedBlueprintId && !(target === fallback && state.blueprintId === null)))
      )
        throw new Error("promotion-target-incompatible-item");
      for (const reference of source.normalized!.externalProductReferences ?? []) {
        const linked = state.externalProductReferences.find(
          (candidate) =>
            canonicalPromotionReferenceText(candidate.providerKey) ===
              canonicalPromotionReferenceText(reference.providerKey) &&
            canonicalPromotionReferenceText(candidate.externalKey) ===
              canonicalPromotionReferenceText(reference.externalKey),
        );
        if (linked && !isDeepStrictEqual(linked.selectedOptions ?? [], reference.selectedOptions ?? []))
          throw new Error("promotion-target-product-options-conflict");
      }
      return target;
    },
  });
}

async function proveRetainedCreate(
  input: Parameters<typeof acquireSourceObservationTarget>[0],
  evidence: PromotionTargetDiscovery,
  revisions: readonly ReturnType<typeof foldPromotionTargetSource>["state"][],
  targetId: string,
  guard: PromotionTargetSession["guard"],
): Promise<"complete" | "prefix"> {
  const history = evidence.histories.get(`catalog.item-${targetId}`)!;
  const item = evidence.items.get(targetId)!;
  const codec = createPassthroughDomainEventCodec<CatalogItemEvent>();
  const actual = history.map(codec.decode);
  const validated = [];
  for (const source of revisions) {
    const available = await input.profileVersions.listProfileVersions(source.providerKey);
    const sourceVersions = available.filter(
      (version) =>
        version.profileKey === source.sourceProfileKey && version.profileVersion === source.sourceProfileVersion,
    );
    if (
      sourceVersions.length !== 1 ||
      catalogProviderSourceMappingFingerprint(requireSourceObservationMappingContract(sourceVersions[0])) !==
        source.sourceMappingFingerprint
    )
      throw new Error("promotion-target-source-fingerprint-conflict");
    const versions = available.filter(
      (version) =>
        version.profileKey === (source.promotionProfileKey ?? source.sourceProfileKey) &&
        version.profileVersion === (source.promotionProfileVersion ?? source.sourceProfileVersion),
    );
    if (versions.length !== 1) throw new Error("promotion-target-missing-profile-evidence");
    const version = versions[0];
    if (!version || !source.normalized || !source.sourceMappingFingerprint)
      throw new Error("promotion-target-missing-profile-evidence");
    validated.push({
      source,
      version,
      normalized: requireCatalogItemPromotionObservation(source.normalized, source.providerKey),
    });
  }
  for (const { source, version, normalized } of validated.reverse()) {
    const catalogMapping = await loadCatalogItemPromotionProfile(input.deps, version.profile);
    await guardPromotionMaterial({
      deps: input.deps,
      session: { guard },
      profile: version.profile,
      mapping: catalogMapping,
      normalized,
    });
    const plan = await previewCatalogItemPromotionPlan({
      deps: input.deps,
      catalogItemId: targetId as CatalogItemId,
      mode: "create",
      normalized,
      providerKey: source.providerKey,
      externalKey: source.externalKey,
      providerProfile: version.profile,
      providerProfileVersion: version,
      catalogMapping,
      productAssetSet: item.productAssetSets[0] ?? null,
      promoteAsDraft: false,
    });
    if (plan.status !== "planned") throw new Error("promotion-target-retained-plan-unresolved");
    let state = initialCatalogItemState;
    const expected: CatalogItemEvent[] = [];
    for (const [index, command] of plan.plan.commands.entries()) {
      const events = decideCatalogItem(state, command);
      state = events.reduce(evolveCatalogItem, state);
      expected.push(...events);
      if (actual.length === expected.length && isDeepStrictEqual(actual, expected))
        return index === plan.plan.commands.length - 1 ? "complete" : "prefix";
    }
    if (actual.length >= expected.length && isDeepStrictEqual(actual.slice(0, expected.length), expected))
      return "complete";
    if (!source.promotedCatalogItemId || source.promotedCatalogItemId === targetId) {
      const refresh = await previewCatalogItemPromotionPlan({
        deps: input.deps,
        catalogItemId: targetId as CatalogItemId,
        mode: "refresh",
        normalized,
        providerKey: source.providerKey,
        externalKey: source.externalKey,
        providerProfile: version.profile,
        providerProfileVersion: version,
        catalogMapping: await loadCatalogItemPromotionProfile(input.deps, version.profile),
        productAssetSet: item.productAssetSets[0] ?? null,
        currentItem: promotionCurrentItem(item),
        promoteAsDraft: false,
      });
      if (refresh.status === "planned") {
        const after = refresh.plan.commands.reduce(
          (state, command) => decideCatalogItem(state, command).reduce(evolveCatalogItem, state),
          item,
        );
        if (
          isDeepStrictEqual(after, item) &&
          (!source.promotionPlanFingerprint || source.promotionPlanFingerprint === refresh.plan.planFingerprint)
        )
          return "complete";
      }
    }
  }
  throw new Error("promotion-target-retained-history-conflict");
}
