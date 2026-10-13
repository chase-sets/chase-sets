export type ServedSearchSetCodeLookup = (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
export type ProtectedSearchToken = Readonly<{ raw: string; protected: boolean }>;

export async function classifyProtectedSearchTokens(
  value: string,
  lookup: ServedSearchSetCodeLookup,
): Promise<readonly ProtectedSearchToken[]> {
  const tokens = value.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[/-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) ?? [];
  const isCodeCandidate = (index: number) =>
    /^\p{L}[\p{L}\p{M}]*$/u.test(tokens[index]) && /^\p{N}+\p{L}?(?:\/\p{N}+)?$/u.test(tokens[index + 1] ?? "");
  const candidates = [
    ...new Set(tokens.filter((_token, index) => isCodeCandidate(index)).map((token) => token.toLowerCase())),
  ];
  const served = candidates.length > 0 ? await lookup(candidates) : new Set<string>();
  return tokens.map((raw, index) => ({
    raw,
    protected: /\p{N}/u.test(raw) || (isCodeCandidate(index) && served.has(raw.toLowerCase())),
  }));
}
