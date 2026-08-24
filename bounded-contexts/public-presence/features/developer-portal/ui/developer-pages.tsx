import {
  Breadcrumbs,
  EvidenceCodeBlock,
  Grid,
  Heading,
  Inline,
  LinkButton,
  List,
  Page,
  PageHeader,
  PageSection,
  SplitPane,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { PublicPresencePageShell } from "../../waitlist/ui/public-pages";
import { publicPresenceT as t } from "../../waitlist/ui/public-presence-translator";
import { ArticleTableOfContents, CompiledArticleBody, formatArticleReviewedAt } from "../../help/ui/help-pages";
import { developerArticles, listDeveloperToolsByAvailability } from "../domain/developer-article-catalog";
import { agentConnectorTermsDeveloperLink } from "../domain/developer-manifest";
import type { DeveloperArticle, DeveloperMcpToolCatalogEntry } from "../domain/developer-article-model";

export function DeveloperPortalPage() {
  return (
    <PublicPresencePageShell>
      <Page>
        <PageHeader
          eyebrow={t("publicPresence.developers.eyebrow")}
          title={t("publicPresence.developers.title")}
          description={t("publicPresence.developers.description")}
        />
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          {developerArticles.map((article) => (
            <Surface key={article.href} element="article" elevated>
              <Stack gap={3}>
                <Heading level={2} visualSize={3}>
                  {article.title}
                </Heading>
                <Text tone="secondary">{article.description}</Text>
                <Inline>
                  <LinkButton href={article.href} tone="secondary">
                    {t("publicPresence.developers.readArticle")}
                  </LinkButton>
                </Inline>
              </Stack>
            </Surface>
          ))}
        </Grid>
        <PageSection
          title={t("publicPresence.developers.machine.title")}
          description={t("publicPresence.developers.machine.description")}
        >
          <Inline>
            <LinkButton href={agentConnectorTermsDeveloperLink.href} tone="secondary">
              {t(agentConnectorTermsDeveloperLink.portalLabelKey)}
            </LinkButton>
            <LinkButton href="/developers/manifest.json" tone="secondary">
              {t("publicPresence.developers.machine.manifest")}
            </LinkButton>
            <LinkButton href="/llms.txt" tone="secondary">
              {t("publicPresence.developers.machine.llms")}
            </LinkButton>
          </Inline>
        </PageSection>
      </Page>
    </PublicPresencePageShell>
  );
}

export function DeveloperArticlePage({ article }: { article: DeveloperArticle }) {
  const content = <CompiledArticleBody article={article} />;
  return (
    <PublicPresencePageShell>
      <Page width="wide">
        <Breadcrumbs
          items={[{ label: t("publicPresence.developers.breadcrumb"), href: "/developers" }, { label: article.title }]}
        />
        <PageHeader
          eyebrow={t("publicPresence.developers.eyebrow")}
          title={article.title}
          description={article.description}
        />
        <Text size="sm" tone="tertiary">
          {t("publicPresence.help.lastReviewed", {
            date: formatArticleReviewedAt(article.reviewedAt, article.locale),
          })}
        </Text>
        {article.headings.length >= 3 ? (
          <SplitPane
            primary={content}
            secondary={<ArticleTableOfContents article={article} />}
            secondaryWidth="nav"
            secondarySticky
          />
        ) : (
          content
        )}
        {article.slug === "mcp-tool-catalog" ? <McpToolCatalog /> : null}
      </Page>
    </PublicPresencePageShell>
  );
}

function McpToolCatalog() {
  const available = listDeveloperToolsByAvailability("available");
  const planned = listDeveloperToolsByAvailability("planned");
  return (
    <PageSection
      title={t("publicPresence.developers.catalog.title")}
      description={t("publicPresence.developers.catalog.description", {
        available: available.length,
        planned: planned.length,
      })}
    >
      <ToolGroup
        title={t("publicPresence.developers.catalog.available")}
        description={t("publicPresence.developers.catalog.available.description")}
        tools={available}
      />
      <ToolGroup
        title={t("publicPresence.developers.catalog.planned")}
        description={t("publicPresence.developers.catalog.planned.description")}
        tools={planned}
      />
    </PageSection>
  );
}

function ToolGroup({
  title,
  description,
  tools,
}: {
  title: string;
  description: string;
  tools: readonly DeveloperMcpToolCatalogEntry[];
}) {
  return (
    <Stack gap={4}>
      <Heading level={3}>{title}</Heading>
      <Text tone="secondary">{description}</Text>
      {tools.map((tool) => (
        <ToolDescriptor key={tool.name} tool={tool} />
      ))}
    </Stack>
  );
}

function ToolDescriptor({ tool }: { tool: DeveloperMcpToolCatalogEntry }) {
  const permissions = tool.permissionBoundary.requiredPermissions.length
    ? tool.permissionBoundary.requiredPermissions
    : [t("publicPresence.developers.catalog.none")];
  const scopes = tool.permissionBoundary.requiredScopes?.length
    ? tool.permissionBoundary.requiredScopes
    : [t("publicPresence.developers.catalog.none")];
  return (
    <Surface element="article" elevated>
      <Stack gap={3}>
        <Heading level={4}>{tool.title}</Heading>
        <Text size="sm">{tool.name}</Text>
        <Text tone="secondary">{tool.description}</Text>
        <Text size="sm">
          {t("publicPresence.developers.catalog.summary", {
            service: tool.serviceId,
            risk: tool.risk,
            scope: tool.permissionBoundary.scope,
          })}
        </Text>
        <Text size="sm">{t("publicPresence.developers.catalog.permissions")}</Text>
        <List items={[...permissions]} />
        <Text size="sm">{t("publicPresence.developers.catalog.oauthScopes")}</Text>
        <List items={[...scopes]} />
        <Text size="sm">{t("publicPresence.developers.catalog.expectedUsage")}</Text>
        <List items={[...tool.expectedUsage]} />
        <Text size="sm">
          {t("publicPresence.developers.catalog.guardrails", {
            confirmation: tool.guardrails.confirmation.required
              ? t("publicPresence.developers.catalog.required")
              : t("publicPresence.developers.catalog.notRequired"),
            idempotency: tool.guardrails.idempotencyKey,
            dryRun: tool.guardrails.dryRunSupported
              ? t("publicPresence.developers.catalog.supported")
              : t("publicPresence.developers.catalog.notSupported"),
          })}
        </Text>
        <EvidenceCodeBlock label={t("publicPresence.developers.catalog.inputSchema")}>
          {JSON.stringify(tool.inputSchema, null, 2)}
        </EvidenceCodeBlock>
        {tool.outputSchema ? (
          <EvidenceCodeBlock label={t("publicPresence.developers.catalog.outputSchema")}>
            {JSON.stringify(tool.outputSchema, null, 2)}
          </EvidenceCodeBlock>
        ) : null}
      </Stack>
    </Surface>
  );
}
