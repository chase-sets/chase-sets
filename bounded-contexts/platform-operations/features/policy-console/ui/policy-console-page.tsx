import { t } from "@chase-sets/localization";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Button,
  Card,
  DataTable,
  HiddenInput,
  Inset,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { PolicyConsoleRegistryItem } from "../api/contracts";
import type { PublicDocReviewQueueItem } from "../../public-doc-reviews/read-model/queries";
import type { CommercialTermsAttentionItem } from "../../commercial-terms-attention/read-model/queries";

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
  reviewItems = [],
  commercialTermsAttentionItems = [],
}: Readonly<{
  items: readonly PolicyConsoleRegistryItem[];
  commercialTermsSchedulesHref: string;
  reviewItems?: readonly PublicDocReviewQueueItem[];
  commercialTermsAttentionItems?: readonly CommercialTermsAttentionItem[];
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

      <PageSection
        title={t(`${routeKey}.commercialTermsAttention.title`)}
        description={t(`${routeKey}.commercialTermsAttention.description`)}
      >
        {commercialTermsAttentionItems.length === 0 ? (
          <Text tone="secondary">{t(`${routeKey}.commercialTermsAttention.empty`)}</Text>
        ) : (
          <DataTable<CommercialTermsAttentionItem>
            rows={[...commercialTermsAttentionItems]}
            getRowId={(item) => item.id}
            columns={[
              {
                key: "terms",
                header: t(`${routeKey}.commercialTermsAttention.terms`),
                cell: (item) => item.label,
              },
              {
                key: "timing",
                header: t(`${routeKey}.commercialTermsAttention.timing`),
                cell: (item) => item.detail,
              },
              {
                key: "action",
                header: t(`${routeKey}.commercialTermsAttention.action`),
                cell: (item) => (
                  <LinkButton href={item.href} tone="secondary" size="sm">
                    {t(`${routeKey}.commercialTermsAttention.review`)}
                  </LinkButton>
                ),
              },
            ]}
          />
        )}
      </PageSection>

      <PageSection title={t(`${routeKey}.reviewQueue.title`)} description={t(`${routeKey}.reviewQueue.description`)}>
        {reviewItems.length === 0 ? (
          <Text tone="secondary">{t(`${routeKey}.reviewQueue.empty`)}</Text>
        ) : (
          <DataTable<PublicDocReviewQueueItem>
            rows={[...reviewItems]}
            getRowId={(item) => `${item.locale}:${item.articleSlug}:${item.policyKey}`}
            columns={[
              {
                key: "article",
                header: t(`${routeKey}.reviewQueue.article`),
                cell: (item) => <LinkButton href={item.articleHref}>{item.articleTitle}</LinkButton>,
              },
              {
                key: "policyKey",
                header: t(`${routeKey}.reviewQueue.policy`),
                cell: (item) => item.policyKey,
              },
              {
                key: "age",
                header: t(`${routeKey}.reviewQueue.age`),
                cell: (item) => t(`${routeKey}.reviewQueue.ageDays`, { count: item.ageDays }),
              },
              {
                key: "action",
                header: t(`${routeKey}.reviewQueue.action`),
                cell: (item) => (
                  <RouterForm method="post" spacing="none">
                    <HiddenInput name="locale" value={item.locale} />
                    <HiddenInput name="articleSlug" value={item.articleSlug} />
                    <HiddenInput name="policyKey" value={item.policyKey} />
                    <Button type="submit" tone="secondary">
                      {t(`${routeKey}.reviewQueue.confirm`)}
                    </Button>
                  </RouterForm>
                ),
              },
            ]}
          />
        )}
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
