import { Badge, EvidencePanel, KeyValueList, WorkbenchGrid } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { stateLabel } from "../import-to-promotion/workbench-formatting";
import { joinOrFallback, keyValue, lifecycleTone, type ProfileOverview } from "./profile-formatting";

export function ProfileOverviewEvidence({ profile }: { profile: ProfileOverview }) {
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
