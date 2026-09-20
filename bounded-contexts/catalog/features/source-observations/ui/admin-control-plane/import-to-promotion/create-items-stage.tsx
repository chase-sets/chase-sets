import { useState } from "react";
import {
  BadgeCluster,
  Checkbox,
  KeyValueList,
  LinkButton,
  ProgressiveDisclosure,
  StatusReasonList,
  WorkbenchActionRow,
  WorkbenchDetailPanel,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { catalogItemsBySourceProviderHref } from "../../../../catalog-items/ui/catalog-item-provenance-links";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { CommandFormButton } from "./command-controls";
import { CatalogIntegrationCommandPlanDetail } from "./command-plan-module";
import { BlockerList, stateLabel } from "./workbench-formatting";

// Stage 3: create / update Catalog Items. The promotion preview is folded into an
// INLINE confirmation of this single action instead of a separate top-level
// "Preview promotion" step that can silently go stale. The operator generates the
// previewed impact, confirms it inline, then commits the create/update in place.
export function CatalogIntegrationCreateItemsStage({
  readModel,
}: Readonly<{
  readModel: CatalogPrimaryWorkbenchReadModel;
}>) {
  const [confirmed, setConfirmed] = useState(false);
  const preview = readModel.promotionPreview;
  // The explicit review choice. It defaults off; the previewed choice comes back
  // through the route context, and toggling it here makes the saved preview
  // stale locally (commit disabled) until a fresh preview binds the new choice.
  const [promoteAsDraft, setPromoteAsDraft] = useState(preview.validation.promoteAsDraft);
  const choiceChanged = preview.previewId !== null && promoteAsDraft !== preview.validation.promoteAsDraft;
  const previewFresh = preview.executionSafeguards.previewFresh && preview.previewId !== null && !choiceChanged;
  const identityBlocked = preview.blockers.includes("display-identity-unresolvable");
  const scopeSummary = preview.scope.filterSummary.join(", ");

  return (
    <WorkbenchStack>
      <WorkbenchText size="sm" tone="secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.description")}
      </WorkbenchText>

      {readModel.promotionResult ? <CatalogIntegrationPromotionOutcome result={readModel.promotionResult} /> : null}

      <WorkbenchDetailPanel>
        <WorkbenchActionRow align="between">
          <WorkbenchStack gap="sm">
            <WorkbenchText tone="foreground" weight="semibold">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.promoteScope.title")}
            </WorkbenchText>
            <WorkbenchText size="xs" tone="secondary">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.promoteScope.scoped", {
                count: preview.scope.eligibleCount,
                scope: preview.scope.label,
              })}
            </WorkbenchText>
          </WorkbenchStack>
          <BadgeCluster
            items={[
              {
                key: "scoped",
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.scoped.badge"),
                tone: "info",
              },
              { key: "freshness", label: stateLabel(preview.freshness), tone: previewFresh ? "success" : "warning" },
            ]}
          />
        </WorkbenchActionRow>

        <WorkbenchGrid columns="detail">
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.scope"),
                value: preview.scope.label,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.eligible.observations"),
                value: preview.scope.eligibleCount,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.plan"),
                value:
                  preview.commandPlanHash ??
                  t("catalog.features.sourceObservations.ui.primaryWorkbench.review.preview.required"),
              },
            ]}
          />
          <KeyValueList
            items={[
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.matched"),
                value: preview.scope.requestedCount,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.eligible"),
                value: preview.outcomeCounts.eligible,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.blocked"),
                value: preview.outcomeCounts.blocked,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.skipped"),
                value: preview.outcomeCounts.skipped,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.conflicting"),
                value: preview.outcomeCounts.conflicting,
              },
              {
                key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.catalogItemUpdates"),
                value: preview.destructiveCount,
              },
            ]}
          />
        </WorkbenchGrid>

        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.promoteScope.explicit", {
            count: preview.scope.requestedCount,
            scope: scopeSummary,
          })}
        </WorkbenchText>

        <Checkbox
          name="promote-as-draft-choice"
          checked={promoteAsDraft}
          onCheckedChange={(checked) => {
            setPromoteAsDraft(checked === true);
            setConfirmed(false);
          }}
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.promoteAsDraft.label")}
          description={t(
            "catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.promoteAsDraft.description",
          )}
        />

        <WorkbenchActionRow align="between">
          <WorkbenchText size="xs" tone={previewFresh ? "secondary" : "foreground"} weight="semibold">
            {previewFresh
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.fresh")
              : choiceChanged
                ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.choiceChanged")
                : t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.refresh")}
          </WorkbenchText>
          <CommandFormButton
            readModel={readModel}
            intent="observation.promote"
            promotionPhase="preview"
            promoteAsDraft={promoteAsDraft}
            size="sm"
            tone="secondary"
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
          </CommandFormButton>
        </WorkbenchActionRow>

        <CatalogIntegrationPromotionValidation validation={preview.validation} />

        <Checkbox
          name="confirm-create-items"
          checked={confirmed}
          disabled={!previewFresh || identityBlocked}
          onCheckedChange={(checked) => setConfirmed(checked === true)}
          label={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.confirm", {
            count: preview.scope.eligibleCount,
            scope: preview.scope.label,
          })}
        />

        <WorkbenchActionRow>
          <CommandFormButton
            readModel={readModel}
            intent="observation.promote"
            promotionPhase="execute"
            promoteAsDraft={promoteAsDraft}
            leadingIcon="check"
            disabled={!previewFresh || !confirmed || identityBlocked}
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.commit")}
          </CommandFormButton>
        </WorkbenchActionRow>

        <BlockerList blockers={preview.blockers} hideWhenEmpty />
      </WorkbenchDetailPanel>

      <CatalogIntegrationCreateItemsHandoff providerKey={readModel.routeContext.providerKey} />

      <ProgressiveDisclosure
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.supporting.command.plan")}
        icon="dashboard"
      >
        <CatalogIntegrationCommandPlanDetail readModel={readModel} />
      </ProgressiveDisclosure>
    </WorkbenchStack>
  );
}

