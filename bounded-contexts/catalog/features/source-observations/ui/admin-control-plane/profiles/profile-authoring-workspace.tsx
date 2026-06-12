import {
  Badge,
  BadgeCluster,
  Button,
  Checkbox,
  DataTable,
  DenseAdminWorkbenchLayout,
  EmptyState,
  EvidenceList,
  EvidencePanel,
  HiddenInput,
  KeyValueList,
  LinkButton,
  MetricStrip,
  NativeSelect,
  OperationalStatusBanner,
  StatusReasonList,
  Textarea,
  TextInput,
  WorkbenchDataCell,
  WorkbenchForm,
  WorkbenchFormGrid,
  WorkbenchGrid,
  WorkbenchStack,
  WorkbenchText,
  WorkbenchValueList,
  WorkflowModule,
  type DataColumn,
  type SectionNavigationGroup,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "../../../api/primary-workbench-admin-contracts";
import { catalogPrimaryWorkbenchHref } from "../../primary-workbench-route-context";
import { getCatalogPrimaryWorkbenchBlockerCopy } from "../../primary-workbench-copy";

type ProfileAuthoringReadModel = CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
type ProfileOverview = NonNullable<ProfileAuthoringReadModel["selectedProfile"]>;
type ProfileOption = ProfileAuthoringReadModel["availableProfiles"][number];
type ProfileSectionWorkspace = ProfileAuthoringReadModel["sectionWorkspaces"][number];
type BadgeTone = "success" | "warning" | "danger" | "neutral" | "info" | "accent";

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
        actions={
          <LinkButton size="sm" tone="secondary" leadingIcon="chevronLeft" href={authoring.returnToPrimaryHref}>
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.back")}
          </LinkButton>
        }
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

function ProfileSectionWorkspaces({
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
        data-catalog-primary-workbench-command="update-provider-profile-section"
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

function ProviderOptionQueryDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  if (workspace.sectionKey !== "provider-options" || workspace.optionQueries.length === 0) {
    return null;
  }

  const columns: DataColumn<ProfileSectionWorkspace["optionQueries"][number]>[] = [
    {
      key: "query",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.query"),
      sortable: true,
      cell: (query) => (
        <WorkbenchDataCell
          title={query.displayName}
          description={query.queryKind}
          descriptionVariant="mono"
          badges={
            <BadgeCluster
              items={query.aliases.map((alias) => ({
                key: alias,
                label: alias,
                tone: "neutral",
              }))}
            />
          }
        />
      ),
    },
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.scope"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.scope"),
      cell: (query) => (
        <WorkbenchStack gap="sm">
          <BadgeCluster
            items={[
              { key: "scope", label: query.scope, tone: "info" },
              ...(query.parentScope
                ? [
                    {
                      key: "parent",
                      label: query.parentScope,
                      tone: query.parentRequired ? ("warning" as const) : ("neutral" as const),
                    },
                  ]
                : []),
            ]}
          />
          {query.parentDiagnosticText ? <WorkbenchText size="xs">{query.parentDiagnosticText}</WorkbenchText> : null}
          {query.parentValueKind ? <WorkbenchText size="xs">{query.parentValueKind}</WorkbenchText> : null}
        </WorkbenchStack>
      ),
    },
    {
      key: "operation",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.operation"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.operation"),
      cell: (query) => (
        <WorkbenchText size="xs" wrap="anywhere">
          {query.operation}
        </WorkbenchText>
      ),
    },
    {
      key: "output",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.output"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.output"),
      cell: (query) => (
        <WorkbenchStack gap="sm">
          {query.outputMappings.map((mapping) => (
            <WorkbenchDataCell
              key={mapping.key}
              title={mapping.label}
              description={mapping.path}
              descriptionVariant="mono"
            />
          ))}
        </WorkbenchStack>
      ),
    },
    {
      key: "cache",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.cache"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.cache"),
      cell: (query) => (
        <WorkbenchStack gap="sm">
          <BadgeCluster
            items={[
              {
                key: "status",
                label: query.cacheState.label,
                tone: optionQueryHealthTone(query.cacheState.status),
              },
              ...(query.cacheState.cacheOnly
                ? [
                    {
                      key: "cache-only",
                      label: t(
                        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.cacheOnly",
                      ),
                      tone: "warning" as const,
                    },
                  ]
                : []),
            ]}
          />
          <WorkbenchText size="xs">{query.cacheState.description}</WorkbenchText>
          {query.cacheState.diagnosticCodes.length > 0 ? (
            <WorkbenchText size="xs" wrap="anywhere">
              {query.cacheState.diagnosticCodes.join(", ")}
            </WorkbenchText>
          ) : null}
        </WorkbenchStack>
      ),
    },
  ];

  return (
    <EvidencePanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.optionQueries.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.optionQueries.description",
      )}
      status={<Badge tone="neutral">{workspace.optionQueries.length}</Badge>}
    >
      <DataTable rows={[...workspace.optionQueries]} columns={columns} getRowId={(query) => query.queryKind} />
    </EvidencePanel>
  );
}

function ImportScopeControlDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  if (workspace.importScopeControls.length === 0) {
    return null;
  }

  const columns: DataColumn<ProfileSectionWorkspace["importScopeControls"][number]>[] = [
    {
      key: "scope",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.importScope"),
      sortable: true,
      cell: (scope) => (
        <WorkbenchDataCell
          title={scope.label}
          description={scope.scope}
          descriptionVariant="mono"
          detail={scope.importScope}
        />
      ),
    },
    {
      key: "state",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.state"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.state"),
      cell: (scope) => (
        <WorkbenchStack gap="sm">
          <Badge tone={importScopeTone(scope.state)}>{stateLabel(scope.state)}</Badge>
          {scope.reason ? <WorkbenchText size="xs">{scope.reason}</WorkbenchText> : null}
        </WorkbenchStack>
      ),
    },
    {
      key: "volume",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.volume"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.volume"),
      cell: (scope) => (
        <WorkbenchValueList>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.expected", {
              count: String(scope.expectedObservationCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.observed", {
              count: String(scope.observedCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.changed", {
              count: String(scope.changedCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.promoted", {
              count: String(scope.promotedCount),
            })}
          </WorkbenchText>
          <WorkbenchText size="xs">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.volume.rejected", {
              count: String(scope.rejectedCount),
            })}
          </WorkbenchText>
        </WorkbenchValueList>
      ),
    },
    {
      key: "action",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.table.action"),
      align: "right",
      cell: (scope) =>
        scope.href ? (
          <LinkButton size="sm" tone={scope.state === "selected" ? "secondary" : "primary"} href={scope.href}>
            {scope.state === "selected"
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.action.selected")
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.action.useScope")}
          </LinkButton>
        ) : (
          <Badge tone="neutral">
            {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.action.unavailable")}
          </Badge>
        ),
    },
  ];

  return (
    <EvidencePanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.importScopes.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.importScopes.description",
      )}
      status={<Badge tone="neutral">{workspace.importScopeControls.length}</Badge>}
    >
      <DataTable rows={[...workspace.importScopeControls]} columns={columns} getRowId={(scope) => scope.scope} />
    </EvidencePanel>
  );
}

