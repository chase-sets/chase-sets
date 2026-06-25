import { useMemo } from "react";
import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  EvidenceStringList,
  KeyValueList,
  SideSheet,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchMergeCandidateActionKey,
  CatalogPrimaryWorkbenchMergeCandidateReviewRow,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { CommandFormButton } from "./command-controls";
import { BlockerList, stateLabel } from "./workbench-formatting";

type MergeCandidateRow = CatalogPrimaryWorkbenchMergeCandidateReviewRow;

export function CatalogIntegrationMergeCandidateReviewModule({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const review = readModel.mergeCandidateReview;
  const columns = useMemo<DataColumn<MergeCandidateRow>[]>(
    () => [
      {
        key: "identity",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.table.identity"),
        sortable: true,
        cell: (row) => (
          <WorkbenchDataCell
            title={row.identityLabel}
            truncateTitle
            description={row.identityFingerprint}
            badges={
              <BadgeCluster
                items={[
                  {
                    key: "intent",
                    label: stateLabel(row.proposedMapping.promotionIntent),
                    tone: "neutral",
                  },
                  {
                    key: "sources",
                    label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.sources.count", {
                      count: row.sourceCount,
                    }),
                    tone: "info",
                  },
                ]}
              />
            }
          />
        ),
      },
      {
        key: "sources",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.table.sources"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            {row.sources.slice(0, 3).map((source) => (
              <WorkbenchText
                key={`${row.candidateId}-${source.providerKey}-${source.observationId ?? source.externalKey}`}
                size="xs"
              >
                {source.providerKey}: {source.observationId ?? source.externalKey}
              </WorkbenchText>
            ))}
          </WorkbenchStack>
        ),
      },
      {
        key: "status",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.table.status"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <Badge tone={candidateStatusTone(row.status)}>{stateLabel(row.status)}</Badge>
            <BadgeCluster
              items={[
                {
                  key: "blocking",
                  label: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflicts.blocking",
                    {
                      count: row.conflicts.blocking,
                    },
                  ),
                  tone: row.conflicts.blocking > 0 ? "danger" : "neutral",
                },
                {
                  key: "warnings",
                  label: t(
                    "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflicts.warning",
                    {
                      count: row.conflicts.warnings,
                    },
                  ),
                  tone: row.conflicts.warnings > 0 ? "warning" : "neutral",
                },
              ]}
            />
          </WorkbenchStack>
        ),
      },
      {
        key: "readiness",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.table.readiness"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <Badge tone={row.promoteReadiness.state === "ready" ? "success" : "warning"}>
              {stateLabel(row.promoteReadiness.state)}
            </Badge>
            <BlockerList blockers={row.promoteReadiness.blockers} compact hideWhenEmpty />
          </WorkbenchStack>
        ),
      },
      {
        key: "actions",
        header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
        align: "right",
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <WorkbenchActionRow>
              <MergeCandidateDetailSheet row={row} />
              {row.actions.map((actionEntry) => (
                <MergeCandidateActionButton
                  key={actionEntry.key}
                  readModel={readModel}
                  row={row}
                  actionKey={actionEntry.key}
                  disabled={actionEntry.state !== "available" && actionEntry.state !== "degraded"}
                />
              ))}
            </WorkbenchActionRow>
            <BlockerList blockers={row.actions.flatMap((actionEntry) => actionEntry.blockers)} compact hideWhenEmpty />
          </WorkbenchStack>
        ),
      },
    ],
    [readModel],
  );

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.title")}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.description")}
      status={
        <BadgeCluster
          items={[
            { key: "freshness", label: stateLabel(review.freshness), tone: freshnessTone(review.freshness) },
            {
              key: "ready",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.ready.count", {
                count: review.counts.ready,
              }),
              tone: review.counts.ready > 0 ? "success" : "neutral",
            },
            {
              key: "conflict",
              label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflict.count", {
                count: review.counts.conflict,
              }),
              tone: review.counts.conflict > 0 ? "warning" : "neutral",
            },
          ]}
        />
      }
      headingLevel={2}
      density="compact"
    >
      <BadgeCluster
        items={review.filters.map((filter) => ({
          key: filter.key,
          label: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.filter.summary", {
            label: filter.label,
            value: filter.value ?? t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
          }),
          tone: filter.serverApplied ? "info" : "neutral",
        }))}
      />
      <DataTable
        rows={[...review.rows]}
        columns={columns}
        caption={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.title")}
        getRowId={(row) => row.candidateId}
        density="compact"
        emptyTitle={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.empty.title")}
        emptyDescription={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.empty.description",
        )}
      />
    </WorkflowModule>
  );
}

