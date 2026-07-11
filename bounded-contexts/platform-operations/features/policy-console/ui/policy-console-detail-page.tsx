import { t } from "@chase-sets/localization";
import { useState } from "react";
import {
  Badge,
  Button,
  DataTable,
  DetailPanel,
  Form,
  Grid,
  HiddenInput,
  KeyValueList,
  NativeSelect,
  Page,
  PageHeader,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@chase-sets/design-system";
import type { PolicyConsoleOverview } from "../api/contracts";

const routeKey = "platformOperations.policyConsole.detail";

export type PolicyConsoleDocumentHistoryRow = Readonly<{
  history_id: string;
  event_type: string;
  actor_user_id: string;
  status: string;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export function PolicyConsoleDetailPage({
  overview,
  history,
  canManage,
  submitError,
}: Readonly<{
  overview: PolicyConsoleOverview;
  history: readonly PolicyConsoleDocumentHistoryRow[];
  canManage: boolean;
  submitError?: string | null;
}>) {
  const [value, setValue] = useState(() => JSON.stringify(overview.current.value, null, 2));

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`, { context: overview.contextName })}
        title={overview.policyKey}
        description={overview.schemaSummary}
      />

      <Grid columns={2} gap={4}>
        <DetailPanel title={t(`${routeKey}.currentTitle`)}>
          <KeyValueList
            items={[
              { key: t(`${routeKey}.source`), value: overview.current.source },
              { key: t(`${routeKey}.status`), value: overview.current.status ?? t(`${routeKey}.notSet`) },
              { key: t(`${routeKey}.effectiveFrom`), value: overview.current.effectiveFrom ?? t(`${routeKey}.notSet`) },
              {
                key: t(`${routeKey}.effectiveUntil`),
                value: overview.current.effectiveUntil ?? t(`${routeKey}.openEnded`),
              },
            ]}
          />
          <Text size="sm" tone="secondary">
            {JSON.stringify(overview.current.value)}
          </Text>
        </DetailPanel>

        <DetailPanel title={t(`${routeKey}.upcomingTitle`)}>
          {overview.upcoming.length === 0 ? (
            <Text tone="secondary">{t(`${routeKey}.noUpcoming`)}</Text>
          ) : (
            <Stack gap={3}>
              {overview.upcoming.map((revision) => (
                <Stack key={revision.documentId} gap={1}>
                  <Badge tone="info">{t(`${routeKey}.scheduledFor`, { effectiveFrom: revision.effectiveFrom })}</Badge>
                  <Text size="sm" tone="secondary">
                    {JSON.stringify(revision.value)}
                  </Text>
                </Stack>
              ))}
            </Stack>
          )}
        </DetailPanel>
      </Grid>

      {canManage ? (
        <DetailPanel title={t(`${routeKey}.reviseTitle`)}>
          <Form method="post" spacing="lg">
            <HiddenInput type="hidden" name="intent" value="create-revision" readOnly />
            {submitError ? (
              <Text tone="danger" role="alert">
                {submitError}
              </Text>
            ) : null}
            <Textarea
              name="value"
              label={t(`${routeKey}.valueLabel`)}
              description={t(`${routeKey}.valueDescription`)}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              rows={10}
              required
            />
            <Grid columns={3} gap={3}>
              <NativeSelect
                name="status"
                label={t(`${routeKey}.statusLabel`)}
                defaultValue={overview.current.status ?? "active"}
                items={[
                  { value: "active", label: t(`${routeKey}.statusActive`) },
                  { value: "inactive", label: t(`${routeKey}.statusInactive`) },
                ]}
              />
              <TextInput
                type="datetime-local"
                name="effectiveFrom"
                label={t(`${routeKey}.effectiveFromLabel`)}
                description={t(`${routeKey}.effectiveFromDescription`)}
              />
              <TextInput
                type="datetime-local"
                name="effectiveUntil"
                label={t(`${routeKey}.effectiveUntilLabel`)}
                description={t(`${routeKey}.effectiveUntilDescription`)}
              />
            </Grid>
            <Button type="submit">{t(`${routeKey}.reviseSubmit`)}</Button>
          </Form>
        </DetailPanel>
      ) : null}

      <DetailPanel title={t(`${routeKey}.historyTitle`)}>
        <DataTable<PolicyConsoleDocumentHistoryRow>
          rows={[...history]}
          getRowId={(row) => row.history_id}
          columns={[
            { key: "eventType", header: t(`${routeKey}.historyEvent`), cell: (row) => row.event_type },
            { key: "status", header: t(`${routeKey}.status`), cell: (row) => row.status },
            { key: "effectiveFrom", header: t(`${routeKey}.effectiveFrom`), cell: (row) => row.effective_from },
            {
              key: "effectiveUntil",
              header: t(`${routeKey}.effectiveUntil`),
              cell: (row) => row.effective_until ?? t(`${routeKey}.openEnded`),
            },
            { key: "actor", header: t(`${routeKey}.historyActor`), cell: (row) => row.actor_user_id },
            { key: "recordedAt", header: t(`${routeKey}.historyRecordedAt`), cell: (row) => row.recorded_at },
          ]}
        />
      </DetailPanel>
    </Page>
  );
}
