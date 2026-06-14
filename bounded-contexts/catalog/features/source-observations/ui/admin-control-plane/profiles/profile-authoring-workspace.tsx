import {
  Badge,
  BadgeCluster,
  Button,
  DataTable,
  EmptyState,
  EvidenceList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  TextInput,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchGrid,
  WorkbenchStack,
  WorkflowModule,
  type DataColumn,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import { actionTone, stateLabel } from "../import-to-promotion/workbench-formatting";
import { ProfileBlockerList } from "./profile-blocker-list";
import {
  authoringTone,
  lifecycleTone,
  profileBannerDescription,
  profileBannerTitle,
  restrictionTone,
  type ProfileOption,
} from "./profile-formatting";
import { ProfileAuthoringHiddenInputs } from "./profile-hidden-inputs";
import { ProfileOverviewEvidence } from "./profile-overview-evidence";
import { ProfileSectionWorkspaces } from "./profile-section-workspaces";

export function CatalogIntegrationProfileAuthoringWorkspace({
  readModel,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
}) {
  const authoring = readModel.profileAuthoring;
  const selectedProfile = authoring.selectedProfile;
  const cloneDraft = authoring.cloneDraft;
  const cloneDisabled = cloneDraft.state !== "available" && cloneDraft.state !== "degraded";
  const columns: DataColumn<ProfileOption>[] = [
    {
      key: "profile",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.profile"),
      sortable: true,
      cell: (profile) => (
        <WorkbenchDataCell
          title={profile.displayName}
          description={`${profile.profileKey}@${profile.profileVersion}`}
        />
      ),
    },
    {
      key: "lifecycle",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.lifecycle"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.lifecycle"),
      cell: (profile) => (
        <BadgeCluster
          items={[
            {
              key: "lifecycle",
              label: stateLabel(profile.lifecycle),
              tone: profile.active ? "success" : lifecycleTone(profile.lifecycle),
            },
            ...(profile.active
              ? [
                  {
                    key: "active",
                    label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.active"),
                    tone: "accent" as const,
                  },
                ]
              : []),
          ]}
        />
      ),
    },
    {
      key: "status",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.status"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.status"),
      cell: (profile) => <Badge tone="neutral">{stateLabel(profile.status)}</Badge>,
    },
    {
      key: "action",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
      align: "right",
      cell: (profile) => (
        <LinkButton size="sm" tone="secondary" href={profile.href}>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.inspect")}
        </LinkButton>
      ),
    },
  ];

  return (
    <WorkbenchStack element="section" data-catalog-profile-authoring-workspace="true">
      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.description")}
        status={<Badge tone={authoringTone(authoring.status)}>{stateLabel(authoring.status)}</Badge>}
      >
        <WorkbenchStack>
          <OperationalStatusBanner
            tone={authoring.status === "ready" ? "success" : "warning"}
            title={profileBannerTitle(authoring)}
            description={profileBannerDescription(authoring)}
          />

          <MetricStrip
            items={[
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.lifecycle"),
                value: selectedProfile ? stateLabel(selectedProfile.lifecycle) : stateLabel(authoring.status),
                trend: selectedProfile?.active
                  ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.active")
                  : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.not.active"),
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.validation"),
                value: selectedProfile ? stateLabel(selectedProfile.validation.status) : "0",
                trend: selectedProfile
                  ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.diagnostics", {
                      count: selectedProfile.validation.diagnosticCount,
                    })
                  : t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.references"),
                value: selectedProfile ? String(selectedProfile.referenceCount) : "0",
                trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.reference.trend"),
              },
              {
                label: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.fixtures"),
                value: selectedProfile ? String(selectedProfile.fixtures.coveredFlows.length) : "0",
                trend: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.metric.fixture.trend"),
              },
            ]}
          />

          {selectedProfile ? (
            <ProfileOverviewEvidence profile={selectedProfile} />
          ) : (
            <EmptyState
              title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.empty.title")}
              description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.empty.description")}
              actions={
                <LinkButton
                  tone="secondary"
                  href={catalogPrimaryWorkbenchHref(readModel.routeContext, "import-to-promotion")}
                >
                  {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.back")}
                </LinkButton>
              }
            />
          )}
        </WorkbenchStack>
      </WorkflowModule>

      {authoring.sectionWorkspaces.length > 0 ? (
        <WorkflowModule
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.title")}
          description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.description")}
          status={
            <Badge tone="neutral">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.count", {
                count: authoring.sectionWorkspaces.length,
              })}
            </Badge>
          }
        >
          <ProfileSectionWorkspaces readModel={readModel} authoring={authoring} />
        </WorkflowModule>
      ) : null}

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.description")}
        status={<Badge tone={actionTone(cloneDraft.state)}>{stateLabel(cloneDraft.state)}</Badge>}
      >
        <WorkbenchGrid columns="detail">
          <WorkbenchStack>
            <EvidenceList
              title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.restrictions")}
              items={cloneDraft.lifecycleRestrictions.map((restriction) => ({
                key: restriction.code,
                label: restriction.label,
                description: restriction.description,
                tone: restrictionTone(restriction.severity),
              }))}
            />
            <EvidenceList
              title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.immutable.facts")}
              items={cloneDraft.immutableIdentityFacts.map((fact) => ({
                key: fact.key,
                label: fact.label,
                description: fact.value,
                tone: "neutral" as const,
              }))}
            />
            <ProfileBlockerList blockers={cloneDraft.blockers} />
          </WorkbenchStack>

          <WorkbenchForm
            method="post"
            action={cloneDraft.submitHref}
            data-catalog-primary-workbench-command="clone-provider-profile"
          >
            <ProfileAuthoringHiddenInputs readModel={readModel} authoring={authoring} />
            <TextInput
              label={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.target.label")}
              description={
                cloneDraft.state === "denied"
                  ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.denied")
                  : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.help")
              }
              name="targetProfileVersion"
              defaultValue={cloneDraft.targetProfileVersion ?? ""}
              disabled={cloneDisabled}
              required
            />
            <Button type="submit" leadingIcon="plus" disabled={cloneDisabled}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.submit")}
            </Button>
          </WorkbenchForm>
        </WorkbenchGrid>
      </WorkflowModule>

      <WorkflowModule
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.list.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.list.description")}
        status={
          <Badge tone="neutral">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.list.count", {
              count: authoring.availableProfiles.length,
            })}
          </Badge>
        }
      >
        <DataTable
          rows={[...authoring.availableProfiles]}
          columns={columns}
          getRowId={(profile) => `${profile.providerKey}:${profile.profileVersion}`}
        />
      </WorkflowModule>
    </WorkbenchStack>
  );
}
