import { useMemo, useState } from "react";
import {
  Badge,
  BadgeCluster,
  BulkActionSurface,
  Button,
  DataTable,
  EmptyState,
  EvidenceStringList,
  FilterArea,
  HiddenInput,
  KeyValueList,
  MetricStrip,
  SideSheet,
  StatGrid,
  Stat,
  TextInput,
  WorkbenchActionRow,
  WorkbenchDataCell,
  WorkbenchDetailPanel,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogAliasReviewActionKey,
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
  CatalogAliasReviewWarningKey,
} from "../../../../../features/alias-equivalence/api/alias-review-admin-contracts";

// The alias-review workspace. A standalone admin module that an operator
// opens during integration review to see, understand, and act on alias
// candidates before promotion. It renders only design-system components; bulk
// review actions are dispatched as POST forms to the action href the composition
// root supplies, mirroring the Source Observation review module. The workspace
// reads the alias review read model, never raw provider JSON.
export type CatalogAliasReviewWorkspaceProps = Readonly<{
  readModel: CatalogAliasReviewReadModel;
  /** Route the bulk review forms POST to (supplied by the deployable). */
  actionHref: string;
  /** Whether the operator may dispatch alias review writes (catalog.manage). */
  canManageAliases?: boolean;
}>;

export function CatalogIntegrationAliasReviewWorkspace({
  readModel,
  actionHref,
  canManageAliases = true,
}: CatalogAliasReviewWorkspaceProps) {
  const [selectedAliasHashes, setSelectedAliasHashes] = useState<Set<string>>(new Set());

  const selectedReviewable = useMemo(
    () => readModel.candidates.filter((row) => selectedAliasHashes.has(row.aliasHash) && row.reviewable).length,
    [readModel.candidates, selectedAliasHashes],
  );
  const selectedAutoAcceptEligible = useMemo(
    () =>
      readModel.candidates.filter((row) => selectedAliasHashes.has(row.aliasHash) && row.autoAccept.eligible).length,
    [readModel.candidates, selectedAliasHashes],
  );

  const columns = useMemo<DataColumn<CatalogAliasReviewCandidateSummary>[]>(
    () => [
      {
        key: "candidate",
        header: t("catalog.features.sourceObservations.ui.aliasReview.table.candidate"),
        sortable: true,
        cell: (row) => (
          <WorkbenchDataCell
            title={row.proposedAlias}
            truncateTitle
            description={t("catalog.features.sourceObservations.ui.aliasReview.table.native", {
              name: row.nativePrintedName,
            })}
            badges={<AliasWarningBadges warnings={row.warnings} />}
          />
        ),
      },
      {
        key: "type",
        header: t("catalog.features.sourceObservations.ui.aliasReview.table.type"),
        mobileLabel: t("catalog.features.sourceObservations.ui.aliasReview.table.type"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <Badge tone="neutral">{row.aliasType}</Badge>
            <Badge tone={confidenceTone(row.confidence)}>{row.confidence}</Badge>
          </WorkbenchStack>
        ),
      },
      {
        key: "source",
        header: t("catalog.features.sourceObservations.ui.aliasReview.table.source"),
        mobileLabel: t("catalog.features.sourceObservations.ui.aliasReview.table.source"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <WorkbenchText size="sm">{row.providerKey}</WorkbenchText>
            <WorkbenchText size="xs" tone="secondary">
              {row.sourceCategory}
            </WorkbenchText>
          </WorkbenchStack>
        ),
      },
      {
        key: "status",
        header: t("catalog.features.sourceObservations.ui.aliasReview.table.status"),
        mobileLabel: t("catalog.features.sourceObservations.ui.aliasReview.table.status"),
        cell: (row) => (
          <WorkbenchStack gap="sm">
            <Badge tone={reviewStatusTone(row.reviewStatus)}>{row.reviewStatus}</Badge>
            {row.autoAccept.eligible ? (
              <Badge tone="info">{t("catalog.features.sourceObservations.ui.aliasReview.action.autoAccept")}</Badge>
            ) : null}
          </WorkbenchStack>
        ),
      },
      {
        key: "actions",
        header: t("catalog.features.sourceObservations.ui.aliasReview.table.actions"),
        mobileLabel: t("catalog.features.sourceObservations.ui.aliasReview.table.actions"),
        align: "right",
        cell: (row) => (
          <WorkbenchActionRow>
            <AliasEvidenceSheet candidate={row} />
            {row.availableActions.map((action) => (
              <AliasReviewActionButton
                key={action}
                action={action}
                candidate={row}
                actionHref={actionHref}
                disabled={!canManageAliases}
              />
            ))}
          </WorkbenchActionRow>
        ),
      },
    ],
    [actionHref, canManageAliases],
  );

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.aliasReview.title")}
      description={t("catalog.features.sourceObservations.ui.aliasReview.description")}
      status={
        <Badge tone={readModel.counts.needsReview > 0 ? "warning" : "success"}>
          {t("catalog.features.sourceObservations.ui.aliasReview.status.count", { count: readModel.counts.total })}
        </Badge>
      }
      headingLevel={2}
      density="compact"
    >
      <MetricStrip
        items={[
          {
            label: t("catalog.features.sourceObservations.ui.aliasReview.metric.needsReview"),
            value: String(readModel.counts.needsReview),
            trend: t("catalog.features.sourceObservations.ui.aliasReview.metric.needsReview.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.aliasReview.metric.autoAcceptEligible"),
            value: String(readModel.counts.autoAcceptEligible),
            trend: t("catalog.features.sourceObservations.ui.aliasReview.metric.autoAcceptEligible.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.aliasReview.metric.warned"),
            value: String(readModel.counts.warned),
            trend: t("catalog.features.sourceObservations.ui.aliasReview.metric.warned.trend"),
          },
          {
            label: t("catalog.features.sourceObservations.ui.aliasReview.metric.accepted"),
            value: String(readModel.counts.accepted + readModel.counts.autoAccepted),
            trend: t("catalog.features.sourceObservations.ui.aliasReview.metric.accepted.trend"),
          },
        ]}
      />

      <FilterArea
        sticky={false}
        activeFilterCount={activeFilterCount(readModel)}
        panelTitle={t("catalog.features.sourceObservations.ui.aliasReview.filters.title")}
        panelDescription={t("catalog.features.sourceObservations.ui.aliasReview.filters.description")}
      >
        <Badge tone={readModel.filter.providerKey ? "info" : "warning"}>
          {t("catalog.features.sourceObservations.ui.aliasReview.filters.provider", {
            value: readModel.filter.providerKey ?? t("catalog.features.sourceObservations.ui.aliasReview.filters.all"),
          })}
        </Badge>
        <Badge tone={readModel.filter.sourceProfileVersion ? "info" : "warning"}>
          {t("catalog.features.sourceObservations.ui.aliasReview.filters.profileVersion", {
            value:
              readModel.filter.sourceProfileVersion ??
              t("catalog.features.sourceObservations.ui.aliasReview.filters.all"),
          })}
        </Badge>
        <Badge tone={readModel.filter.aliasType ? "info" : "warning"}>
          {t("catalog.features.sourceObservations.ui.aliasReview.filters.aliasType", {
            value: readModel.filter.aliasType ?? t("catalog.features.sourceObservations.ui.aliasReview.filters.all"),
          })}
        </Badge>
      </FilterArea>

      <AliasCoveragePanel readModel={readModel} />

      <BulkActionSurface>
        <DataTable
          rows={[...readModel.candidates]}
          columns={columns}
          caption={t("catalog.features.sourceObservations.ui.aliasReview.title")}
          getRowId={(row) => row.aliasHash}
          selectedKeys={selectedAliasHashes}
          onSelectionChange={setSelectedAliasHashes}
          isRowSelectable={(row) => row.reviewable}
          density="compact"
          emptyTitle={t("catalog.features.sourceObservations.ui.aliasReview.empty.title")}
          emptyDescription={t("catalog.features.sourceObservations.ui.aliasReview.empty.description")}
        />

        {selectedAliasHashes.size > 0 ? (
          <AliasBulkActionPanel
            selectedAliasHashes={selectedAliasHashes}
            onClear={() => setSelectedAliasHashes(new Set())}
            selectedReviewable={selectedReviewable}
            selectedAutoAcceptEligible={selectedAutoAcceptEligible}
            actionHref={actionHref}
            canManageAliases={canManageAliases}
          />
        ) : null}
      </BulkActionSurface>
    </WorkflowModule>
  );
}

