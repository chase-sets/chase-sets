import {
  Badge,
  BadgeCluster,
  Button,
  DenseAdminWorkbenchLayout,
  EvidenceList,
  EvidencePanel,
  KeyValueList,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchGrid,
  WorkbenchStack,
  type SectionNavigationGroup,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { actionTone, stateLabel } from "../import-to-promotion/workbench-formatting";
import { ProfileBlockerList } from "./profile-blocker-list";
import {
  keyValue,
  sectionStatusTone,
  type ProfileAuthoringReadModel,
  type ProfileSectionWorkspace,
} from "./profile-formatting";
import { ProfileSectionHiddenInputs } from "./profile-hidden-inputs";
import { ProfileSectionFieldControl } from "./profile-section-field-control";
import { ImportScopeControlDetails } from "./profile-import-scope-details";
import { MappingRowDetails } from "./profile-mapping-row-details";
import { ProviderOptionQueryDetails } from "./profile-option-query-details";

export function ProfileSectionWorkspaces({
  readModel,
  authoring,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  authoring: ProfileAuthoringReadModel;
}) {
  const navigationGroups = profileSectionNavigationGroups(authoring);
  const activeNavigationKey = navigationGroups[0]?.items[0]?.key ?? "";

  return (
    <DenseAdminWorkbenchLayout
      navigationGroups={navigationGroups}
      activeNavigationKey={activeNavigationKey}
      navigationLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.navigation")}
      mobileNavigationLabel={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.mobile.label")}
      onNavigationSelect={(key) => {
        const target = document.getElementById(key);
        target?.focus();
        target?.scrollIntoView({ block: "start" });
      }}
    >
      <WorkbenchStack>
        {authoring.sectionWorkspaces.map((workspace) => (
          <ProfileSectionWorkspaceCard key={workspace.sectionKey} readModel={readModel} workspace={workspace} />
        ))}
      </WorkbenchStack>
    </DenseAdminWorkbenchLayout>
  );
}

function profileSectionNavigationGroups(authoring: ProfileAuthoringReadModel): SectionNavigationGroup[] {
  return authoring.sectionGroups
    .map((group) => ({
      key: group.key,
      label: group.label,
      items: authoring.sectionWorkspaces
        .filter((workspace) => group.sections.includes(workspace.sectionKey))
        .map((workspace) => ({
          key: workspace.anchorId,
          label: workspace.displayName,
          href: `#${workspace.anchorId}`,
          state:
            workspace.status === "valid"
              ? ("default" as const)
              : workspace.status === "blocked"
                ? ("blocked" as const)
                : ("warning" as const),
          statusLabel: stateLabel(workspace.status),
        })),
    }))
    .filter((group) => group.items.length > 0);
}

function ProfileSectionWorkspaceCard({
  readModel,
  workspace,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  workspace: ProfileSectionWorkspace;
}) {
  const saveDisabled = !workspace.editable;

  return (
    <EvidencePanel
      id={workspace.anchorId}
      tabIndex={-1}
      eyebrow={workspace.groupLabel}
      title={workspace.displayName}
      description={workspace.description}
      status={
        <BadgeCluster
          align="end"
          items={[
            { key: "status", label: stateLabel(workspace.status), tone: sectionStatusTone(workspace.status) },
            { key: "action", label: stateLabel(workspace.actionState), tone: actionTone(workspace.actionState) },
            {
              key: "save",
              label: stateLabel(workspace.saveOutcome),
              tone:
                workspace.saveOutcome === "saved"
                  ? "success"
                  : workspace.saveOutcome === "not-submitted"
                    ? "neutral"
                    : "warning",
            },
          ]}
        />
      }
      data-catalog-profile-section-workspace={workspace.sectionKey}
    >
      <WorkbenchGrid columns="three">
        <KeyValueList
          items={[
            keyValue("Domain", workspace.domainConcept),
            keyValue("Dirty state", stateLabel(workspace.dirtyState)),
            keyValue("Stale state", stateLabel(workspace.staleState)),
          ]}
        />
        <KeyValueList
          items={[
            keyValue("Diagnostics", String(workspace.diagnostics.length)),
            keyValue("Semantic changes", String(workspace.semanticChangeCount)),
            keyValue("Readiness checks", String(workspace.readinessCheckCount)),
          ]}
        />
        <ProfileBlockerList blockers={workspace.blockers} />
      </WorkbenchGrid>

      {workspace.diagnostics.length > 0 ? (
        <EvidenceList
          title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.diagnostics")}
          items={workspace.diagnostics.map((diagnostic) => ({
            key: `${diagnostic.path}:${diagnostic.diagnosticText}`,
            label: diagnostic.path,
            description: diagnostic.diagnosticText,
            tone: diagnostic.severity === "error" ? "danger" : "warning",
          }))}
        />
      ) : null}

      <ProfileSectionDomainDetails workspace={workspace} />

      <WorkbenchForm
        method="post"
        action={workspace.submitHref}
        data-catalog-primary-workbench-command="provider-profile.edit-section"
      >
        <ProfileSectionHiddenInputs readModel={readModel} workspace={workspace} />
        <WorkbenchFormGrid>
          {workspace.fields.map((fieldEntry) => (
            <ProfileSectionFieldControl key={fieldEntry.key} field={fieldEntry} />
          ))}
        </WorkbenchFormGrid>
        <Button type="submit" leadingIcon="check" disabled={saveDisabled}>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.save")}
        </Button>
      </WorkbenchForm>
    </EvidencePanel>
  );
}

function ProfileSectionDomainDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  return (
    <WorkbenchStack>
      <ProviderOptionQueryDetails workspace={workspace} />
      <ImportScopeControlDetails workspace={workspace} />
      <MappingRowDetails workspace={workspace} />
    </WorkbenchStack>
  );
}
