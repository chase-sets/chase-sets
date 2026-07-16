import { useState } from "react";
import {
  BadgeCluster,
  Checkbox,
  KeyValueList,
  LinkButton,
  ProgressiveDisclosure,
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
  const previewFresh = preview.executionSafeguards.previewFresh && preview.previewId !== null;
  const scopeSummary = preview.scope.filterSummary.join(", ");

  return (
    <WorkbenchStack>
      <WorkbenchText size="sm" tone="secondary">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.description")}
      </WorkbenchText>

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

        <WorkbenchActionRow align="between">
          <WorkbenchText size="xs" tone={previewFresh ? "secondary" : "foreground"} weight="semibold">
            {previewFresh
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.fresh")
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.stage.create.preview.refresh")}
          </WorkbenchText>
          <CommandFormButton
            readModel={readModel}
            intent="observation.promote"
            promotionPhase="preview"
            size="sm"
            tone="secondary"
          >
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.preview.promotion")}
          </CommandFormButton>
        </WorkbenchActionRow>

        <Checkbox
          name="confirm-create-items"
          checked={confirmed}
          disabled={!previewFresh}
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
            leadingIcon="check"
            disabled={!previewFresh || !confirmed}
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
