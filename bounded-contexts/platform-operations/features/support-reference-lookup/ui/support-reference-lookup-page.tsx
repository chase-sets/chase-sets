import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Cluster,
  EmptyState,
  Form,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { SupportReferenceLookupResult } from "../api/contracts";

const routeKey = "support.features.supportReferenceLookup.ui.supportReferenceLookupPage";

export type SupportReferenceLookupPageProps = Readonly<{
  /** The last submitted reference, or "" before the first search. Kept as the search box's default value so a repeat lookup doesn't require retyping. */
  query: string;
  result: SupportReferenceLookupResult | null;
  /** True once a search has been submitted, so a `null` result renders "not found" instead of hiding the results section. */
  searched: boolean;
  error?: string | null;
}>;

function resultRows(result: SupportReferenceLookupResult) {
  return [
    [t(`${routeKey}.result.context`), result.contextName],
    [t(`${routeKey}.result.entityType`), result.entityType],
    [t(`${routeKey}.result.displayReference`), result.displayReference ?? t(`${routeKey}.result.notApplicable`)],
  ] as const;
}

export function SupportReferenceLookupPage({ query, result, searched, error }: SupportReferenceLookupPageProps) {
  return (
    <Page>
      <PageHeader title={t(`${routeKey}.title`)} description={t(`${routeKey}.description`)} />

      <PageSection title={t(`${routeKey}.search.title`)} description={t(`${routeKey}.search.description`)}>
        <Surface elevation="tinted" data-elevation-role="furniture">
          <Form method="get" spacing="md">
            <TextInput
              label={t(`${routeKey}.search.label`)}
              name="reference"
              defaultValue={query}
              placeholder={t(`${routeKey}.search.placeholder`)}
              autoFocus
              required
            />
            <Cluster justify="end">
              <Button type="submit">{t(`${routeKey}.search.submit`)}</Button>
            </Cluster>
          </Form>
        </Surface>
      </PageSection>

      {error ? (
        <Surface tone="muted" elevation="tinted" data-elevation-role="furniture">
          <Cluster gap={2}>
            <Badge tone="danger">{t(`${routeKey}.error`)}</Badge>
            <Text size="sm" weight="semibold">
              {error}
            </Text>
          </Cluster>
        </Surface>
      ) : null}

      {searched && !error ? (
        <PageSection title={t(`${routeKey}.result.title`)}>
          {result ? (
            <Surface elevation="tinted" data-elevation-role="furniture">
              <Stack gap={3}>
                <Cluster align="start" justify="between" gap={1}>
                  <Text size="sm" weight="semibold">
                    {t(`${routeKey}.result.summary`)}
                  </Text>
                  <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                    {result.summary}
                  </Text>
                </Cluster>
                {resultRows(result).map(([label, value]) => (
                  <Cluster key={label} align="start" justify="between" gap={1}>
                    <Text size="sm" weight="semibold">
                      {label}
                    </Text>
                    <Text element="span" size="sm" tone="secondary" wrap="anywhere" align="right">
                      {value}
                    </Text>
                  </Cluster>
                ))}
                {result.status ? (
                  <Cluster align="start" justify="between" gap={1}>
                    <Text size="sm" weight="semibold">
                      {t(`${routeKey}.result.status`)}
                    </Text>
                    <Badge>{result.status}</Badge>
                  </Cluster>
                ) : null}
                {result.adminHref ? (
                  <Cluster justify="end">
                    <LinkButton href={result.adminHref}>{t(`${routeKey}.result.open`)}</LinkButton>
                  </Cluster>
                ) : null}
              </Stack>
            </Surface>
          ) : (
            <EmptyState
              title={t(`${routeKey}.notFound.title`)}
              description={t(`${routeKey}.notFound.description`, { query })}
            />
          )}
        </PageSection>
      ) : null}
    </Page>
  );
}
