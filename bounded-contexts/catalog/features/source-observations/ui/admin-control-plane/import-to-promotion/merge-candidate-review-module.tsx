import { useMemo } from "react";
import {
  Badge,
  BadgeCluster,
  Button,
  CopyButton,
  DataTable,
  EvidenceStringList,
  HiddenInput,
  KeyValueList,
  OperationalStatusBanner,
  RadioGroup,
  SideSheet,
  Textarea,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchForm,
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
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import { CommandFormButton, CommandHiddenInputs } from "./command-controls";
import { CatalogMergeCandidateEditForm } from "./candidate-edit-form";
import { CatalogScopeBulkReviewActions, catalogMergeCandidateReviewAnchorId } from "./scope-bulk-review-actions";
import { BlockerList, stateLabel } from "./workbench-formatting";

type MergeCandidateRow = CatalogPrimaryWorkbenchMergeCandidateReviewRow;
type BlockingConflict = MergeCandidateRow["conflicts"]["blockingConflicts"][number];

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
              <MergeCandidateDetailSheet row={row} readModel={readModel} />
              {row.actions.map((actionEntry) => (
                <MergeCandidateActionButton
                  key={actionEntry.key}
                  readModel={readModel}
                  row={row}
                  actionEntry={actionEntry}
                  disabled={actionEntry.state !== "available" && actionEntry.state !== "degraded"}
                />
              ))}
            </WorkbenchActionRow>
            <BlockerList blockers={visibleActionBlockersFor(row)} compact hideWhenEmpty />
          </WorkbenchStack>
        ),
      },
    ],
    [readModel],
  );

  return (
    <WorkbenchStack gap="md">
      <CatalogScopeBulkReviewActions readModel={readModel} />
      <WorkflowModule
        id={catalogMergeCandidateReviewAnchorId}
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
    </WorkbenchStack>
  );
}

function MergeCandidateDetailSheet({
  row,
  readModel,
}: Readonly<{ row: MergeCandidateRow; readModel: CatalogPrimaryWorkbenchReadModel }>) {
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
        {row.conflicts.blockingConflicts.length > 0 ? (
          <MergeCandidateConflictResolutionForm row={row} readModel={readModel} />
        ) : null}
        <CatalogMergeCandidateEditForm row={row} readModel={readModel} />
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
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.commandPayloads")}
          items={commandPayloadSummariesFor(row)}
          emptyLabel={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.commandPayloads.empty",
          )}
        />
        <RawCommandPayloadDisclosure row={row} />
      </WorkbenchStack>
    </SideSheet>
  );
}

// Conflict resolution dissolved into candidate review: blocking conflicts,
// candidate values, and the precedence explanation render inline here, where
// resolution already happens at promote time
// (requireConflictResolutionsForBlockingConflicts in catalog-merge-candidate.ts
// rejects promotion unless every blocking conflict code has a resolution). The
// operator picks the winning value and states a reason per conflict, then submits
// this form directly — the row-level Promote action stays blocked until then.
function MergeCandidateConflictResolutionForm({
  row,
  readModel,
}: Readonly<{ row: MergeCandidateRow; readModel: CatalogPrimaryWorkbenchReadModel }>) {
  const blockingConflicts = row.conflicts.blockingConflicts;
  const otherBlockers = row.promoteReadiness.blockers.filter((blocker) => blocker !== "promotion-conflict");
  const blockingConflictsJson = JSON.stringify(
    blockingConflicts.map((conflict) => ({
      code: conflict.code,
      fieldPath: conflict.fieldPath,
      existingValueJson: conflict.existingValueJson,
      proposedValueJson: conflict.proposedValueJson,
      observationIds: conflict.observationIds,
    })),
  );

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.description",
      )}
      status={
        <Badge tone="danger">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflicts.blocking", {
            count: blockingConflicts.length,
          })}
        </Badge>
      }
      density="compact"
    >
      <WorkbenchStack>
        {otherBlockers.length > 0 ? (
          <>
            <OperationalStatusBanner
              tone="warning"
              title={t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.otherBlockers.title",
              )}
              description={t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.otherBlockers.description",
              )}
            />
            <BlockerList blockers={otherBlockers} />
          </>
        ) : (
          <WorkbenchForm
            variant="surface"
            method="post"
            action={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
            data-catalog-merge-candidate-conflict-resolution-form="true"
          >
            <CommandHiddenInputs readModel={readModel} intent="promote-merge-candidate" candidateId={row.candidateId} />
            <HiddenInput name="blockingConflictsJson" value={blockingConflictsJson} />
            {blockingConflicts.map((conflict) => (
              <ConflictResolutionField key={conflict.code} conflict={conflict} />
            ))}
            <Textarea
              name="reason"
              label={t(
                "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.promoteReason",
              )}
              required
              rows={2}
            />
            <WorkbenchActionRow align="end">
              <Button type="submit" tone="primary" size="sm">
                {t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.submit")}
              </Button>
            </WorkbenchActionRow>
          </WorkbenchForm>
        )}
      </WorkbenchStack>
    </WorkflowModule>
  );
}

