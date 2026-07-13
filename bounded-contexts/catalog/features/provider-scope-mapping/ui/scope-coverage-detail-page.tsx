import { t } from "@chase-sets/localization";
import { useMemo, useState } from "react";
import {
  Banner,
  Button,
  DataTable,
  Dialog,
  Inline,
  KeyValueList,
  PageSection,
  Select,
  Stack,
  StatusPill,
  Text,
  TextInput,
  type BadgeTone,
  type DataColumn,
} from "@chase-sets/design-system";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import { EntityDetailPage } from "../../../support/shell-support/ui/entity-detail-page";
import { toCatalogAdminHref } from "../../../support/shell-support/ui/catalog-admin-hrefs";
import { publishReferenceRecord } from "../../reference-data/ui/use-reference-data";
import type { ProviderScopeMappingConfidenceTier, ScopeCoverageProviderRow, ScopeCoverageState } from "./contracts";
import {
  acceptProviderScopeMappings,
  proposeProviderScopeMapping,
  rejectProviderScopeMappings,
  revokeProviderScopeMapping,
  useScopeCoverageMatrix,
} from "./use-provider-scope-mapping";

const stateTone: Record<ScopeCoverageState, BadgeTone> = {
  "not-offered": "neutral",
  available: "warning",
  mapped: "info",
  synced: "accent",
  settled: "success",
};

