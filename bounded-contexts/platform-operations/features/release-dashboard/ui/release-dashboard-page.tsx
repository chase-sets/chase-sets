import { t } from "@chase-sets/localization";
import {
  ActionBar,
  Badge,
  Cluster,
  CodeText,
  Grid,
  Inline,
  KeyValueList,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
} from "@chase-sets/design-system";
import type { ReleaseDashboardPhase, ReleaseDashboardSnapshot } from "../read-model/contracts";

const routeKey = "platformOperations.releaseDashboard";

export function ReleaseDashboardPage({ data }: Readonly<{ data: ReleaseDashboardSnapshot }>) {
  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />

      <ActionBar>
        <LinkButton href="/operations/release-controls" tone="secondary">
          {t(`${routeKey}.releaseControls`)}
        </LinkButton>
        <LinkButton href="/operations/projections" tone="secondary">
          {t(`${routeKey}.projectionOperations`)}
        </LinkButton>
      </ActionBar>

      <ReleasePosture data={data} />

      <Grid columns={{ base: 1, lg: 2 }}>
        <ReleaseTimeline data={data} />
        <ReleaseHealth data={data} />
      </Grid>
    </Page>
  );
}

function ReleasePosture({ data }: Readonly<{ data: ReleaseDashboardSnapshot }>) {
  return (
    <Surface>
      <Stack gap={4}>
        <Cluster align="center" justify="between">
          <Stack gap={2}>
            <Inline gap={2}>
              <Badge tone={postureTone(data.posture)}>{t(`${routeKey}.posture.${data.posture}`)}</Badge>
              <Badge tone={data.releaseLock.locked ? "danger" : "success"}>
                {data.releaseLock.locked ? t(`${routeKey}.locked`) : t(`${routeKey}.unlocked`)}
              </Badge>
            </Inline>
            <Text tone="secondary">{data.explanation}</Text>
          </Stack>
          <CodeText>{data.repository}</CodeText>
        </Cluster>

        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat label={t(`${routeKey}.main`)} value={data.main.shortSha} />
          <Stat label={t(`${routeKey}.productionMarker`)} value={data.productionMarker.shortSha} />
          <Stat label={t(`${routeKey}.drift`)} value={data.drift.label} />
          <Stat label={t(`${routeKey}.canary`)} value={phaseLabel(data.latestReleaseHealth.canary)} />
        </StatGrid>
      </Stack>
    </Surface>
  );
}

function ReleaseTimeline({ data }: Readonly<{ data: ReleaseDashboardSnapshot }>) {
  return (
    <PageSection title={t(`${routeKey}.releaseState`)}>
      <Surface>
        <Stack gap={4}>
          <KeyValueList
            items={[
              { key: t(`${routeKey}.prRequired`), value: phaseLabel(data.checks.prRequired) },
              { key: t(`${routeKey}.platformDeploy`), value: phaseLabel(data.checks.platformDeploy) },
              { key: t(`${routeKey}.stagingDeploy`), value: phaseLabel(data.checks.stagingDeploy) },
              { key: t(`${routeKey}.productionDeploy`), value: phaseLabel(data.checks.productionDeploy) },
              { key: t(`${routeKey}.releaseMode`), value: data.latestReleaseHealth.releaseMode },
              {
                key: t(`${routeKey}.checkedAt`),
                value: data.latestReleaseHealth.checkedAt ?? t(`${routeKey}.notRecorded`),
              },
            ]}
          />

          <Stack gap={2}>
            {data.links.latestPrRun ? (
              <LinkButton href={data.links.latestPrRun} tone="secondary">
                {t(`${routeKey}.latestPrRun`)}
              </LinkButton>
            ) : null}
            {data.links.latestDeployRun ? (
              <LinkButton href={data.links.latestDeployRun} tone="secondary">
                {t(`${routeKey}.latestDeployRun`)}
              </LinkButton>
            ) : null}
            {data.links.productionMarker ? (
              <LinkButton href={data.links.productionMarker} tone="secondary">
                {t(`${routeKey}.productionMarkerLink`)}
              </LinkButton>
            ) : null}
          </Stack>
        </Stack>
      </Surface>
    </PageSection>
  );
}

function ReleaseHealth({ data }: Readonly<{ data: ReleaseDashboardSnapshot }>) {
  return (
    <PageSection title={t(`${routeKey}.releaseHealth`)}>
      <Surface>
        <Stack gap={4}>
          <Inline gap={2}>
            <Badge tone={phaseTone(data.latestReleaseHealth.staging)}>
              {t(`${routeKey}.staging`)}: {phaseLabel(data.latestReleaseHealth.staging)}
            </Badge>
            <Badge tone={phaseTone(data.latestReleaseHealth.production)}>
              {t(`${routeKey}.production`)}: {phaseLabel(data.latestReleaseHealth.production)}
            </Badge>
          </Inline>

          <KeyValueList
            items={[
              {
                key: t(`${routeKey}.releaseCommit`),
                value: data.latestReleaseHealth.releaseCommit
                  ? data.latestReleaseHealth.releaseCommit.slice(0, 8)
                  : t(`${routeKey}.notRecorded`),
              },
              {
                key: t(`${routeKey}.workflowRun`),
                value: data.latestReleaseHealth.workflowRunId ?? t(`${routeKey}.notRecorded`),
              },
              {
                key: t(`${routeKey}.canaryDecision`),
                value: data.latestReleaseHealth.canaryDecision ?? t(`${routeKey}.notRecorded`),
              },
              { key: t(`${routeKey}.lockReason`), value: data.releaseLock.reason || t(`${routeKey}.notRecorded`) },
              {
                key: t(`${routeKey}.lockReference`),
                value: data.releaseLock.reference || t(`${routeKey}.notRecorded`),
              },
            ]}
          />
        </Stack>
      </Surface>
    </PageSection>
  );
}

function phaseLabel(value: ReleaseDashboardPhase) {
  return t(`${routeKey}.phase.${value}`);
}

function postureTone(posture: ReleaseDashboardSnapshot["posture"]) {
  if (posture === "current") {
    return "success";
  }
  if (posture === "failed" || posture === "locked") {
    return "danger";
  }
  return "warning";
}

function phaseTone(phase: ReleaseDashboardPhase) {
  if (phase === "success") {
    return "success";
  }
  if (phase === "failure" || phase === "cancelled") {
    return "danger";
  }
  if (phase === "skipped") {
    return "neutral";
  }
  return "warning";
}
