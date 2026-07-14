import type { ReactNode } from "react";
import {
  Breadcrumbs,
  Banner,
  Grid,
  Heading,
  Inline,
  LinkButton,
  LinkText,
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
import {
  helpAudiences,
  listHelpCategoriesByAudience,
  listHelpArticlesByCategory,
  type HelpArticle,
  type HelpArticleInline,
  type HelpAudience,
  type HelpCategory,
} from "../domain/article-catalog";

const audienceKeys: Record<HelpAudience, string> = {
  buyer: "buyer",
  seller: "seller",
  developer: "developer",
};

const categoryKeys: Record<HelpCategory, string> = {
  "getting-started": "gettingStarted",
  buying: "buying",
  selling: "selling",
};

export function helpAudienceLabel(audience: HelpAudience) {
  return t(`publicPresence.help.audience.${audienceKeys[audience]}.title`);
}

export function helpCategoryLabel(category: HelpCategory) {
  return t(`publicPresence.help.category.${categoryKeys[category]}.title`);
}

function helpCategoryDescription(category: HelpCategory) {
  return t(`publicPresence.help.category.${categoryKeys[category]}.description`);
}

export function HelpHubPage() {
  const audienceGroups = helpAudiences
    .map((audience) => ({ audience, categories: listHelpCategoriesByAudience(audience) }))
    .filter((group) => group.categories.length > 0);

  return (
    <PublicPresencePageShell>
      <Page>
        <PageHeader
          eyebrow={t("publicPresence.help.eyebrow")}
          title={t("publicPresence.help.title")}
          description={t("publicPresence.help.description")}
        />
        {audienceGroups.map(({ audience, categories }) => (
          <PageSection
            key={audience}
            title={helpAudienceLabel(audience)}
            description={t(`publicPresence.help.audience.${audienceKeys[audience]}.description`)}
          >
            <Grid columns={{ base: 1, md: 2, lg: 3 }} gap={4}>
              {categories.map((category) => {
                const articles = listHelpArticlesByCategory(category);
                return (
                  <Surface key={category} elevated>
                    <Stack gap={3}>
                      <Heading level={3}>{helpCategoryLabel(category)}</Heading>
                      <Text tone="secondary">{helpCategoryDescription(category)}</Text>
                      <Text size="sm" tone="tertiary">
                        {t("publicPresence.help.articleCount", { count: articles.length })}
                      </Text>
                      <Inline>
                        <LinkButton href={`/help/${category}`} tone="secondary">
                          {t("publicPresence.help.browseCategory", { category: helpCategoryLabel(category) })}
                        </LinkButton>
                      </Inline>
                    </Stack>
                  </Surface>
                );
              })}
            </Grid>
          </PageSection>
        ))}
      </Page>
    </PublicPresencePageShell>
  );
}

export function HelpCategoryPage({ category, articles }: { category: HelpCategory; articles: readonly HelpArticle[] }) {
  return (
    <PublicPresencePageShell>
      <Page>
        <Breadcrumbs
          items={[
            { label: t("publicPresence.help.breadcrumb"), href: "/help" },
            { label: helpCategoryLabel(category) },
          ]}
        />
        <PageHeader
          eyebrow={t("publicPresence.help.category.eyebrow")}
          title={helpCategoryLabel(category)}
          description={helpCategoryDescription(category)}
        />
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          {articles.map((article) => (
            <ArticleCard key={article.href} article={article} />
          ))}
        </Grid>
      </Page>
    </PublicPresencePageShell>
  );
}

function ArticleCard({ article }: { article: HelpArticle }) {
  return (
    <Surface element="article" elevated>
      <Stack gap={3}>
        <Text size="sm" tone="tertiary">
          {helpAudienceLabel(article.audience)}
        </Text>
        <Heading level={2} visualSize={3}>
          {article.title}
        </Heading>
        <Text tone="secondary">{article.description}</Text>
        <Inline>
          <LinkButton href={article.href} tone="secondary">
            {t("publicPresence.help.readArticle")}
          </LinkButton>
        </Inline>
      </Stack>
    </Surface>
  );
}

export function HelpArticlePage({ article, related }: { article: HelpArticle; related: readonly HelpArticle[] }) {
  const hasTableOfContents = article.headings.length >= 3;
  const articleBody = <CompiledArticleBody article={article} />;

  return (
    <PublicPresencePageShell>
      <Page width="wide">
        <Breadcrumbs
          items={[
            { label: t("publicPresence.help.breadcrumb"), href: "/help" },
            { label: helpCategoryLabel(article.category), href: `/help/${article.category}` },
            { label: article.title },
          ]}
        />
        <PageHeader
          eyebrow={helpAudienceLabel(article.audience)}
          title={article.title}
          description={article.description}
        />
        <Text size="sm" tone="tertiary">
          {t("publicPresence.help.lastReviewed", { date: formatArticleReviewedAt(article.reviewedAt, article.locale) })}
        </Text>
        {article.policyChanges?.map((change) => (
          <Banner
            key={change.effectiveFrom}
            tone="info"
            title={t("publicPresence.help.changingOn", {
              date: formatArticleReviewedAt(change.effectiveFrom.slice(0, 10), article.locale),
            })}
            description={change.description}
          />
        ))}
        {hasTableOfContents ? (
          <SplitPane
            primary={articleBody}
            secondary={<ArticleTableOfContents article={article} />}
            secondaryWidth="nav"
            secondarySticky
          />
        ) : (
          articleBody
        )}
        {related.length > 0 ? (
          <PageSection
            title={t("publicPresence.help.related.title")}
            description={t("publicPresence.help.related.description")}
          >
            <Grid columns={{ base: 1, md: 2, lg: 3 }} gap={4}>
              {related.map((candidate) => (
                <ArticleCard key={candidate.href} article={candidate} />
              ))}
            </Grid>
          </PageSection>
        ) : null}
      </Page>
    </PublicPresencePageShell>
  );
}

export function CompiledArticleBody({ article }: { article: HelpArticle }) {
  return (
    <Surface element="article" elevated>
      <Stack gap={4}>
        {article.blocks.map((block, index) => {
          if (block.type === "heading") {
            return (
              <Heading key={block.id} id={block.id} level={block.level} visualSize={block.level}>
                <InlineContent content={block.content} />
              </Heading>
            );
          }
          if (block.type === "list") {
            return (
              <List
                key={`list-${index}`}
                ordered={block.ordered}
                items={block.items.map((item, itemIndex) => (
                  <InlineContent key={itemIndex} content={item} />
                ))}
              />
            );
          }
          return (
            <Text key={`paragraph-${index}`} tone="secondary">
              <InlineContent content={block.content} />
            </Text>
          );
        })}
      </Stack>
    </Surface>
  );
}

export function ArticleTableOfContents({ article }: { article: HelpArticle }) {
  return (
    <Surface element="nav" tone="subtle" aria-label={t("publicPresence.help.toc.title")}>
      <Stack gap={3}>
        <Heading level={2} visualSize={4}>
          {t("publicPresence.help.toc.title")}
        </Heading>
        <List
          items={article.headings.map((heading) => (
            <LinkText key={heading.id} href={`#${heading.id}`} tone="neutral">
              {heading.text}
            </LinkText>
          ))}
        />
      </Stack>
    </Surface>
  );
}

function InlineContent({ content }: { content: readonly HelpArticleInline[] }) {
  return content.map((inline, index): ReactNode => {
    const key = `${inline.type}-${index}`;
    if (inline.type === "link")
      return (
        <LinkText key={key} href={inline.href}>
          {inline.label}
        </LinkText>
      );
    if (inline.type === "strong") return <strong key={key}>{inline.value}</strong>;
    if (inline.type === "emphasis") return <em key={key}>{inline.value}</em>;
    if (inline.type === "code") return <code key={key}>{inline.value}</code>;
    if (inline.type === "policy-value") {
      throw new Error(`Article policy value '${inline.key}' reached rendering without resolution.`);
    }
    return inline.value;
  });
}

export function formatArticleReviewedAt(reviewedAt: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${reviewedAt}T00:00:00Z`),
  );
}
