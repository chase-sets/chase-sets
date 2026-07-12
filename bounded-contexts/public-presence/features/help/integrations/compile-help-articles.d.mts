export type HelpArticleSource = Readonly<{ fileName: string; source: string }>;

export function compileHelpArticleSource(fileName: string, source: string): Readonly<Record<string, unknown>>;
export function compileHelpArticleCorpus(
  sources: readonly HelpArticleSource[],
): readonly Readonly<Record<string, unknown>>[];