function MappingRowDetails({ workspace }: { workspace: ProfileSectionWorkspace }) {
  if (workspace.mappingRows.length === 0) {
    return null;
  }

  const columns: DataColumn<ProfileSectionWorkspace["mappingRows"][number]>[] = [
    {
      key: "mapping",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.mapping"),
      sortable: true,
      cell: (row) => <WorkbenchDataCell title={row.label} description={row.path} descriptionVariant="mono" />,
    },
    {
      key: "summary",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.summary"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.summary"),
      cell: (row) => (
        <WorkbenchText size="xs" wrap="anywhere">
          {row.summary}
        </WorkbenchText>
      ),
    },
    {
      key: "ownership",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.ownership"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.ownership"),
      cell: (row) => (
        <WorkbenchStack gap="sm">
          <BadgeCluster
            items={[
              ...(row.owner ? [{ key: "owner", label: row.owner, tone: "info" as const }] : []),
              ...(row.redaction
                ? [
                    {
                      key: "redaction",
                      label: row.redaction,
                      tone: row.redaction === "none" ? ("neutral" as const) : ("warning" as const),
                    },
                  ]
                : []),
            ]}
          />
          {row.uses.length > 0 ? (
            <WorkbenchText size="xs" wrap="anywhere">
              {row.uses.join(", ")}
            </WorkbenchText>
          ) : null}
        </WorkbenchStack>
      ),
    },
    {
      key: "editor",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.editorMetadata"),
      mobileLabel: t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.table.editorMetadata",
      ),
      cell: (row) => (
        <BadgeCluster
          items={[
            ...mappingAffordanceLabels(row).map((label) => ({
              key: label,
              label,
              tone: "neutral" as const,
            })),
            ...row.diagnostics.map((diagnostic) => ({
              key: `${diagnostic.path}:${diagnostic.diagnosticText}`,
              label: diagnostic.path,
              tone: diagnostic.severity === "error" ? ("danger" as const) : ("warning" as const),
            })),
          ]}
        />
      ),
    },
  ];

  return (
    <EvidencePanel
      title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.mappingRows.title")}
      description={t(
        "catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.mappingRows.description",
      )}
      status={<Badge tone="neutral">{workspace.mappingRows.length}</Badge>}
    >
      <DataTable rows={[...workspace.mappingRows]} columns={columns} getRowId={(row) => row.key} />
    </EvidencePanel>
  );
}

function ProfileSectionFieldControl({ field }: { field: ProfileSectionWorkspace["fields"][number] }) {
  if (field.control === "textarea") {
    return (
      <Textarea
        label={field.label}
        description={field.helpText}
        name={field.key}
        defaultValue={field.value}
        disabled={field.disabled}
        required={field.required}
      />
    );
  }

  if (field.control === "select") {
    return (
      <NativeSelect
        label={field.label}
        description={field.helpText}
        name={field.key}
        defaultValue={field.value}
        disabled={field.disabled}
        required={field.required}
        items={
          field.options.length === 0
            ? [{ value: field.value, label: field.value || "Not selected" }]
            : field.options.map((optionEntry) => ({ value: optionEntry.value, label: optionEntry.label }))
        }
      />
    );
  }

  if (field.control === "checkbox") {
    return (
      <Checkbox
        label={field.label}
        description={field.helpText}
        name={field.key}
        value="true"
        defaultChecked={field.value === "true"}
        disabled={field.disabled}
      />
    );
  }

  return (
    <TextInput
      label={field.label}
      description={field.helpText}
      name={field.key}
      defaultValue={field.value}
      disabled={field.disabled}
      required={field.required}
    />
  );
}

