import type { ReactNode } from "react";
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Form,
  KeyValueList,
  LinkButton,
  MetricStrip,
  OperationalStatusBanner,
  WorkflowModule,
  type DataColumn,
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
        <div className="grid min-w-0 gap-1">
          <div className="text-sm font-semibold text-foreground">{profile.displayName}</div>
          <div className="text-xs leading-5 text-secondary">
            {profile.profileKey}@{profile.profileVersion}
          </div>
        </div>
      ),
    },
    {
      key: "lifecycle",
      header: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.lifecycle"),
      mobileLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.table.lifecycle"),
      cell: (profile) => (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <Badge tone={profile.active ? "success" : lifecycleTone(profile.lifecycle)}>
            {stateLabel(profile.lifecycle)}
          </Badge>
          {profile.active ? (
            <Badge tone="accent">{t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.active")}</Badge>
          ) : null}
        </div>
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
    <section className="grid min-w-0 gap-4" data-catalog-profile-authoring-workspace="true">
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
        <div className="grid gap-4">
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
        </div>
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
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
          <div className="grid min-w-0 gap-4">
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
          </div>

          <Form
            spacing="md"
            method="post"
            action={cloneDraft.submitHref}
            data-catalog-primary-workbench-command="clone-provider-profile"
            className="grid min-w-0 gap-3 rounded-md border border-border-subtle p-4"
          >
            <ProfileAuthoringHiddenInputs readModel={readModel} authoring={authoring} />
            <label className="grid gap-1 text-sm font-semibold text-foreground">
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.target.label")}
              <input
                className="min-h-10 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm font-normal text-foreground"
                name="targetProfileVersion"
                defaultValue={cloneDraft.targetProfileVersion ?? ""}
                disabled={cloneDisabled}
                required
              />
            </label>
            <div className="text-xs leading-5 text-secondary">
              {cloneDraft.state === "denied"
                ? t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.denied")
                : t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.help")}
            </div>
            <Button type="submit" leadingIcon="plus" disabled={cloneDisabled}>
              {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.draft.submit")}
            </Button>
          </Form>
        </div>
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
    </section>
  );
}

function ProfileSectionWorkspaces({
  readModel,
  authoring,
}: {
  readModel: CatalogPrimaryWorkbenchReadModel;
  authoring: ProfileAuthoringReadModel;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
      <div className="grid gap-3 lg:sticky lg:top-24">
        <label className="grid gap-1 text-sm font-semibold text-foreground lg:hidden">
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.mobile.label")}
          <select
            className="min-h-10 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm font-normal text-foreground"
            defaultValue={authoring.sectionWorkspaces[0]?.anchorId}
            onChange={(event) => {
              const target = document.getElementById(event.currentTarget.value);
              target?.focus();
              target?.scrollIntoView({ block: "start" });
            }}
          >
            {authoring.sectionWorkspaces.map((workspace) => (
              <option key={workspace.sectionKey} value={workspace.anchorId}>
                {workspace.displayName}
              </option>
            ))}
          </select>
        </label>

        <nav
          className="hidden gap-4 rounded-md border border-border-subtle p-3 lg:grid"
          aria-label={t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.navigation")}
        >
          {authoring.sectionGroups.map((group) => {
            const sections = authoring.sectionWorkspaces.filter((workspace) =>
              group.sections.includes(workspace.sectionKey),
            );
            if (sections.length === 0) {
              return null;
            }

            return (
              <div key={group.key} className="grid gap-1">
                <div className="text-xs font-semibold uppercase tracking-normal text-secondary">{group.label}</div>
                {sections.map((workspace) => (
                  <a
                    key={workspace.sectionKey}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-foreground hover:bg-surface-muted"
                    href={`#${workspace.anchorId}`}
                  >
                    <span className="truncate">{workspace.displayName}</span>
                    <Badge tone={sectionStatusTone(workspace.status)}>{stateLabel(workspace.status)}</Badge>
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
      </div>

      <div className="grid min-w-0 gap-4">
        {authoring.sectionWorkspaces.map((workspace) => (
          <ProfileSectionWorkspaceCard key={workspace.sectionKey} readModel={readModel} workspace={workspace} />
        ))}
      </div>
    </div>
  );
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
    <section
      id={workspace.anchorId}
      tabIndex={-1}
      className="grid gap-4 border-t border-border-subtle pt-4 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-catalog-profile-section-workspace={workspace.sectionKey}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-normal text-accent">{workspace.groupLabel}</div>
          <h3 className="mt-1 text-base font-semibold text-foreground">{workspace.displayName}</h3>
          <p className="mt-1 text-sm leading-6 text-secondary">{workspace.description}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Badge tone={sectionStatusTone(workspace.status)}>{stateLabel(workspace.status)}</Badge>
          <Badge tone={actionTone(workspace.actionState)}>{stateLabel(workspace.actionState)}</Badge>
          <Badge
            tone={
              workspace.saveOutcome === "saved"
                ? "success"
                : workspace.saveOutcome === "not-submitted"
                  ? "neutral"
                  : "warning"
            }
          >
            {stateLabel(workspace.saveOutcome)}
          </Badge>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
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
      </div>

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

      <Form
        spacing="md"
        method="post"
        action={workspace.submitHref}
        data-catalog-primary-workbench-command="update-provider-profile-section"
        className="grid min-w-0 gap-3 rounded-md border border-border-subtle p-4"
      >
        <ProfileSectionHiddenInputs readModel={readModel} workspace={workspace} />
        <div className="grid gap-3 md:grid-cols-2">
          {workspace.fields.map((fieldEntry) => (
            <ProfileSectionFieldControl key={fieldEntry.key} field={fieldEntry} />
          ))}
        </div>
        <Button type="submit" leadingIcon="check" disabled={saveDisabled}>
          {t("catalog.features.sourceObservations.ui.primaryWorkbench.profile.sections.save")}
        </Button>
      </Form>
    </section>
  );
}

function ProfileSectionFieldControl({ field }: { field: ProfileSectionWorkspace["fields"][number] }) {
  const labelClassName = "grid gap-1 text-sm font-semibold text-foreground";
  const controlClassName =
    "min-h-10 rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm font-normal text-foreground disabled:bg-surface-muted disabled:text-secondary";

  if (field.control === "textarea") {
    return (
      <label className={labelClassName}>
        {field.label}
        <textarea
          className={`${controlClassName} min-h-24`}
          name={field.key}
          defaultValue={field.value}
          disabled={field.disabled}
          required={field.required}
        />
        {field.helpText ? <span className="text-xs font-normal leading-5 text-secondary">{field.helpText}</span> : null}
      </label>
    );
  }

  if (field.control === "select") {
    return (
      <label className={labelClassName}>
        {field.label}
        <select
          className={controlClassName}
          name={field.key}
          defaultValue={field.value}
          disabled={field.disabled}
          required={field.required}
        >
          {field.options.length === 0 ? <option value={field.value}>{field.value || "Not selected"}</option> : null}
          {field.options.map((optionEntry) => (
            <option key={optionEntry.value} value={optionEntry.value}>
              {optionEntry.label}
            </option>
          ))}
        </select>
        {field.helpText ? <span className="text-xs font-normal leading-5 text-secondary">{field.helpText}</span> : null}
      </label>
    );
  }

  if (field.control === "checkbox") {
    return (
      <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-foreground">
        <input
          className="h-4 w-4 rounded border-border-subtle"
          type="checkbox"
          name={field.key}
          value="true"
          defaultChecked={field.value === "true"}
          disabled={field.disabled}
        />
        <span>{field.label}</span>
        {field.helpText ? <span className="text-xs font-normal leading-5 text-secondary">{field.helpText}</span> : null}
      </label>
    );
  }

  return (
    <label className={labelClassName}>
      {field.label}
      <input
        className={controlClassName}
        name={field.key}
        defaultValue={field.value}
        disabled={field.disabled}
        required={field.required}
      />
      {field.helpText ? <span className="text-xs font-normal leading-5 text-secondary">{field.helpText}</span> : null}
    </label>
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
      <input type="hidden" name="_intent" value="update-provider-profile-section" />
      <input type="hidden" name="sectionKey" value={workspace.sectionKey} />
      <input type="hidden" name="providerKey" value={selectedProfile?.providerKey ?? context.providerKey ?? ""} />
      <input type="hidden" name="unitKey" value={context.unitKey ?? ""} />
      <input type="hidden" name="importScope" value={context.importScope ?? ""} />
      <input
        type="hidden"
        name="profileVersion"
        value={selectedProfile?.profileVersion ?? context.profileVersion ?? ""}
      />
      <input type="hidden" name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <input type="hidden" name="jobId" value={context.jobId ?? ""} />
      <input type="hidden" name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

function ProfileOverviewEvidence({ profile }: { profile: ProfileOverview }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
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
    </div>
  );
}

function EvidencePanel({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description: string;
  status: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t border-border-subtle pt-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-secondary">{description}</p>
        </div>
        {status}
      </div>
      {children}
    </section>
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
      <input type="hidden" name="_intent" value="clone-provider-profile" />
      <input type="hidden" name="providerKey" value={cloneDraft.sourceProviderKey ?? context.providerKey ?? ""} />
      <input type="hidden" name="unitKey" value={context.unitKey ?? ""} />
      <input type="hidden" name="importScope" value={context.importScope ?? ""} />
      <input
        type="hidden"
        name="profileVersion"
        value={cloneDraft.sourceProfileVersion ?? context.profileVersion ?? ""}
      />
      <input type="hidden" name="sourceProviderKey" value={cloneDraft.sourceProviderKey ?? ""} />
      <input type="hidden" name="sourceProfileVersion" value={cloneDraft.sourceProfileVersion ?? ""} />
      <input type="hidden" name="targetLifecycle" value={cloneDraft.targetLifecycle} />
      <input type="hidden" name="selectedObservationIds" value={context.selectedObservationIds.join(",")} />
      <input type="hidden" name="jobId" value={context.jobId ?? ""} />
      <input type="hidden" name="promotionPreviewId" value={context.promotionPreviewId ?? ""} />
    </>
  );
}

function EvidenceList({
  title,
  items,
}: {
  title: string;
  items: readonly Readonly<{
    key: string;
    label: string;
    description: string;
    tone: "success" | "warning" | "danger" | "neutral" | "info";
  }>[];
}) {
  return (
    <div className="grid gap-2">
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <div className="grid gap-2">
        {items.length > 0 ? (
          items.map((item) => (
            <div key={item.key} className="grid gap-1 rounded-md border border-border-subtle p-3">
              <div className="flex min-w-0 flex-wrap gap-1.5">
                <Badge tone={item.tone}>{item.label}</Badge>
              </div>
              <div className="text-xs leading-5 text-secondary">{item.description}</div>
            </div>
          ))
        ) : (
          <Badge tone="neutral">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>
        )}
      </div>
    </div>
  );
}

function ProfileBlockerList({ blockers }: { blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] }) {
  if (blockers.length === 0) {
    return <Badge tone="success">{t("catalog.features.sourceObservations.ui.primaryWorkbench.none")}</Badge>;
  }

  return (
    <div className="grid gap-2">
      <div className="text-sm font-semibold text-foreground">
        {t("catalog.features.sourceObservations.ui.primaryWorkbench.table.blockers")}
      </div>
      {blockers.map((blocker) => {
        const copy = getCatalogPrimaryWorkbenchBlockerCopy(blocker);

        return (
          <div key={blocker} className="grid gap-1 rounded-md border border-border-subtle p-3">
            <div className="flex min-w-0 flex-wrap gap-1.5">
              <Badge tone={blockerTone(blocker)}>{copy.label}</Badge>
            </div>
            <div className="text-xs leading-5 text-secondary">
              {copy.reason} {t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.next.prefix")}{" "}
              {copy.nextStep}
            </div>
          </div>
        );
      })}
    </div>
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
