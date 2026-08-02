import type { HelpArticle } from "../domain/article-model";

export type HelpArticleSource = Readonly<{ fileName: string; source: string }>;
export type HelpArticleCompilerOptions = Readonly<{
  allowedAudiences?: readonly string[];
  defaultPath?: (article: Readonly<{ category: string; slug: string }>) => string;
  expectedAudience?: string;
  includeCategoryPaths?: boolean;
  rootPath?: string;
}>;

export function compileHelpArticleSource(
  fileName: string,
  source: string,
  options?: HelpArticleCompilerOptions,
): HelpArticle;
export function compileHelpArticleCorpus(
  sources: readonly HelpArticleSource[],
  options?: HelpArticleCompilerOptions,
): readonly HelpArticle[];
export function renderGeneratedManifest(articles: readonly HelpArticle[]): Promise<string>;
export function renderCitationContract(articles: readonly HelpArticle[]): Promise<string>;
export function compileRepositoryCorpus(): Promise<readonly HelpArticle[]>;
