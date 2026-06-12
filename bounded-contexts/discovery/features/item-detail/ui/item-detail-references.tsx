import { t } from "@chase-sets/localization";
import { ReferenceInfoDialog, ReferenceInfoTrigger } from "@chase-sets/design-system";
import type { DiscoveryReferenceRecordRef } from "../../../support/client-support/contracts";
import { formatFieldValue, formatReferenceAttributes, formatRelationshipType } from "../domain/item-detail-market";
import { formatReferenceTypeLabel, type ReferenceDetailRow } from "./reference-detail-rows";

export function ReferenceValueCue({
  row,
  onSelectReference,
}: {
  row: ReferenceDetailRow;
  onSelectReference: (reference: DiscoveryReferenceRecordRef) => void;
}) {
  if (!row.reference) {
    return <>{formatFieldValue(row.value)}</>;
  }

  return (
    <ReferenceInfoTrigger
      onClick={() => onSelectReference(row.reference!)}
      aria-label={t("discovery.features.itemDetail.ui.itemDetailPage.reference.value.aria", {
        label: row.label,
        value: row.reference.name,
      })}
    >
      {row.reference.name}
    </ReferenceInfoTrigger>
  );
}

export function ReferenceDetailDialog({
  reference,
  onOpenChange,
}: {
  reference: DiscoveryReferenceRecordRef | null;
  onOpenChange: (open: boolean) => void;
}) {
  if (!reference) {
    return null;
  }

  const attributes = formatReferenceAttributes(reference.attributes);
  const relationships = reference.relationships.map((relationship) => ({
    key: formatRelationshipType(relationship.relationshipType),
    value: relationship.reference?.name ?? relationship.referenceId,
  }));

  return (
    <ReferenceInfoDialog
      open
      onOpenChange={onOpenChange}
      title={reference.name}
      description={formatReferenceTypeLabel(reference.typeKey)}
      closeLabel={t("discovery.features.itemDetail.ui.itemDetailPage.close.reference.detail")}
      sections={[
        {
          items: [
            {
              key: t("discovery.features.itemDetail.ui.itemDetailPage.reference.type"),
              value: formatReferenceTypeLabel(reference.typeKey),
            },
            {
              key: t("discovery.features.itemDetail.ui.itemDetailPage.reference.status"),
              value: reference.status,
            },
            {
              key: t("discovery.features.itemDetail.ui.itemDetailPage.reference.key"),
              value: reference.key,
            },
          ],
        },
        {
          title: t("discovery.features.itemDetail.ui.itemDetailPage.reference.attributes"),
          items: attributes,
          emptyState: t("discovery.features.itemDetail.ui.itemDetailPage.reference.no.attributes"),
        },
        {
          title: t("discovery.features.itemDetail.ui.itemDetailPage.reference.relationships"),
          items: relationships,
          emptyState: t("discovery.features.itemDetail.ui.itemDetailPage.reference.no.relationships"),
        },
      ]}
    />
  );
}
