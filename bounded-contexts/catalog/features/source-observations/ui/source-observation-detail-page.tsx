import { t } from "@chase-sets/localization";
import { useState } from "react";
import { Button, Inline, KeyValueList, Stack, TextInput } from "@chase-sets/design-system";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import {
  promoteSourceObservation,
  rejectSourceObservation,
  useSourceObservation,
} from "./use-source-observations";

export function SourceObservationDetailPage({
  id,
  initialData,
}: {
  id: string;
  initialData?: Parameters<typeof useSourceObservation>[1];
}) {
  const { data, loading, error, refresh } = useSourceObservation(id, initialData);
  const { addToast } = useToasts();
  const [rejectReason, setRejectReason] = useState("");

  async function handlePromote() {
    await promoteSourceObservation(id);
    addToast(t("catalog.features.sourceObservations.ui.detail.promoted"), "success");
    refresh();
  }

  async function handleReject() {
    await rejectSourceObservation(
      id,
      rejectReason || t("catalog.features.sourceObservations.ui.detail.rejected.reason"),
    );
    addToast(t("catalog.features.sourceObservations.ui.detail.rejected"), "success");
    refresh();
  }

  return (
    <EntityDetailPage
      title={data?.normalized.name ?? t("catalog.features.sourceObservations.ui.detail.source.observation")}
      breadcrumbs={[
        {
          label: t("catalog.features.sourceObservations.ui.detail.source.observations"),
          href: "/source-observations",
        },
        { label: data?.normalized.name ?? id },
      ]}
      actions={
        data?.status === "observed" ? (
          <Inline gap={2}>
            <Button size="sm" onClick={handlePromote}>{t("catalog.features.sourceObservations.ui.detail.promote")}</Button>
            <Button tone="danger" size="sm" onClick={handleReject}>{t("catalog.features.sourceObservations.ui.detail.reject")}</Button>
          </Inline>
        ) : undefined
      }
      loading={loading}
      notFound={!loading && !data}
      error={error}
    >
      {data && (
        <Stack gap={4}>
          {data.normalized.imageUrls[1] && (
            <img
              alt={t("catalog.features.sourceObservations.ui.detail.card.image")}
              src={data.normalized.imageUrls[1]}
              style={{ width: 180, maxWidth: "100%", borderRadius: 8 }}
            />
          )}
          <KeyValueList
            items={[
              { key: t("catalog.features.sourceObservations.ui.detail.status"), value: data.status },
              { key: t("catalog.features.sourceObservations.ui.detail.provider"), value: data.provider_key },
              { key: t("catalog.features.sourceObservations.ui.detail.external.key"), value: data.external_key },
              { key: t("catalog.features.sourceObservations.ui.detail.language"), value: data.language_code },
              { key: t("catalog.features.sourceObservations.ui.detail.set"), value: data.normalized.setName },
              { key: t("catalog.features.sourceObservations.ui.detail.card.number"), value: data.normalized.cardNumber },
              { key: t("catalog.features.sourceObservations.ui.detail.rarity"), value: data.normalized.rarity ?? "—" },
              { key: t("catalog.features.sourceObservations.ui.detail.artist"), value: data.normalized.illustrator ?? "—" },
              { key: t("catalog.features.sourceObservations.ui.detail.release.date"), value: data.normalized.releaseDate ?? "—" },
              { key: t("catalog.features.sourceObservations.ui.detail.hash"), value: data.source_record_hash },
              { key: t("catalog.features.sourceObservations.ui.detail.source.url"), value: data.source_url },
              { key: t("catalog.features.sourceObservations.ui.detail.promoted.catalog.item"), value: data.promoted_catalog_item_id ?? "—" },
            ]}
          />
          {data.status === "observed" && (
            <TextInput
              label={t("catalog.features.sourceObservations.ui.detail.reject.reason")}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          )}
        </Stack>
      )}
    </EntityDetailPage>
  );
}
