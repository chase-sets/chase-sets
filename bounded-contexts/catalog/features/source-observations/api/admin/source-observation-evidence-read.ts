import { resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchSourceObservationEvidenceDetail } from "./primary-workbench-admin-contracts";
import type { SourceObservationListItem } from "../../ui/contracts";
import {
  sourceObservationEvidenceDetailFor,
  type ProductContentsEvidenceConfig,
} from "../../ui/primary-workbench-source-observation-review";

export type ProductContentsEvidenceLabelRows = Readonly<{
  contentTypes: readonly Readonly<{ content_type_id: string; key: string; display_name: LocalizedTextMap }>[];
  inclusionPolicies: readonly Readonly<{ inclusion_policy_id: string; key: string; display_name: LocalizedTextMap }>[];
}>;

/** A content type or inclusion policy is labelled by its English name, or its key without one. */
export function productContentsEvidenceConfigFor(
  rows: ProductContentsEvidenceLabelRows,
): ProductContentsEvidenceConfig {
  return {
    contentTypeLabelsById: new Map(
      rows.contentTypes.map((type) => [type.content_type_id, resolveLocalizedTextMap(type.display_name) || type.key]),
    ),
    inclusionPolicyLabelsById: new Map(
      rows.inclusionPolicies.map((policy) => [
        policy.inclusion_policy_id,
        resolveLocalizedTextMap(policy.display_name) || policy.key,
      ]),
    ),
  };
}

/**
 * The evidence sheet of one Source Observation: its facts, duplicates, conflicts and audit,
 * its promotion readiness and command disposition for this actor, and each Product contents
 * line's state, labelled from the Catalog's content types and inclusion policies.
 */
export function sourceObservationEvidenceFor(input: {
  observation: SourceObservationListItem;
  canManage: boolean;
  labels: ProductContentsEvidenceLabelRows | null;
}): CatalogPrimaryWorkbenchSourceObservationEvidenceDetail {
  return sourceObservationEvidenceDetailFor(input.observation, {
    canManage: input.canManage,
    productContentsConfig: input.labels ? productContentsEvidenceConfigFor(input.labels) : {},
  });
}