// The preview's read-only pre-write validation: which eligible observations
// were validated, and the bounded identity verdicts. Only structured resolver
// evidence (reason, token names, template key) is shown; a draft-only carry
// stays visible as a non-blocking item so the operator sees what they accepted.
function CatalogIntegrationPromotionValidation({
  validation,
}: Readonly<{ validation: CatalogPrimaryWorkbenchReadModel["promotionPreview"]["validation"] }>) {
  if (validation.coverage === "not-previewed") {
    return null;
  }
  const blockedIdentityCount = validation.identityDiagnostics.filter((diagnostic) => diagnostic.blocking).length;
  const draftOnlyCount = validation.identityDiagnostics.length - blockedIdentityCount;

  return (
    <WorkbenchStack gap="sm">
      <WorkbenchText tone="foreground" weight="semibold" size="sm">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.title")}
      </WorkbenchText>
      <WorkbenchText size="xs" tone="secondary">
        {validation.coverage === "complete"
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.coverage.complete", {
              count: validation.coveredCount,
            })
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.coverage.partial", {
              count: validation.coveredCount,
            })}
      </WorkbenchText>
      {blockedIdentityCount > 0 ? (
        <WorkbenchText size="xs" tone="foreground" weight="semibold">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.blocked", {
            count: blockedIdentityCount,
          })}
        </WorkbenchText>
      ) : null}
      {draftOnlyCount > 0 ? (
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.draftOnly", {
            count: draftOnlyCount,
          })}
        </WorkbenchText>
      ) : null}
      {validation.otherBlockedObservationIds.length > 0 ? (
        <WorkbenchText size="xs" tone="secondary">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.other.blocked", {
            count: validation.otherBlockedObservationIds.length,
          })}
        </WorkbenchText>
      ) : null}
      <StatusReasonList
        compact
        items={validation.identityDiagnostics.map((diagnostic) => ({
          key: `${diagnostic.observationId}:${diagnostic.templateReason}`,
          label: identityReasonLabel(diagnostic.templateReason),
          tone: diagnostic.blocking ? "danger" : "warning",
          reason:
            diagnostic.missingTokens.length > 0
              ? t(
                  "catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.observation",
                  {
                    observationId: diagnostic.observationId,
                    reason: diagnostic.diagnosticText,
                    tokens: diagnostic.missingTokens.join(", "),
                  },
                )
              : t(
                  "catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.observation.noTokens",
                  {
                    observationId: diagnostic.observationId,
                    reason: diagnostic.diagnosticText,
                  },
                ),
        }))}
      />
    </WorkbenchStack>
  );
}

