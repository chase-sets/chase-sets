import {
  Badge,
  Banner,
  LoadingSpinner,
  PageStepper,
  Stat,
  StatGrid,
  WorkbenchStack,
  WorkflowModule,
  type BadgeTone,
  type BannerProps,
  type PageStepperItem,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogScopeJourneyCondition,
  CatalogScopeJourneyOverviewReadModel,
  CatalogScopeJourneyPromotionReadiness,
  CatalogScopeJourneyStage,
} from "./scope-journey-overview";

// The scope-detail journey overview section. It replaces the per-provider-unit
// framing with a single scope-first pipeline — coverage → sync → live jobs →
// candidate review → promotion — and makes the journey's current condition
// (loading / empty / blocked / conflict / partial-failure / projection-lag /
// ready) legible at a glance. The interactive per-stage commands live in their
// own sections; this panel is the map the operator reads first.
export type CatalogScopeJourneyOverviewPanelProps = Readonly<{
  readModel: CatalogScopeJourneyOverviewReadModel;
  // Page-owned transient: true while the route is revalidating. Rendered here so
  // the "loading" state is one of the visible journey states.
  loading?: boolean;
}>;

const conditionBadgeTone: Record<CatalogScopeJourneyCondition, BadgeTone> = {
  empty: "neutral",
  "partial-failure": "warning",
  blocked: "danger",
  conflict: "warning",
  "projection-lag": "warning",
  ready: "success",
};

const conditionBannerTone: Record<CatalogScopeJourneyCondition, BannerProps["tone"]> = {
  empty: "info",
  "partial-failure": "warning",
  blocked: "danger",
  conflict: "warning",
  "projection-lag": "warning",
  ready: "success",
};

export function CatalogScopeJourneyOverviewPanel({
  readModel,
  loading = false,
}: CatalogScopeJourneyOverviewPanelProps) {
  return (
    <WorkflowModule
      title={t("catalog.features.sourceObservations.ui.scopeDetail.journey.title")}
      description={t("catalog.features.sourceObservations.ui.scopeDetail.journey.description")}
      status={<Badge tone={conditionBadgeTone[readModel.condition]}>{conditionStatusLabel(readModel.condition)}</Badge>}
      headingLevel={2}
      density="compact"
    >
      {loading ? (
        <LoadingSpinner label={t("catalog.features.sourceObservations.ui.scopeDetail.journey.loading")} />
      ) : (
        <WorkbenchStack gap="md">
          <Banner
            tone={conditionBannerTone[readModel.condition]}
            title={conditionBannerTitle(readModel.condition)}
            description={conditionBannerDescription(readModel.condition)}
          />

          <StatGrid columns={3}>
            <Stat
              label={t("catalog.features.sourceObservations.ui.scopeDetail.journey.stat.editions")}
              value={String(readModel.editionCount)}
            />
            <Stat
              label={t("catalog.features.sourceObservations.ui.scopeDetail.journey.stat.linked")}
              value={String(readModel.linkedEditionCount)}
            />
            <Stat
              label={t("catalog.features.sourceObservations.ui.scopeDetail.journey.stat.pending")}
              value={String(readModel.pendingCandidateCount)}
            />
          </StatGrid>

          <PageStepper
            items={readModel.stages.map((stage) => stageStepperItem(stage, readModel))}
            orientation="responsive"
          />
        </WorkbenchStack>
      )}
    </WorkflowModule>
  );
}

function stageStepperItem(
  stage: CatalogScopeJourneyStage,
  readModel: CatalogScopeJourneyOverviewReadModel,
): PageStepperItem {
  return {
    label: stageLabel(stage.key),
    description: stageDescription(stage, readModel),
    status: stage.status,
  };
}

function stageLabel(key: CatalogScopeJourneyStage["key"]): string {
  switch (key) {
    case "coverage":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.coverage.label");
    case "sync":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.sync.label");
    case "jobs":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.jobs.label");
    case "candidates":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.candidates.label");
    case "promotion":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.promotion.label");
  }
}

function stageDescription(stage: CatalogScopeJourneyStage, readModel: CatalogScopeJourneyOverviewReadModel): string {
  switch (stage.key) {
    case "coverage":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.coverage.description", {
        count: readModel.editionCount,
      });
    case "sync":
      return readModel.syncFreshness === "fresh"
        ? t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.sync.description.fresh")
        : t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.sync.description.stale");
    case "jobs":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.jobs.description");
    case "candidates":
      return readModel.pendingCandidateCount > 0
        ? t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.candidates.description.pending", {
            count: readModel.pendingCandidateCount,
          })
        : t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.candidates.description.clear");
    case "promotion":
      return promotionStageDescription(readModel.promotionReadiness);
  }
}

function promotionStageDescription(readiness: CatalogScopeJourneyPromotionReadiness): string {
  switch (readiness) {
    case "live":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.promotion.description.live");
    case "unpublished":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.promotion.description.unpublished");
    case "deprecated":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.promotion.description.deprecated");
    case "archived":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.stage.promotion.description.archived");
  }
}

// Literal keys (not interpolated) so the localization key-usage tooling can see
// every key this panel reads.
function conditionStatusLabel(condition: CatalogScopeJourneyCondition): string {
  switch (condition) {
    case "empty":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.status.empty");
    case "partial-failure":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.status.partialFailure");
    case "blocked":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.status.blocked");
    case "conflict":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.status.conflict");
    case "projection-lag":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.status.projectionLag");
    case "ready":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.status.ready");
  }
}

function conditionBannerTitle(condition: CatalogScopeJourneyCondition): string {
  switch (condition) {
    case "empty":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.empty.title");
    case "partial-failure":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.partialFailure.title");
    case "blocked":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.blocked.title");
    case "conflict":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.conflict.title");
    case "projection-lag":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.projectionLag.title");
    case "ready":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.ready.title");
  }
}

function conditionBannerDescription(condition: CatalogScopeJourneyCondition): string {
  switch (condition) {
    case "empty":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.empty.description");
    case "partial-failure":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.partialFailure.description");
    case "blocked":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.blocked.description");
    case "conflict":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.conflict.description");
    case "projection-lag":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.projectionLag.description");
    case "ready":
      return t("catalog.features.sourceObservations.ui.scopeDetail.journey.banner.ready.description");
  }
}