function AliasCoveragePanel({ readModel }: { readModel: CatalogAliasReviewReadModel }) {
  const { coverage } = readModel;
  const hasCoverage = coverage.cards.length > 0 || coverage.referenceScopes.length > 0 || readModel.counts.total > 0;

  return (
    <WorkbenchDetailPanel data-alias-review-coverage="true">
      <WorkbenchStack gap="sm">
        <WorkbenchText tone="foreground" weight="semibold">
          {t("catalog.features.sourceObservations.ui.aliasReview.coverage.title")}
        </WorkbenchText>
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.aliasReview.coverage.description")}
        </WorkbenchText>
        {hasCoverage ? (
          <StatGrid columns={4}>
            <Stat
              label={t("catalog.features.sourceObservations.ui.aliasReview.coverage.acceptedEnglish")}
              value={String(coverage.cardsWithAcceptedEnglishAlias)}
            />
            <Stat
              label={t("catalog.features.sourceObservations.ui.aliasReview.coverage.speciesOnly")}
              value={String(coverage.cardsWithOnlySpeciesAliases)}
            />
            <Stat
              label={t("catalog.features.sourceObservations.ui.aliasReview.coverage.cardsNeedingReview")}
              value={String(coverage.cardsNeedingReview)}
            />
            <Stat
              label={t("catalog.features.sourceObservations.ui.aliasReview.coverage.referencesNeedingReview")}
              value={String(coverage.expansionsAndSeriesNeedingReview)}
            />
          </StatGrid>
        ) : (
          <WorkbenchText size="sm" tone="secondary">
            {t("catalog.features.sourceObservations.ui.aliasReview.coverage.empty")}
          </WorkbenchText>
        )}
      </WorkbenchStack>
    </WorkbenchDetailPanel>
  );
}