function MergeCandidateDetailSheet({ row }: Readonly<{ row: MergeCandidateRow }>) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.title", {
        name: row.identityLabel,
      })}
      description={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.description")}
      closeLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence.close")}
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.evidence")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.key.candidate"),
              value: row.candidateId,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.key.intent"),
              value: stateLabel(row.proposedMapping.promotionIntent),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.key.catalogItem"),
              value:
                row.proposedMapping.catalogItemId ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.key.products"),
              value:
                row.proposedMapping.productIds.join(", ") ||
                t("catalog.features.sourceObservations.ui.primaryWorkbench.none"),
            },
          ]}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.sourceComparison")}
          items={row.sourceComparison.map(
            (entry) => `${entry.providerKey} ${entry.observationId} ${entry.fieldPath}: ${entry.value}`,
          )}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.fieldProvenance")}
          items={row.fieldProvenance.map(
            (entry) =>
              `${entry.fieldPath}: ${entry.providerKey} ${entry.sourceProfileVersion} ${stateLabel(entry.confidence)}`,
          )}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.references")}
          items={[
            ...row.proposedMapping.externalCatalogItemReferences,
            ...row.proposedMapping.externalProductReferences,
          ]}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.proposedFacts")}
          items={row.proposedFacts.map((fact) => `${fact.key}: ${fact.value}`)}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}
        />
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.conflicts")}
          items={row.conflicts.messages}
          emptyLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.review.evidence.no.conflicts")}
        />
      </WorkbenchStack>
    </SideSheet>
  );
}

function MergeCandidateActionButton({
  readModel,
  row,
  actionKey,
  disabled,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  row: MergeCandidateRow;
  actionKey: CatalogPrimaryWorkbenchMergeCandidateActionKey;
  disabled: boolean;
}>) {
  return (
    <CommandFormButton
      readModel={readModel}
      intent={actionKey}
      candidateId={row.candidateId}
      reason={candidateActionReason(actionKey)}
      size="sm"
      tone={actionKey === "promote-merge-candidate" ? "primary" : "secondary"}
      disabled={disabled}
      aria-label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.aria", {
        action: candidateActionLabel(actionKey),
        candidate: row.identityLabel,
      })}
    >
      {candidateActionLabel(actionKey)}
    </CommandFormButton>
  );
}

function candidateActionLabel(actionKey: CatalogPrimaryWorkbenchMergeCandidateActionKey): string {
  switch (actionKey) {
    case "promote-merge-candidate":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.promote");
    case "split-merge-candidate":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.split");
    case "update-merge-candidate":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.update");
    case "ignore-merge-candidate":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.ignore");
    case "defer-merge-candidate":
      return t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.defer");
  }
}

function candidateActionReason(actionKey: CatalogPrimaryWorkbenchMergeCandidateActionKey): string {
  return t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.action.reason", {
    action: candidateActionLabel(actionKey),
  });
}

function candidateStatusTone(status: MergeCandidateRow["status"]) {
  if (status === "ready" || status === "promoted") {
    return "success";
  }
  if (status === "has-conflicts" || status === "stale" || status === "deferred") {
    return "warning";
  }
  return "danger";
}

function freshnessTone(freshness: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"]["freshness"]) {
  if (freshness === "fresh") {
    return "success";
  }
  if (freshness === "unavailable") {
    return "danger";
  }
  return "warning";
}
