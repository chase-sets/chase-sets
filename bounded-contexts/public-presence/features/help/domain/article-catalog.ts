import { helpArticles } from "./generated/articles";
import { helpCategories, type HelpArticle, type HelpAudience, type HelpCategory } from "./article-model";

export { helpAudiences, helpCategories } from "./article-model";
export type { HelpArticle, HelpArticleBlock, HelpArticleInline, HelpAudience, HelpCategory } from "./article-model";

export const publicHelpArticles: readonly HelpArticle[] = helpArticles;
export const publicHelpArticlePaths = helpArticles.map((article) => article.href);

export function findHelpArticle(category: string | undefined, slug: string | undefined, locale = "en") {
  return helpArticles.find(
    (article) => article.locale === locale && article.category === category && article.slug === slug,
  );
}

export function isHelpCategory(value: string | undefined): value is HelpCategory {
  return helpCategories.some((category) => category === value);
}

export function listHelpArticlesByCategory(category: HelpCategory, locale = "en") {
  return helpArticles.filter((article) => article.locale === locale && article.category === category);
}

export function listHelpCategoriesByAudience(audience: HelpAudience, locale = "en") {
  return helpCategories.filter((category) =>
    helpArticles.some(
      (article) => article.locale === locale && article.audience === audience && article.category === category,
    ),
  );
}

export function listRelatedHelpArticles(article: HelpArticle, limit = 3) {
  return helpArticles
    .filter(
      (candidate) =>
        candidate.locale === article.locale &&
        candidate.href !== article.href &&
        (candidate.category === article.category || candidate.audience === article.audience),
    )
    .slice(0, limit);
}