function AliasBulkActionPanel({
  selectedAliasHashes,
  onClear,
  selectedReviewable,
  selectedAutoAcceptEligible,
  actionHref,
  canManageAliases,
}: {
  selectedAliasHashes: Set<string>;
  onClear: () => void;
  selectedReviewable: number;
  selectedAutoAcceptEligible: number;
  actionHref: string;
  canManageAliases: boolean;
}) {
  const aliasHashes = [...selectedAliasHashes];

  return (
    <WorkbenchDetailPanel data-alias-review-bulk-actions="true">
      <WorkbenchActionRow align="between">
        <WorkbenchText tone="foreground" weight="semibold">
          {t("catalog.features.sourceObservations.ui.aliasReview.selection.count", { count: selectedAliasHashes.size })}
        </WorkbenchText>
        <WorkbenchActionRow>
          <BulkAliasActionForm
            action="alias.accept"
            aliasHashes={aliasHashes}
            actionHref={actionHref}
            tone="primary"
            disabled={!canManageAliases || selectedReviewable === 0}
          >
            {t("catalog.features.sourceObservations.ui.aliasReview.action.accept")}
          </BulkAliasActionForm>
          {selectedAutoAcceptEligible > 0 ? (
            <BulkAliasActionForm
              action="alias.accept"
              aliasHashes={aliasHashes}
              actionHref={actionHref}
              tone="secondary"
              disabled={!canManageAliases}
            >
              {t("catalog.features.sourceObservations.ui.aliasReview.bulk.acceptEligible", {
                count: selectedAutoAcceptEligible,
              })}
            </BulkAliasActionForm>
          ) : null}
          <BulkAliasActionForm
            action="alias.defer"
            aliasHashes={aliasHashes}
            actionHref={actionHref}
            tone="secondary"
            disabled={!canManageAliases || selectedReviewable === 0}
          >
            {t("catalog.features.sourceObservations.ui.aliasReview.action.defer")}
          </BulkAliasActionForm>
          <Button size="sm" tone="secondary" onClick={onClear}>
            {t("catalog.features.sourceObservations.ui.aliasReview.selection.clear")}
          </Button>
        </WorkbenchActionRow>
      </WorkbenchActionRow>

      <WorkbenchForm variant="inline" method="post" action={actionHref} data-alias-review-command="alias.reject">
        <HiddenInput name="_intent" value="alias.reject" />
        <HiddenInput name="aliasHashes" value={aliasHashes.join(",")} />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.aliasReview.bulk.reason")}
          name="reason"
          required
          disabled={!canManageAliases || selectedReviewable === 0}
        />
        <Button type="submit" size="sm" tone="secondary" disabled={!canManageAliases || selectedReviewable === 0}>
          {t("catalog.features.sourceObservations.ui.aliasReview.action.reject")}
        </Button>
      </WorkbenchForm>
    </WorkbenchDetailPanel>
  );
}