function ConflictResolutionField({ conflict }: Readonly<{ conflict: BlockingConflict }>) {
  return (
    <WorkbenchStack gap="sm" data-catalog-conflict-code={conflict.code}>
      <WorkbenchText size="sm">{conflict.message}</WorkbenchText>
      <RadioGroup
        name={`resolution.${conflict.code}`}
        label={t(
          "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.chosenValue",
        )}
        defaultValue="existing"
        items={[
          {
            value: "existing",
            label: t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.keepExisting",
              { value: conflict.existingValueDisplay },
            ),
          },
          {
            value: "proposed",
            label: t(
              "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.useProposed",
              { value: conflict.proposedValueDisplay },
            ),
          },
        ]}
      />
      <Textarea
        name={`reason.${conflict.code}`}
        label={t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.conflictResolution.reason")}
        required
        rows={2}
      />
    </WorkbenchStack>
  );
}

// The typed field-level view above (identity, provenance, references, proposed
// facts, human-readable command summaries) is what an operator reads. The raw
// command payload is never rendered as JSON text in the panel; it stays
// available for support cases behind a copy-to-clipboard control only, so a
// support engineer can paste the exact generated body without the panel ever
// displaying a raw-JSON blob.
function RawCommandPayloadDisclosure({ row }: Readonly<{ row: MergeCandidateRow }>) {
  const rawPayload = rawCommandPayloadFor(row);
  if (!rawPayload) {
    return null;
  }

  return (
    <CopyButton
      value={rawPayload}
      label={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.commandPayloads.copyLabel",
      )}
      copiedLabel={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.commandPayloads.copiedLabel",
      )}
    />
  );
}

function rawCommandPayloadFor(row: MergeCandidateRow): string | null {
  const payloads = row.actions.flatMap((actionEntry) =>
    actionEntry.commandPreview ? [{ action: actionEntry.key, body: actionEntry.commandPreview.body }] : [],
  );

  return payloads.length > 0 ? JSON.stringify(payloads) : null;
}

function visibleActionBlockersFor(
  row: MergeCandidateRow,
): readonly MergeCandidateRow["actions"][number]["blockers"][number][] {
  return row.actions
    .flatMap((actionEntry) => actionEntry.blockers)
    .filter((blocker) => blocker !== "unsupported-command");
}

function commandPayloadSummariesFor(row: MergeCandidateRow): readonly string[] {
  return row.actions.flatMap((actionEntry) => {
    if (actionEntry.commandPreview) {
      return [
        t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.commandPayload", {
          action: candidateActionLabel(actionEntry.key),
          kind: actionEntry.commandPreview.commandKind,
          sourceCount: actionEntry.commandPreview.provenance.membership.length,
          productReferenceCount: actionEntry.commandPreview.provenance.externalProductReferences.length,
        }),
      ];
    }
    if (
      actionEntry.key === "promote-merge-candidate" &&
      (actionEntry.state === "available" || actionEntry.state === "degraded")
    ) {
      return [
        t("catalog.features.sourceObservations.ui.primaryWorkbench.mergeCandidates.detail.commandPayload", {
          action: candidateActionLabel(actionEntry.key),
          kind: "direct-catalog-merge-candidate-promotion",
          sourceCount: row.sourceCount,
          productReferenceCount: row.proposedMapping.externalProductReferences.length,
        }),
      ];
    }

    return [];
  });
}

function MergeCandidateActionButton({
  readModel,
  row,
  actionEntry,
  disabled,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
  row: MergeCandidateRow;
  actionEntry: MergeCandidateRow["actions"][number];
  disabled: boolean;
}>) {
  const actionKey = actionEntry.key;
  return (
    <CommandFormButton
      readModel={readModel}
      intent={actionKey}
      candidateId={row.candidateId}
      reason={candidateActionReason(actionKey)}
      mergeCandidateCommandBody={
        actionEntry.commandPreview ? JSON.stringify(actionEntry.commandPreview.body) : undefined
      }
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