function ProfileSectionHiddenInputs({
  readModel,
  workspace,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  workspace: ProfileSectionWorkspace;
}) {
  const context = readModel.routeContext;
  const selectedProfile = readModel.profileAuthoring.selectedProfile;

  return (
    <>
      <HiddenInput name="_intent" value="update-provider-profile-section" />
      <HiddenInput name="sectionKey" value={workspace.sectionKey} />
      <HiddenInput name="providerKey" value={selectedProfile?.providerKey ?? context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={selectedProfile?.profileVersion ?? context.profileVersion ?? ""} />
      <HiddenInput name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <HiddenInput name="jobId" value={context.jobId ?? ""} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

function ProfileOverviewEvidence({ profile }: { profile: ProfileOverview }) {
  return (
    <WorkbenchGrid columns="two">
      <EvidencePanel
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.overview.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.overview.description")}
        status={
          <Badge tone={profile.active ? "success" : lifecycleTone(profile.lifecycle)}>
            {stateLabel(profile.lifecycle)}
          </Badge>
        }
      >
        <KeyValueList
          items={[
            keyValue(t("catalog.features.sourceObservations.ui.primaryWorkbench.key.provider"), profile.providerKey),
            keyValue(t("catalog.features.sourceObservations.ui.primaryWorkbench.key.profile"), profile.profileKey),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.version"),
              profile.profileVersion,
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.connector"),
              profile.connectorKind,
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.mapping.kind"),
              profile.mappingOutputKind,
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.mapping.fingerprint"),
              profile.mappingFingerprint ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
          ]}
        />
      </EvidencePanel>

      <EvidencePanel
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.validation.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.validation.description")}
        status={
          <Badge tone={profile.validation.status === "valid" ? "success" : "danger"}>
            {stateLabel(profile.validation.status)}
          </Badge>
        }
      >
        <KeyValueList
          items={[
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.capabilities"),
              joinOrFallback(profile.capabilities),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.scopes"),
              joinOrFallback(profile.supportedScopes),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.languages"),
              joinOrFallback(profile.languageOptions),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.executable"),
              profile.hasExecutableMappingContract
                ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.yes")
                : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.no"),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.latest.diagnostic"),
              profile.validation.latestDiagnosticText ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
          ]}
        />
      </EvidencePanel>

      <EvidencePanel
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fixtures.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fixtures.description")}
        status={
          <Badge tone={profile.fixtures.liveProviderCallsAllowed ? "warning" : "success"}>
            {profile.fixtures.liveProviderCallsAllowed
              ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fixtures.live")
              : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.fixtures.offline")}
          </Badge>
        }
      >
        <KeyValueList
          items={[
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.fixture.root"),
              profile.fixtures.fixtureRoot,
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.covered.flows"),
              joinOrFallback(profile.fixtures.coveredFlows),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.source.owner"),
              profile.sourceContract.owner,
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.source.repository"),
              profile.sourceContract.repository ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.fixture.version"),
              profile.sourceContract.fixtureSetVersion,
            ),
          ]}
        />
      </EvidencePanel>

      <EvidencePanel
        title={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.audit.title")}
        description={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.audit.description")}
        status={
          <Badge tone={profile.migrationEvidence.state === "recorded" ? "success" : "neutral"}>
            {stateLabel(profile.migrationEvidence.state)}
          </Badge>
        }
      >
        <KeyValueList
          items={[
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.created"),
              profile.authoringAudit.createdAt ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.created.by"),
              profile.authoringAudit.createdByUserId ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.updated"),
              profile.authoringAudit.updatedAt ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.updated.by"),
              profile.authoringAudit.updatedByUserId ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
            keyValue(
              t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.key.migration.recorded"),
              profile.migrationEvidence.recordedAt ??
                t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported"),
            ),
          ]}
        />
      </EvidencePanel>
    </WorkbenchGrid>
  );
}

function ProfileAuthoringHiddenInputs({
  readModel,
  authoring,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  authoring: ProfileAuthoringReadModel;
}) {
  const context = readModel.routeContext;
  const cloneDraft = authoring.cloneDraft;

  return (
    <>
      <HiddenInput name="_intent" value="clone-provider-profile" />
      <HiddenInput name="providerKey" value={cloneDraft.sourceProviderKey ?? context.providerKey ?? ""} />
      <HiddenInput name="unitKey" value={context.unitKey ?? ""} />
      <HiddenInput name="importScope" value={context.importScope ?? ""} />
      <HiddenInput name="profileVersion" value={cloneDraft.sourceProfileVersion ?? context.profileVersion ?? ""} />
      <HiddenInput name="sourceProviderKey" value={cloneDraft.sourceProviderKey ?? ""} />
      <HiddenInput name="sourceProfileVersion" value={cloneDraft.sourceProfileVersion ?? ""} />
      <HiddenInput name="targetLifecycle" value={cloneDraft.targetLifecycle} />
      <HiddenInput name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <HiddenInput name="jobId" value={context.jobId ?? ""} />
      <HiddenInput name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

function ProfileBlockerList({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>;
  }

  return (
    <StatusReasonList
      nextStepPrefix={t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}
      items={blockers.map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return {
          key: blocker,
          label: copy.label,
          reason: copy.reason,
          nextStep: copy.nextStep,
          tone: blockerTone(blocker),
        };
      })}
    />
  );
}

function keyValue(key: string, value: string) {
  return { key, value };
}

function joinOrFallback(values: readonly string[]): string {
  return values.join(", ") || t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.not.reported");
}

function profileBannerTitle(authoring: ProfileAuthoringReadModel): string {
  if (authoring.status === "stale-selection") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.stale.title");
  }
  if (authoring.status === "missing-profile") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.missing.title");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.ready.title");
}

function profileBannerDescription(authoring: ProfileAuthoringReadModel): string {
  if (authoring.status === "stale-selection") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.stale.description");
  }
  if (authoring.status === "missing-profile") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.missing.description");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.banner.ready.description");
}

