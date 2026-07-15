import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  Dialog,
  Inline,
  OperationalStatusBanner,
  Select,
  Stack,
  Text,
  TextInput,
  WorkbenchStack,
  WorkflowModule,
  type BadgeTone,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { useMemo, useState } from "react";
import { publishReferenceRecord } from "../../reference-data/ui/use-reference-data";
import { useToasts } from "../../../support/shell-support/ui/toasts";
import type {
  ProviderScopeMappingConfidenceTier,
  ScopeCoverageMatrix,
  ScopeCoverageProviderRow,
  ScopeCoverageState,
} from "./contracts";
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

export function CatalogScopeCoverageMatrixPanel({
  scopeRecordId,
  matrix,
  loading: routeLoading = false,
  failed = false,
}: Readonly<{
  scopeRecordId: string;
  matrix: ScopeCoverageMatrix | null;
  loading?: boolean;
  failed?: boolean;
}>) {
  const { data, loading, error, refresh } = useScopeCoverageMatrix(scopeRecordId, matrix);
  const { addToast } = useToasts();
  const [reasonDialog, setReasonDialog] = useState<{ intent: ReasonDialogIntent; mappingId: string } | null>(null);
  const [reason, setReason] = useState("");
  const [showPropose, setShowPropose] = useState(false);
  const [providerKey, setProviderKey] = useState("");
  const [unitKey, setUnitKey] = useState("");
  const [setId, setSetId] = useState("");
  const [setName, setSetName] = useState("");
  const [confidence, setConfidence] = useState<ProviderScopeMappingConfidenceTier>("manual");
  const counts = coverageCounts(data?.providers ?? []);
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
    if (availableMappingIds.length === 0) return;
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
    if (!reasonDialog || !reason.trim()) return;
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
    if (!providerKey.trim() || !unitKey.trim() || (!setId.trim() && !setName.trim())) return;
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

  const columns: readonly DataColumn<ScopeCoverageProviderRow>[] = [
    {
      key: "provider",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider"),
      cell: (row) => row.providerKey,
    },
    {
      key: "coverage",
      header: t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.coverage"),
      cell: (row) => <Badge tone={stateTone[row.state]}>{row.state}</Badge>,
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
      cell: (row) => <MappingActions row={row} onAccept={handleAccept} onReason={setReasonDialog} />,
    },
  ];

  return (
    <>
      <WorkflowModule
        title={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.coverage.matrix")}
        description={t("catalog.features.sourceObservations.ui.scopeDetail.description")}
        status={<CoverageStatus counts={counts} />}
        actions={
          data ? (
            <Inline gap={2} wrap>
              {data.lifecycleStatus === "draft" ? (
                <Button size="sm" onClick={handleConfirmCanonicalRecord}>
                  {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confirm.canonical.record")}
                </Button>
              ) : null}
              {availableMappingIds.length > 0 ? (
                <Button size="sm" onClick={handleAcceptAllAvailable}>
                  {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.accept.all.available", {
                    count: availableMappingIds.length,
                  })}
                </Button>
              ) : null}
              <Button tone="secondary" size="sm" onClick={() => setShowPropose(true)}>
                {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose.mapping")}
              </Button>
            </Inline>
          ) : null
        }
        headingLevel={2}
        density="compact"
      >
        <WorkbenchStack>
          {routeLoading || loading ? (
            <OperationalStatusBanner
              tone="info"
              title={t("catalog.features.sourceObservations.ui.scopeDetail.coverage.loading.title")}
              description={t("catalog.features.sourceObservations.ui.scopeDetail.coverage.loading.description")}
            />
          ) : null}
          {failed || error ? (
            <OperationalStatusBanner
              tone="warning"
              title={t("catalog.features.sourceObservations.ui.scopeDetail.coverage.partial.title")}
              description={t("catalog.features.sourceObservations.ui.scopeDetail.coverage.partial.description")}
            />
          ) : null}
          {data?.lifecycleStatus === "draft" ? (
            <OperationalStatusBanner
              tone="warning"
              title={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.draft.banner.title")}
              description={t(
                "catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.draft.banner.description",
              )}
            />
          ) : null}
          <DataTable
            rows={[...(data?.providers ?? [])]}
            columns={[...columns]}
            caption={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.coverage.matrix")}
            getRowId={(row) => `${row.providerKey}:${row.mapping?.mappingId ?? "unmapped"}`}
            density="compact"
            emptyTitle={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.no.coverage.yet")}
          />
        </WorkbenchStack>
      </WorkflowModule>

      <ReasonDialog
        reasonDialog={reasonDialog}
        reason={reason}
        onReasonChange={setReason}
        onClose={() => {
          setReasonDialog(null);
          setReason("");
        }}
        onSubmit={handleReasonSubmit}
      />
      <ProposeMappingDialog
        open={showPropose}
        providerKey={providerKey}
        unitKey={unitKey}
        setId={setId}
        setName={setName}
        confidence={confidence}
        onOpenChange={setShowPropose}
        onProviderKeyChange={setProviderKey}
        onUnitKeyChange={setUnitKey}
        onSetIdChange={setSetId}
        onSetNameChange={setSetName}
        onConfidenceChange={setConfidence}
        onSubmit={handlePropose}
      />
    </>
  );
}

function CoverageStatus({ counts }: Readonly<{ counts: ReturnType<typeof coverageCounts> }>) {
  return (
    <BadgeCluster
      items={[
        {
          key: "mapped",
          label: t("catalog.features.sourceObservations.ui.scopeDetail.coverage.summary.mapped", {
            count: counts.mapped,
          }),
          tone: counts.mapped > 0 ? "info" : "neutral",
        },
        {
          key: "synced",
          label: t("catalog.features.sourceObservations.ui.scopeDetail.coverage.summary.synced", {
            count: counts.synced,
          }),
          tone: counts.synced > 0 ? "accent" : "neutral",
        },
        {
          key: "settled",
          label: t("catalog.features.sourceObservations.ui.scopeDetail.coverage.summary.settled", {
            count: counts.settled,
          }),
          tone: counts.settled > 0 ? "success" : "neutral",
        },
      ]}
    />
  );
}

function MappingActions({
  row,
  onAccept,
  onReason,
}: Readonly<{
  row: ScopeCoverageProviderRow;
  onAccept: (mappingId: string) => void;
  onReason: (dialog: { intent: ReasonDialogIntent; mappingId: string }) => void;
}>) {
  if (row.state === "available" && row.mapping) {
    return (
      <Inline gap={2} wrap>
        <Button size="sm" onClick={() => onAccept(row.mapping!.mappingId)}>
          {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.accept")}
        </Button>
        <Button
          size="sm"
          tone="danger"
          onClick={() => onReason({ intent: "reject", mappingId: row.mapping!.mappingId })}
        >
          {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.reject")}
        </Button>
      </Inline>
    );
  }

  if ((row.state === "mapped" || row.state === "synced" || row.state === "settled") && row.mapping) {
    return (
      <Button size="sm" tone="danger" onClick={() => onReason({ intent: "revoke", mappingId: row.mapping!.mappingId })}>
        {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.revoke")}
      </Button>
    );
  }

  return null;
}

function ReasonDialog({
  reasonDialog,
  reason,
  onReasonChange,
  onClose,
  onSubmit,
}: Readonly<{
  reasonDialog: { intent: ReasonDialogIntent; mappingId: string } | null;
  reason: string;
  onReasonChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}>) {
  return (
    <Dialog
      open={reasonDialog !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        reasonDialog?.intent === "reject"
          ? t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.reject.mapping")
          : t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.revoke.mapping")
      }
      footer={
        <Button tone="danger" onClick={onSubmit} disabled={!reason.trim()}>
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
          onChange={(event) => onReasonChange(event.target.value)}
        />
      </Stack>
    </Dialog>
  );
}

function ProposeMappingDialog({
  open,
  providerKey,
  unitKey,
  setId,
  setName,
  confidence,
  onOpenChange,
  onProviderKeyChange,
  onUnitKeyChange,
  onSetIdChange,
  onSetNameChange,
  onConfidenceChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  providerKey: string;
  unitKey: string;
  setId: string;
  setName: string;
  confidence: ProviderScopeMappingConfidenceTier;
  onOpenChange: (open: boolean) => void;
  onProviderKeyChange: (value: string) => void;
  onUnitKeyChange: (value: string) => void;
  onSetIdChange: (value: string) => void;
  onSetNameChange: (value: string) => void;
  onConfidenceChange: (value: ProviderScopeMappingConfidenceTier) => void;
  onSubmit: (autoAccept: boolean) => void;
}>) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose.mapping")}
      footer={
        <Inline gap={2}>
          <Button tone="secondary" onClick={() => onSubmit(false)}>
            {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose")}
          </Button>
          <Button onClick={() => onSubmit(true)}>
            {t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.propose.and.accept")}
          </Button>
        </Inline>
      }
    >
      <Stack gap={3}>
        <TextInput
          label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider.key")}
          value={providerKey}
          onChange={(event) => onProviderKeyChange(event.target.value)}
        />
        <TextInput
          label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.unit.key")}
          value={unitKey}
          onChange={(event) => onUnitKeyChange(event.target.value)}
        />
        <TextInput
          label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider.set.id")}
          value={setId}
          onChange={(event) => onSetIdChange(event.target.value)}
        />
        <TextInput
          label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.provider.set.name")}
          value={setName}
          onChange={(event) => onSetNameChange(event.target.value)}
        />
        <Select
          label={t("catalog.features.providerScopeMapping.ui.scopeCoverageDetailPage.confidence")}
          items={confidenceOptions}
          value={confidence}
          onValueChange={(value) => onConfidenceChange(value as ProviderScopeMappingConfidenceTier)}
        />
      </Stack>
    </Dialog>
  );
}

function coverageCounts(rows: readonly ScopeCoverageProviderRow[]) {
  return {
    mapped: rows.filter((row) => row.state === "mapped").length,
    synced: rows.filter((row) => row.state === "synced").length,
    settled: rows.filter((row) => row.state === "settled").length,
  };
}