function BulkAliasActionForm({
  action,
  aliasHashes,
  actionHref,
  tone,
  disabled,
  children,
}: {
  action: Extract<CatalogAliasReviewActionKey, "alias.accept" | "alias.defer">;
  aliasHashes: readonly string[];
  actionHref: string;
  tone: "primary" | "secondary";
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <WorkbenchForm variant="button" method="post" action={actionHref} data-alias-review-command={action}>
      <HiddenInput name="_intent" value={action} />
      <HiddenInput name="aliasHashes" value={aliasHashes.join(",")} />
      <Button type="submit" size="sm" tone={tone} disabled={disabled}>
        {children}
      </Button>
    </WorkbenchForm>
  );
}

function AliasReviewActionButton({
  action,
  candidate,
  actionHref,
  disabled,
}: {
  action: CatalogAliasReviewActionKey;
  candidate: CatalogAliasReviewCandidateSummary;
  actionHref: string;
  disabled: boolean;
}) {
  const ariaLabel = t("catalog.features.sourceObservations.ui.aliasReview.action.aria", {
    action: aliasActionLabel(action),
    alias: candidate.proposedAlias,
  });
  // Reject and revoke require a reason; render them inline so the operator can
  // supply one without a separate page.
  const requiresReason = action === "alias.reject" || action === "alias.revoke";

  return (
    <WorkbenchForm variant="button" method="post" action={actionHref} data-alias-review-command={action}>
      <HiddenInput name="_intent" value={action} />
      <HiddenInput name="aliasHashes" value={candidate.aliasHash} />
      {requiresReason ? <HiddenInput name="reason" value={aliasActionLabel(action)} /> : null}
      <Button
        type="submit"
        size="sm"
        tone={action === "alias.accept" ? "primary" : "secondary"}
        disabled={disabled}
        aria-label={ariaLabel}
      >
        {aliasActionLabel(action)}
      </Button>
    </WorkbenchForm>
  );
}

