import { developerArticles as generatedDeveloperArticles } from "./generated/articles";
import { mcpToolCatalog as generatedMcpToolCatalog } from "./generated/mcp-tool-catalog";
import type { DeveloperArticle, DeveloperMcpToolCatalogEntry } from "./developer-article-model";

export const developerArticles: readonly DeveloperArticle[] = generatedDeveloperArticles;
export const developerArticlePaths = developerArticles.map((article) => article.href);
export const developerMcpToolCatalog: readonly DeveloperMcpToolCatalogEntry[] = generatedMcpToolCatalog;

export function findDeveloperArticle(slug: string | undefined, locale = "en") {
  return developerArticles.find(
    (article) => article.locale === locale && article.slug === slug && article.href === `/developers/${slug}`,
  );
}

export function listDeveloperToolsByAvailability(availability: "available" | "planned") {
  return developerMcpToolCatalog.filter((tool) => tool.availability === availability);
}
