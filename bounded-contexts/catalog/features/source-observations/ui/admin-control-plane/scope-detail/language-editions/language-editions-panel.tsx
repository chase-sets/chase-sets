import {
  Badge,
  BadgeCluster,
  Button,
  EvidenceStringList,
  HiddenInput,
  ProgressiveDisclosureGroup,
  StatGrid,
  Stat,
  TextInput,
  WorkbenchActionRow,
  WorkbenchForm,
  WorkbenchStack,
  WorkbenchText,
  WorkflowModule,
  type ProgressiveDisclosureItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogAliasReviewActionKey,
  CatalogAliasReviewCandidateSummary,
} from "../../../../../alias-equivalence/api/alias-review-admin-contracts";
import type {
  CatalogScopeLanguageEditionLinkState,
  CatalogScopeLanguageEditionReviewReadModel,
  CatalogScopeLanguageEditionSummary,
} from "./language-edition-review";

// The scope-detail language-editions section. Inline first, per
// the v2 control-plane blueprint's disclosure rules: every edition's link
// state and pending candidates render on this page, and the candidates for
// each non-canonical edition sit behind a per-edition disclosure so the
// section stays scannable when a scope has many editions. Accept/reject/defer/
// revoke dispatch the same alias-equivalence commands the generic alias-review
// table uses, scoped to this scope's reference record only.
export type CatalogIntegrationLanguageEditionsPanelProps = Readonly<{
  readModel: CatalogScopeLanguageEditionReviewReadModel;
  /** Route the accept/reject/defer/revoke forms POST to (supplied by the composition root). */
  actionHref: string;
  canManageAliases?: boolean;
}>;

