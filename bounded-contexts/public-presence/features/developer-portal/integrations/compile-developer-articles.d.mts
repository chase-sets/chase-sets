export type DeveloperArticleSource = Readonly<{ fileName: string; source: string }>;

export function compileDeveloperArticleCorpus(
  sources: readonly DeveloperArticleSource[],
): Promise<readonly Readonly<Record<string, unknown>>[]>;
export function compileMcpToolCatalog(): readonly Readonly<Record<string, unknown>>[];
export function compileRepositoryDeveloperCorpus(): Promise<readonly Readonly<Record<string, unknown>>[]>;