function identityReasonLabel(
  reason: CatalogPrimaryWorkbenchReadModel["promotionPreview"]["validation"]["identityDiagnostics"][number]["templateReason"],
): string {
  switch (reason) {
    case "unresolved-title-tokens":
      return t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.reason.unresolvedTitleTokens",
      );
    case "no-targeted-template":
      return t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.reason.noTargetedTemplate",
      );
    case "missing-required-fields":
      return t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.validation.identity.reason.missingRequiredFields",
      );
  }
}

function CatalogIntegrationPromotionOutcome({
  result,
}: Readonly<{ result: NonNullable<CatalogPrimaryWorkbenchReadModel["promotionResult"]> }>) {
  const tone = result.status === "completed" ? "success" : result.status === "partial" ? "warning" : "danger";

  return (
    <WorkbenchDetailPanel>
      <WorkbenchActionRow align="between">
        <WorkbenchStack gap="sm">
          <WorkbenchText tone="foreground" weight="semibold">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.outcome.title")}
          </WorkbenchText>
          <WorkbenchText size="xs" tone="secondary">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.outcome.description", {
              resultId: result.resultId,
            })}
          </WorkbenchText>
        </WorkbenchStack>
        <BadgeCluster
          items={[
            {
              key: "outcome",
              label: stateLabel(result.status),
              tone,
            },
          ]}
        />
      </WorkbenchActionRow>
      <WorkbenchGrid columns="detail">
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.matched"),
              value: result.requestedCount,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.outcome.promoted"),
              value: result.promotedCount,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.skipped"),
              value: result.skippedCount,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.command.count.failed"),
              value: result.failedCount,
            },
          ]}
        />
        <KeyValueList
          items={[
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.outcome.job"),
              value: result.jobId,
            },
            {
              key: t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.outcome.recordedAt"),
              value: result.completedAt,
            },
          ]}
        />
      </WorkbenchGrid>
      {result.redactedFailureReasons.map((reason) => (
        <WorkbenchText key={reason} size="xs" tone="secondary">
          {reason}
        </WorkbenchText>
      ))}
    </WorkbenchDetailPanel>
  );
}

// The seam to the Catalog Items area. Promotion writes draft Catalog Items that are
// finished and published in a SEPARATE Catalog Items area, so the daily Create /
// update stage names that handoff and deep-links to the just-created/updated drafts
// for this provider (filtered by `?source=`). The link is the only crossing — no
// catalog-item editing is duplicated inside the integration surface.
function CatalogIntegrationCreateItemsHandoff({ providerKey }: Readonly<{ providerKey: string | null }>) {
  const scopedProvider = providerKey?.trim() ?? "";

  return (
    <WorkbenchDetailPanel>
      <WorkbenchActionRow align="between">
        <WorkbenchStack gap="sm">
          <WorkbenchText tone="foreground" weight="semibold">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.handoff.title")}
          </WorkbenchText>
          <WorkbenchText size="xs" tone="secondary">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.handoff.description")}
          </WorkbenchText>
        </WorkbenchStack>
        <LinkButton
          size="sm"
          tone="secondary"
          leadingIcon="externalLink"
          href={catalogItemsBySourceProviderHref(scopedProvider)}
        >
          {scopedProvider
            ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.handoff.cta", {
                provider: scopedProvider,
              })
            : t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.handoff.cta.unscoped")}
        </LinkButton>
      </WorkbenchActionRow>
    </WorkbenchDetailPanel>
  );
}
