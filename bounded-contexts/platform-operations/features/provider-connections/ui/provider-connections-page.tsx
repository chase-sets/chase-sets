import {
  Badge,
  DataTable,
  EmptyState,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { ProviderConnectionRow, ProviderConnectionsSnapshot } from "../api/contracts";
import { providerConnectionAge } from "./freshness";

const key = "platformOperations.providerConnections";

function observation(row: ProviderConnectionRow, evaluatedAt: string) {
  const age = providerConnectionAge(row, evaluatedAt);
  return (
    <Stack gap={1}>
      <Text>{t(`${key}.freshness.${age.state}`)}</Text>
      {age.ageSeconds !== null && (
        <Text>
          {t(`${key}.observed`, { timestamp: row.observedAt ?? "", minutes: Math.floor(age.ageSeconds / 60) })}
        </Text>
      )}
    </Stack>
  );
}

export function ProviderConnectionsPage({
  snapshot,
  failed = false,
}: {
  snapshot?: ProviderConnectionsSnapshot;
  failed?: boolean;
}) {
  return (
    <Page>
      <PageHeader title={t(`${key}.title`)} description={t(`${key}.description`)} />
      {(["catalog", "channels"] as const).map((owner) => {
        const section = snapshot?.[owner];
        const unavailable = failed || section?.state === "unavailable";
        return (
          <PageSection key={owner} title={t(`${key}.home.${owner}`)}>
            <Text>{t(`${key}.description.${owner}`)}</Text>
            {unavailable ? (
              <EmptyState title={t(`${key}.unavailable`)} description={t(`${key}.unavailableDescription`)} />
            ) : (
              <Stack gap={3}>
                {!section && <Text role="status">{t(`${key}.loading`)}</Text>}
                {section?.state === "partial" && <Text role="status">{t(`${key}.partial`)}</Text>}
                <DataTable<ProviderConnectionRow>
                  rows={[...(section?.rows ?? [])]}
                  loading={!section}
                  getRowId={(row) => row.id}
                  emptyTitle={t(`${key}.empty.${owner}`)}
                  emptyDescription={t(`${key}.emptyDescription`)}
                  columns={[
                    {
                      key: "provider",
                      header: t(`${key}.provider`),
                      cell: (row) => (
                        <Stack gap={1}>
                          <Text>{row.provider}</Text>
                          <Text>{row.id}</Text>
                        </Stack>
                      ),
                    },
                    {
                      key: "capability",
                      header: t(`${key}.capability`),
                      cell: (row) => t(`${key}.capability.${row.capability}`),
                    },
                    {
                      key: "scope",
                      header: t(`${key}.scope`),
                      cell: (row) =>
                        row.accountId
                          ? t(`${key}.sellerScope`, { accountId: row.accountId })
                          : t(`${key}.platformScope`),
                    },
                    {
                      key: "credential",
                      header: t(`${key}.credential`),
                      cell: (row) => <Badge>{t(`${key}.credential.${row.credentialReadiness}`)}</Badge>,
                    },
                    {
                      key: "health",
                      header: t(`${key}.health`),
                      cell: (row) => (
                        <Stack gap={1}>
                          <Text>{t(`${key}.health.${row.health}`)}</Text>
                          {row.status && <Text>{t(`${key}.status.${row.status}`)}</Text>}
                        </Stack>
                      ),
                    },
                    {
                      key: "observation",
                      header: t(`${key}.observation`),
                      cell: (row) => observation(row, snapshot?.evaluatedAt ?? ""),
                    },
                    { key: "owner", header: t(`${key}.owner`), cell: (row) => t(`${key}.owner.${row.owner}`) },
                    {
                      key: "action",
                      header: t(`${key}.action`),
                      cell: (row) =>
                        row.owner === "catalog" && row.destination ? (
                          <LinkButton href={row.destination.href}>{t(`${key}.openProvider`)}</LinkButton>
                        ) : (
                          <Text>{t(`${key}.readOnly`)}</Text>
                        ),
                    },
                  ]}
                />
              </Stack>
            )}
          </PageSection>
        );
      })}
    </Page>
  );
}