function authoringTone(status: ProfileAuthoringReadModel["status"]) {
  if (status === "ready") {
    return "success";
  }

  return "warning";
}

function actionTone(state: CatalogPrimaryWorkbenchActionState) {
  if (state === "available") {
    return "success";
  }
  if (state === "denied" || state === "blocked" || state === "unsafe") {
    return "danger";
  }
  if (state === "degraded") {
    return "warning";
  }

  return "neutral";
}

function optionQueryHealthTone(
  status: ProfileSectionWorkspace["optionQueries"][number]["cacheState"]["status"],
): BadgeTone {
  if (status === "ready") {
    return "success";
  }
  if (status === "degraded") {
    return "warning";
  }
  if (status === "blocked") {
    return "danger";
  }

  return "neutral";
}

function importScopeTone(state: ProfileSectionWorkspace["importScopeControls"][number]["state"]): BadgeTone {
  if (state === "selected") {
    return "success";
  }
  if (state === "available") {
    return "info";
  }

  return "warning";
}

function mappingAffordanceLabels(row: ProfileSectionWorkspace["mappingRows"][number]): readonly string[] {
  return [
    row.previewAvailable
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.preview")
      : null,
    row.affordances.duplicate
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.duplicate")
      : null,
    row.affordances.reorder
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.reorder")
      : null,
    row.affordances.remove
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.remove")
      : null,
    row.affordances.inlineDiagnostics
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.inlineDiagnostics")
      : null,
    row.affordances.longPathSafe
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sectionDetails.affordance.longPaths")
      : null,
  ].filter((label): label is string => Boolean(label));
}

function lifecycleTone(lifecycle: string) {
  switch (lifecycle.toLowerCase()) {
    case "active":
      return "success";
    case "draft":
    case "test":
      return "info";
    case "deprecated":
      return "warning";
    case "retired":
      return "danger";
    default:
      return "neutral";
  }
}

function sectionStatusTone(status: ProfileSectionWorkspace["status"]) {
  switch (status) {
    case "valid":
      return "success";
    case "warning":
      return "warning";
    case "error":
    case "blocked":
      return "danger";
  }
}

function restrictionTone(severity: "info" | "warning" | "blocked") {
  if (severity === "blocked") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }

  return "info";
}

function blockerTone(blocker: CatalogPrimaryWorkbenchBlockerCategory) {
  if (blocker.includes("permission") || blocker.includes("authorization")) {
    return "danger";
  }
  if (blocker.includes("active-job") || blocker.includes("concurrent")) {
    return "warning";
  }

  return "danger";
}

function stateLabel(state: string): string {
  return state
    .split("-")
    .join(" ")
    .replace(/^\w/, (char) => char.toUpperCase());
}
