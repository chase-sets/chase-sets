import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  DataTable,
  Inset,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { PolicyConsoleRegistryItem } from "../api/contracts";

const routeKey = "platformOperations.policyConsole";

function contextLabel(contextName: string): string {
  return contextName
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function statusTone(status: string): "success" | "neutral" | "warning" {
  if (status === "active") {
    return "success";
  }
  if (status === "fallback") {
    return "neutral";
  }
  return "warning";
}

function statusLabel(status: string): string {
  if (status === "active") {
    return t(`${routeKey}.statusActive`);
  }
  if (status === "inactive") {
    return t(`${routeKey}.statusInactive`);
  }
  return t(`${routeKey}.statusFallback`);
}

export function PolicyConsolePage({
  items,
  commercialTermsSchedulesHref,
}: Readonly<{
  items: readonly PolicyConsoleRegistryItem[];
  commercialTermsSchedulesHref: string;
}>) {
  const groups = groupByContext(items);

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />

      <PageSection title={t(`${routeKey}.commercialTermsLinkTitle`)}>
        <Card>
          <Inset>
            <Stack gap={2}>
              <Text>{t(`${routeKey}.commercialTermsLinkDescription`)}</Text>
              <LinkButton href={commercialTermsSchedulesHref} tone="secondary">
                {t(`${routeKey}.commercialTermsLinkAction`)}
              </LinkButton>
            </Stack>
          </Inset>
        </Card>
      </PageSection>

      {groups.map(([contextName, contextItems]) => (
        <PageSection key={contextName} title={contextLabel(contextName)}>
          <DataTable<PolicyConsoleRegistryItem>
            rows={[...contextItems]}
            getRowId={(item) => item.policyKey}
            columns={[
              {
                key: "policyKey",
                header: t(`${routeKey}.policyKey`),
                cell: (item) => (
                  <LinkButton href={`/platform/policy-console/${item.policyKey}`} tone="ghost">
                    {item.policyKey}
                  </LinkButton>
                ),
              },
              {
                key: "schemaSummary",
                header: t(`${routeKey}.schema`),
                cell: (item) => (
                  <Text size="sm" tone="secondary">
                    {item.schemaSummary}
                  </Text>
                ),
              },
              {
                key: "status",
                header: t(`${routeKey}.status`),
                cell: (item) => <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>,
              },
              {
                key: "effectiveFrom",
                header: t(`${routeKey}.effectiveFrom`),
                cell: (item) => item.effectiveFrom || t(`${routeKey}.notSet`),
              },
              {
                key: "updatedAt",
                header: t(`${routeKey}.updatedAt`),
                cell: (item) => item.updatedAt || t(`${routeKey}.notSet`),
              },
            ]}
          />
        </PageSection>
      ))}
    </Page>
  );
}

function groupByContext(
  items: readonly PolicyConsoleRegistryItem[],
): ReadonlyArray<readonly [string, readonly PolicyConsoleRegistryItem[]]> {
  const groups = new Map<string, PolicyConsoleRegistryItem[]>();
  for (const item of items) {
    const existing = groups.get(item.contextName);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(item.contextName, [item]);
    }
  }

  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}
