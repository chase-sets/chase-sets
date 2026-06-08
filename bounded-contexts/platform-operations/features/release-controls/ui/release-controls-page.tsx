import { t } from "@chase-sets/localization";
import {
  Form,
  ActionBar,
  Badge,
  Button,
  Checkbox,
  Cluster,
  CodeText,
  Grid,
  Inline,
  KeyValueList,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
  Textarea,
  TextInput,
} from "@chase-sets/design-system";
import type { ReleaseControlsSnapshot } from "../read-model/contracts";

const routeKey = "platformOperations.releaseControls";

export function ReleaseControlsPage({ data }: Readonly<{ data: ReleaseControlsSnapshot }>) {
  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />

      <ActionBar>
        <LinkButton href="/platform/release-dashboard" tone="secondary">
          {t(`${routeKey}.releaseDashboard`)}
        </LinkButton>
        <LinkButton href="/platform/projections" tone="secondary">
          {t(`${routeKey}.projectionOperations`)}
        </LinkButton>
        <LinkButton href="/platform/release-controls" tone="secondary">
          {t(`${routeKey}.reset`)}
        </LinkButton>
      </ActionBar>

      <ReleaseStatus data={data} />

      <Grid columns={{ base: 1, lg: 2 }}>
        <ReleaseLockPanel data={data} />
        <RolloutEvaluationPanel data={data} />
      </Grid>
    </Page>
  );
}

function ReleaseStatus({ data }: Readonly<{ data: ReleaseControlsSnapshot }>) {
  const lockTone = data.releaseLock.locked ? "danger" : "success";

  return (
    <Surface>
      <Stack gap={4}>
        <Cluster align="center" justify="between">
          <Stack gap={1}>
            <Inline gap={2}>
              <Badge tone={lockTone}>
                {data.releaseLock.locked ? t(`${routeKey}.locked`) : t(`${routeKey}.unlocked`)}
              </Badge>
              <Badge tone={data.releaseLockCommandPlan.ready ? "success" : "warning"}>
                {data.releaseLockCommandPlan.ready ? t(`${routeKey}.commandReady`) : t(`${routeKey}.needsInput`)}
              </Badge>
            </Inline>
            <Text tone="secondary">{t(`${routeKey}.statusDetail`)}</Text>
          </Stack>
          <CodeText>{data.releaseLock.environmentName}</CodeText>
        </Cluster>

        <StatGrid columns={{ base: 1, md: 3 }}>
          <Stat
            label={t(`${routeKey}.releaseLock`)}
            value={data.releaseLock.locked ? t(`${routeKey}.yes`) : t(`${routeKey}.no`)}
          />
          <Stat label={t(`${routeKey}.reason`)} value={data.releaseLock.reason || t(`${routeKey}.notRecorded`)} />
          <Stat label={t(`${routeKey}.reference`)} value={data.releaseLock.reference || t(`${routeKey}.notRecorded`)} />
        </StatGrid>
      </Stack>
    </Surface>
  );
}

function ReleaseLockPanel({ data }: Readonly<{ data: ReleaseControlsSnapshot }>) {
  const commandText = data.releaseLockCommandPlan.commands.join("\n");

  return (
    <PageSection title={t(`${routeKey}.releaseLockCommands`)}>
      <Surface>
        <Stack gap={4}>
          <Form spacing="none" method="get">
            <Stack gap={3}>
              <NativeSelect
                label={t(`${routeKey}.action`)}
                name="releaseAction"
                defaultValue={data.query.releaseAction}
                items={[
                  { value: "lock", label: t(`${routeKey}.lockAction`) },
                  { value: "unlock", label: t(`${routeKey}.unlockAction`) },
                ]}
              />
              <TextInput label={t(`${routeKey}.reason`)} name="releaseReason" defaultValue={data.query.releaseReason} />
              <TextInput
                label={t(`${routeKey}.reference`)}
                name="releaseReference"
                defaultValue={data.query.releaseReference}
              />
              <Button type="submit" leadingIcon="lock">
                {t(`${routeKey}.buildCommands`)}
              </Button>
              <Button type="submit" name="intent" value="set-release-lock" formMethod="post" leadingIcon="check">
                {t(`${routeKey}.persistReleaseLock`)}
              </Button>
            </Stack>
          </Form>

          {data.releaseLockCommandPlan.errors.length > 0 ? (
            <Stack gap={2}>
              {data.releaseLockCommandPlan.errors.map((error) => (
                <Badge key={error} tone="warning">
                  {error}
                </Badge>
              ))}
            </Stack>
          ) : null}

          <Textarea label={t(`${routeKey}.commands`)} value={commandText} rows={5} readOnly />
        </Stack>
      </Surface>
    </PageSection>
  );
}