function AliasEvidenceSheet({ candidate }: { candidate: CatalogAliasReviewCandidateSummary }) {
  return (
    <SideSheet
      title={t("catalog.features.sourceObservations.ui.aliasReview.evidence.title", {
        alias: candidate.proposedAlias,
      })}
      description={t("catalog.features.sourceObservations.ui.aliasReview.evidence.description")}
      closeLabel={t("catalog.features.sourceObservations.ui.aliasReview.evidence.close")}
      width="lg"
      trigger={
        <Button size="sm" tone="secondary" leadingIcon="eye">
          {t("catalog.features.sourceObservations.ui.aliasReview.evidence.trigger")}
        </Button>
      }
    >
      <WorkbenchStack>
        <KeyValueList items={candidate.evidence.map((line) => ({ key: line.label, value: line.value }))} />
        <WorkbenchStack gap="sm">
          <WorkbenchText size="sm" tone="foreground" weight="semibold">
            {t("catalog.features.sourceObservations.ui.aliasReview.evidence.autoAccept")}
          </WorkbenchText>
          <Badge tone={candidate.autoAccept.eligible ? "success" : "warning"}>
            {candidate.autoAccept.governedReviewState}
          </Badge>
          <EvidenceStringList
            title={t("catalog.features.sourceObservations.ui.aliasReview.evidence.autoAccept")}
            items={[...candidate.autoAccept.reasons]}
            emptyLabel={t("catalog.features.sourceObservations.ui.aliasReview.evidence.noWarnings")}
          />
        </WorkbenchStack>
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.aliasReview.evidence.warnings")}
          items={candidate.warnings.map(aliasWarningLabel)}
          emptyLabel={t("catalog.features.sourceObservations.ui.aliasReview.evidence.noWarnings")}
        />
      </WorkbenchStack>
    </SideSheet>
  );
}

function AliasWarningBadges({ warnings }: { warnings: readonly CatalogAliasReviewWarningKey[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <BadgeCluster
      items={warnings.map((warning) => ({
        key: warning,
        label: aliasWarningLabel(warning),
        tone: "warning",
      }))}
    />
  );
}

function activeFilterCount(readModel: CatalogAliasReviewReadModel): number {
  let count = 0;
  if (readModel.filter.providerKey) count += 1;
  if (readModel.filter.sourceProfileVersion) count += 1;
  if (readModel.filter.aliasType) count += 1;
  if (readModel.filter.observationId) count += 1;
  return count;
}

function aliasActionLabel(action: CatalogAliasReviewActionKey): string {
  switch (action) {
    case "alias.accept":
      return t("catalog.features.sourceObservations.ui.aliasReview.action.accept");
    case "alias.reject":
      return t("catalog.features.sourceObservations.ui.aliasReview.action.reject");
    case "alias.defer":
      return t("catalog.features.sourceObservations.ui.aliasReview.action.defer");
    case "alias.revoke":
      return t("catalog.features.sourceObservations.ui.aliasReview.action.revoke");
  }
}

function aliasWarningLabel(warning: CatalogAliasReviewWarningKey): string {
  switch (warning) {
    case "generated-translation":
      return t("catalog.features.sourceObservations.ui.aliasReview.warning.generatedTranslation");
    case "low-confidence-evidence":
      return t("catalog.features.sourceObservations.ui.aliasReview.warning.lowConfidence");
    case "never-official-source":
      return t("catalog.features.sourceObservations.ui.aliasReview.warning.neverOfficial");
    case "indonesian-id-not-english":
      return t("catalog.features.sourceObservations.ui.aliasReview.warning.indonesianId");
  }
}

function confidenceTone(confidence: CatalogAliasReviewCandidateSummary["confidence"]) {
  switch (confidence) {
    case "exact":
      return "success" as const;
    case "high":
      return "info" as const;
    case "manual":
      return "accent" as const;
    case "generated":
      return "danger" as const;
    case "candidate":
      return "warning" as const;
  }
}

function reviewStatusTone(status: CatalogAliasReviewCandidateSummary["reviewStatus"]) {
  switch (status) {
    case "accepted":
    case "auto-accepted":
      return "success" as const;
    case "pending":
      return "warning" as const;
    case "rejected":
      return "danger" as const;
    case "revoked":
      return "neutral" as const;
  }
}