export function CatalogIntegrationLanguageEditionsPanel({
  readModel,
  actionHref,
  canManageAliases = true,
}: CatalogIntegrationLanguageEditionsPanelProps) {
  const totalPending = readModel.editions.reduce((sum, edition) => sum + edition.pendingCandidates.length, 0);
  const totalLinked = readModel.editions.filter((edition) => edition.linkState === "linked").length;

  const items: ProgressiveDisclosureItem[] = readModel.editions.map((edition) => ({
    value: edition.languageCode,
    title: editionTitle(edition),
    summary: editionSummary(edition),
    content: <EditionCandidates edition={edition} actionHref={actionHref} canManageAliases={canManageAliases} />,
    tone: editionTone(edition.linkState),
  }));

  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.title")}
      description={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.description")}
      status={
        <Badge tone={totalPending > 0 ? "warning" : "success"}>
          {t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.status", {
            linked: totalLinked,
            total: readModel.editions.length,
          })}
        </Badge>
      }
      headingLevel={2}
      density="compact"
    >
      <StatGrid columns={3}>
        <Stat
          label={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.stat.editions")}
          value={String(readModel.editions.length)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.stat.linked")}
          value={String(totalLinked)}
        />
        <Stat
          label={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.stat.pending")}
          value={String(totalPending)}
        />
      </StatGrid>

      <ProgressiveDisclosureGroup
        items={items}
        defaultValue={readModel.editions
          .filter((edition) => edition.linkState === "pending-review")
          .map((edition) => edition.languageCode)}
        multiple
      />
    </WorkflowModule>
  );
}

function EditionCandidates({
  edition,
  actionHref,
  canManageAliases,
}: {
  edition: CatalogScopeLanguageEditionSummary;
  actionHref: string;
  canManageAliases: boolean;
}) {
  if (edition.isCanonical) {
    return (
      <WorkbenchText size="sm" tone="secondary">
        {t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.canonical.description")}
      </WorkbenchText>
    );
  }

  if (edition.pendingCandidates.length === 0 && edition.acceptedCandidates.length === 0) {
    return (
      <WorkbenchText size="sm" tone="secondary">
        {t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.empty")}
      </WorkbenchText>
    );
  }

  return (
    <WorkbenchStack gap="md">
      {edition.pendingCandidates.map((candidate) => (
        <CandidateRow
          key={candidate.aliasHash}
          candidate={candidate}
          actionHref={actionHref}
          canManageAliases={canManageAliases}
        />
      ))}
      {edition.acceptedCandidates.map((candidate) => (
        <CandidateRow
          key={candidate.aliasHash}
          candidate={candidate}
          actionHref={actionHref}
          canManageAliases={canManageAliases}
        />
      ))}
    </WorkbenchStack>
  );
}

function CandidateRow({
  candidate,
  actionHref,
  canManageAliases,
}: {
  candidate: CatalogAliasReviewCandidateSummary;
  actionHref: string;
  canManageAliases: boolean;
}) {
  return (
    <WorkbenchStack gap="sm" data-language-edition-candidate={candidate.aliasHash}>
      <WorkbenchActionRow align="between">
        <WorkbenchStack gap="sm">
          <WorkbenchText weight="semibold">{candidate.proposedAlias}</WorkbenchText>
          <WorkbenchText size="xs" tone="secondary">
            {t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.candidate.native", {
              name: candidate.nativePrintedName,
            })}
          </WorkbenchText>
        </WorkbenchStack>
        <BadgeCluster
          items={[
            { key: "status", label: candidate.reviewStatus, tone: reviewStatusTone(candidate.reviewStatus) },
            { key: "confidence", label: candidate.confidence, tone: "neutral" },
          ]}
        />
      </WorkbenchActionRow>

      {/* Auto-accept posture: why this still-pending candidate did not auto-accept, per governance policy (AC 3). */}
      {candidate.reviewStatus === "pending" ? (
        <EvidenceStringList
          title={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.candidate.autoAccept")}
          items={[...candidate.autoAccept.reasons]}
          emptyLabel={t(
            "catalog.features.sourceObservations.ui.scopeDetail.languageEditions.candidate.noAutoAcceptReasons",
          )}
        />
      ) : null}

      <WorkbenchActionRow>
        {candidate.availableActions.filter(isDispatchableCandidateAction).map((action) => (
          <CandidateActionForm
            key={action}
            action={action}
            candidate={candidate}
            actionHref={actionHref}
            disabled={!canManageAliases}
          />
        ))}
      </WorkbenchActionRow>
    </WorkbenchStack>
  );
}

// Every CatalogAliasReviewActionKey is dispatchable now: accept and auto-accept
// collapsed into one `alias.accept` action (Catalog Control Plane v2 vocabulary),
// so there is no longer a non-dispatchable variant to filter out.
function isDispatchableCandidateAction(action: CatalogAliasReviewActionKey): action is CatalogAliasReviewActionKey {
  return true;
}

function CandidateActionForm({
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
  const requiresReason = action === "alias.reject" || action === "alias.revoke";
  const label = candidateActionLabel(action);

  if (requiresReason) {
    return (
      <WorkbenchForm variant="inline" method="post" action={actionHref} data-language-edition-command={action}>
        <HiddenInput name="_intent" value={action} />
        <HiddenInput name="aliasHashes" value={candidate.aliasHash} />
        <TextInput
          label={t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.candidate.reason")}
          name="reason"
          required
          disabled={disabled}
        />
        <Button type="submit" size="sm" tone="secondary" disabled={disabled}>
          {label}
        </Button>
      </WorkbenchForm>
    );
  }

  return (
    <WorkbenchForm variant="button" method="post" action={actionHref} data-language-edition-command={action}>
      <HiddenInput name="_intent" value={action} />
      <HiddenInput name="aliasHashes" value={candidate.aliasHash} />
      <Button type="submit" size="sm" tone={action === "alias.accept" ? "primary" : "secondary"} disabled={disabled}>
        {label}
      </Button>
    </WorkbenchForm>
  );
}

function candidateActionLabel(action: CatalogAliasReviewActionKey): string {
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

function editionTitle(edition: CatalogScopeLanguageEditionSummary): string {
  return t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.edition.title", {
    languageCode: edition.languageCode.toUpperCase(),
  });
}

function editionSummary(edition: CatalogScopeLanguageEditionSummary): string {
  if (edition.isCanonical) {
    return t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.edition.canonical");
  }
  switch (edition.linkState) {
    case "linked":
      return t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.edition.linked");
    case "pending-review":
      return t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.edition.pendingReview", {
        count: edition.pendingCandidates.length,
      });
    case "not-yet-observed":
      return t("catalog.features.sourceObservations.ui.scopeDetail.languageEditions.edition.notYetObserved");
  }
}

function editionTone(linkState: CatalogScopeLanguageEditionLinkState): "neutral" | "accent" | "info" | "warning" {
  switch (linkState) {
    case "linked":
      return "accent";
    case "pending-review":
      return "warning";
    case "not-yet-observed":
      return "neutral";
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