const confidenceOptions: { label: string; value: ProviderScopeMappingConfidenceTier }[] = [
  { label: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confidence.exact"), value: "exact" },
  { label: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confidence.high"), value: "high" },
  { label: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confidence.manual"), value: "manual" },
];

type ReasonDialogIntent = "reject" | "revoke";

export function ScopeCoverageDetailPage({
  scopeRecordId,
  initialData,
}: {
  scopeRecordId: string;
  initialData?: Parameters<typeof useScopeCoverageMatrix>[1];
}) {
  const { data, loading, error, refresh } = useScopeCoverageMatrix(scopeRecordId, initialData);
  const { addToast } = useToasts();

  const [reasonDialog, setReasonDialog] = useState<{ intent: ReasonDialogIntent; mappingId: string } | null>(null);
  const [reason, setReason] = useState("");
  const [showPropose, setShowPropose] = useState(false);
  const [providerKey, setProviderKey] = useState("");
  const [unitKey, setUnitKey] = useState("");
  const [setId, setSetId] = useState("");
  const [setName, setSetName] = useState("");
  const [confidence, setConfidence] = useState<ProviderScopeMappingConfidenceTier>("manual");

  const availableMappingIds = useMemo(
    () =>
      (data?.providers ?? [])
        .filter((row) => row.state === "available" && row.mapping)
        .map((row) => row.mapping!.mappingId),
    [data],
  );

  async function handleAccept(mappingId: string) {
    await acceptProviderScopeMappings([mappingId]);
    addToast(t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.mapping.accepted"), "success");
    refresh();
  }

  async function handleAcceptAllAvailable() {
    if (availableMappingIds.length === 0) {
      return;
    }
    await acceptProviderScopeMappings(availableMappingIds);
    addToast(
      t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.all.available.accepted", {
        count: availableMappingIds.length,
      }),
      "success",
    );
    refresh();
  }

  async function handleReasonSubmit() {
    if (!reasonDialog || !reason.trim()) {
      return;
    }
    if (reasonDialog.intent === "reject") {
      await rejectProviderScopeMappings([reasonDialog.mappingId], reason.trim());
      addToast(t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.mapping.rejected"), "success");
    } else {
      await revokeProviderScopeMapping(reasonDialog.mappingId, reason.trim());
      addToast(t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.mapping.revoked"), "success");
    }
    setReasonDialog(null);
    setReason("");
    refresh();
  }

  async function handleConfirmCanonicalRecord() {
    await publishReferenceRecord(scopeRecordId);
    addToast(
      t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.canonical.record.confirmed"),
      "success",
    );
    refresh();
  }

  async function handlePropose(autoAccept: boolean) {
    if (!providerKey.trim() || !unitKey.trim() || (!setId.trim() && !setName.trim())) {
      return;
    }
    await proposeProviderScopeMapping({
      scopeRecordId,
      providerKey: providerKey.trim(),
      unitKey: unitKey.trim(),
      coordinates: { setId: setId.trim() || null, setName: setName.trim() || null },
      confidence,
      autoAccept,
    });
    addToast(
      autoAccept
        ? t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.mapping.proposed.and.accepted")
        : t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.mapping.proposed"),
      "success",
    );
    setShowPropose(false);
    setProviderKey("");
    setUnitKey("");
    setSetId("");
    setSetName("");
    setConfidence("manual");
    refresh();
  }

  const columns: DataColumn<ScopeCoverageProviderRow>[] = [
    {
      key: "providerKey",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider"),
      cell: (row) => row.providerKey,
    },
    {
      key: "state",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.coverage"),
      cell: (row) => <StatusPill tone={stateTone[row.state]}>{row.state}</StatusPill>,
    },
    {
      key: "confidence",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confidence"),
      cell: (row) => row.mapping?.confidence ?? "—",
    },
    {
      key: "synced",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.synced.observations"),
      cell: (row) => row.syncedObservations,
    },
    {
      key: "settled",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.settled.observations"),
      cell: (row) => row.promotedObservations,
    },
    {
      key: "actions",
      header: "",
      cell: (row) =>
        row.state === "available" && row.mapping ? (
          <Inline gap={2}>
            <Button size="sm" onClick={() => handleAccept(row.mapping!.mappingId)}>
              {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.accept")}
            </Button>
            <Button
              size="sm"
              tone="danger"
              onClick={() => setReasonDialog({ intent: "reject", mappingId: row.mapping!.mappingId })}
            >
              {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.reject")}
            </Button>
          </Inline>
        ) : (row.state === "mapped" || row.state === "synced" || row.state === "settled") && row.mapping ? (
          <Button
            size="sm"
            tone="danger"
            onClick={() => setReasonDialog({ intent: "revoke", mappingId: row.mapping!.mappingId })}
          >
            {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.revoke")}
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <EntityDetailPage
        title={data?.scopeName ?? t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.scope.coverage")}
        breadcrumbs={[
          {
            label: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.unmapped.scope.inbox"),
            href: toCatalogAdminHref("/scope-coverage"),
          },
          { label: data?.scopeName ?? scopeRecordId },
        ]}
        actions={
          data ? (
            <Inline gap={2}>
              {data.lifecycleStatus === "draft" && (
                <Button tone="primary" size="sm" onClick={handleConfirmCanonicalRecord}>
                  {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confirm.canonical.record")}
                </Button>
              )}
              {availableMappingIds.length > 0 && (
                <Button size="sm" onClick={handleAcceptAllAvailable}>
                  {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.accept.all.available", {
                    count: availableMappingIds.length,
                  })}
                </Button>
              )}
              <Button tone="secondary" size="sm" onClick={() => setShowPropose(true)}>
                {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose.mapping")}
              </Button>
            </Inline>
          ) : undefined
        }
        loading={loading}
        notFound={!loading && !data}
        error={error}
      >
        {data && (
          <Stack gap={6}>
            {data.lifecycleStatus === "draft" && (
              <Banner
                tone="warning"
                title={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.draft.banner.title")}
                description={t(
                  "catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.draft.banner.description",
                )}
              />
            )}
            <KeyValueList
              items={[
                {
                  key: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.product.domain"),
                  value: data.productDomain,
                },
                {
                  key: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.scope.kind"),
                  value: data.scopeKind,
                },
                {
                  key: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.official.code"),
                  value: data.officialSetCode ?? "—",
                },
                {
                  key: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.release.date"),
                  value: data.releaseDate ?? "—",
                },
                {
                  key: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.lifecycle.status"),
                  value: data.lifecycleStatus,
                },
              ]}
            />

            <PageSection title={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.coverage.matrix")}>
              <DataTable
                rows={[...data.providers]}
                columns={columns}
                getRowId={(row) => row.providerKey}
                emptyTitle={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.no.coverage.yet")}
              />
            </PageSection>
          </Stack>
        )}
      </EntityDetailPage>

      <Dialog
        open={reasonDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReasonDialog(null);
            setReason("");
          }
        }}
        title={
          reasonDialog?.intent === "reject"
            ? t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.reject.mapping")
            : t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.revoke.mapping")
        }
        footer={
          <Button tone="danger" onClick={handleReasonSubmit} disabled={!reason.trim()}>
            {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confirm")}
          </Button>
        }
      >
        <Stack gap={3}>
          <Text tone="secondary">
            {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.reason.required")}
          </Text>
          <TextInput
            label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Stack>
      </Dialog>

      <Dialog
        open={showPropose}
        onOpenChange={setShowPropose}
        title={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose.mapping")}
        footer={
          <Inline gap={2}>
            <Button tone="secondary" onClick={() => handlePropose(false)}>
              {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose")}
            </Button>
            <Button onClick={() => handlePropose(true)}>
              {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose.and.accept")}
            </Button>
          </Inline>
        }
      >
        <Stack gap={3}>
          <TextInput
            label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider.key")}
            value={providerKey}
            onChange={(event) => setProviderKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.unit.key")}
            value={unitKey}
            onChange={(event) => setUnitKey(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider.set.id")}
            value={setId}
            onChange={(event) => setSetId(event.target.value)}
          />
          <TextInput
            label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider.set.name")}
            value={setName}
            onChange={(event) => setSetName(event.target.value)}
          />
          <Select
            label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confidence")}
            items={confidenceOptions}
            value={confidence}
            onValueChange={(value) => setConfidence(value as ProviderScopeMappingConfidenceTier)}
          />
        </Stack>
      </Dialog>
    </>
  );
}
