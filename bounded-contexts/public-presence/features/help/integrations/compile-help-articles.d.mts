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
): Readonly<Record<string, unknown>>;
export function compileHelpArticleCorpus(
  sources: readonly HelpArticleSource[],
  options?: HelpArticleCompilerOptions,
): readonly Readonly<Record<string, unknown>>[];
export function compileRepositoryCorpus(): Promise<readonly Readonly<Record<string, unknown>>[]>;