function RolloutEvaluationPanel({ data }: Readonly<{ data: ReleaseControlsSnapshot }>) {
  return (
    <PageSection title={t(`${routeKey}.rolloutEvaluation`)}>
      <Surface>
        <Stack gap={4}>
          <Form spacing="none" method="get">
            <Stack gap={3}>
              <TextInput
                label={t(`${routeKey}.featureKey`)}
                name="rolloutFeatureKey"
                defaultValue={data.query.rolloutFeatureKey}
              />
              <Grid columns={{ base: 1, md: 2 }}>
                <NativeSelect
                  label={t(`${routeKey}.environment`)}
                  name="rolloutEnvironment"
                  defaultValue={data.query.rolloutEnvironment}
                  items={["development", "test", "preview", "staging", "production"].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
                <TextInput
                  label={t(`${routeKey}.percentage`)}
                  name="rolloutPercentage"
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={data.query.rolloutPercentage}
                />
              </Grid>
              <Grid columns={{ base: 1, md: 2 }}>
                <NativeSelect
                  label={t(`${routeKey}.subjectType`)}
                  name="rolloutSubjectType"
                  defaultValue={data.query.rolloutSubjectType}
                  items={["account", "membership", "operator", "anonymous"].map((value) => ({ value, label: value }))}
                />
                <TextInput
                  label={t(`${routeKey}.subjectId`)}
                  name="rolloutSubjectId"
                  defaultValue={data.query.rolloutSubjectId}
                />
              </Grid>
              <Textarea
                label={t(`${routeKey}.allowSubjects`)}
                name="rolloutAllowSubjects"
                defaultValue={data.query.rolloutAllowSubjects}
                rows={3}
              />
              <Textarea
                label={t(`${routeKey}.optOutSubjects`)}
                name="rolloutOptOutSubjects"
                defaultValue={data.query.rolloutOptOutSubjects}
                rows={3}
              />
              <TextInput label={t(`${routeKey}.reason`)} name="releaseReason" defaultValue={data.query.releaseReason} />
              <TextInput
                label={t(`${routeKey}.reference`)}
                name="releaseReference"
                defaultValue={data.query.releaseReference}
              />
              <Checkbox
                label={t(`${routeKey}.killSwitch`)}
                name="rolloutKillSwitchActive"
                value="true"
                defaultChecked={data.query.rolloutKillSwitchActive}
              />
              <Button type="submit" leadingIcon="rocket">
                {t(`${routeKey}.evaluateRollout`)}
              </Button>
              <Button type="submit" name="intent" value="set-rollout-policy" formMethod="post" leadingIcon="check">
                {t(`${routeKey}.persistRolloutPolicy`)}
              </Button>
            </Stack>
          </Form>

          <RolloutResult data={data} />
        </Stack>
      </Surface>
    </PageSection>
  );
}

function RolloutResult({ data }: Readonly<{ data: ReleaseControlsSnapshot }>) {
  if (data.rolloutEvaluation.errors.length > 0) {
    return (
      <Stack gap={2}>
        {data.rolloutEvaluation.errors.map((error) => (
          <Badge key={error} tone="warning">
            {error}
          </Badge>
        ))}
      </Stack>
    );
  }

  return (
    <KeyValueList
      items={[
        {
          key: t(`${routeKey}.enabled`),
          value: data.rolloutEvaluation.enabled ? t(`${routeKey}.yes`) : t(`${routeKey}.no`),
        },
        { key: t(`${routeKey}.decisionReason`), value: data.rolloutEvaluation.reason },
        { key: t(`${routeKey}.bucket`), value: data.rolloutEvaluation.bucket },
      ]}
    />
  );
}
