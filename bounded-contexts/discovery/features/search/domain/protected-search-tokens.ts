export type ServedSearchSetCodeLookup = (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
export type ProtectedSearchToken = Readonly<{ raw: string; protected: boolean }>;

export async function classifyProtectedSearchTokens(
  value: string,
  lookup: ServedSearchSetCodeLookup,
): Promise<readonly ProtectedSearchToken[]> {
  const tokens = (value.match(/\S+/gu) ?? []).flatMap((rawInput) => {
    const digitBearing = /\p{N}/u.test(rawInput);
    const safeTokens = rawInput.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[./-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) ?? [];
    return safeTokens
      .flatMap((token) => (digitBearing ? [token] : token.split(/[./-]/u)))
      .map((raw) => ({ raw, digitBearing }));
  });
  const isCodeCandidate = (index: number) =>
    !tokens[index].digitBearing &&
    /^\p{L}[\p{L}\p{M}]*$/u.test(tokens[index].raw) &&
    /^\p{N}+\p{L}?(?:\/\p{N}+)?$/u.test(tokens[index + 1]?.raw ?? "");
  const candidates = [
    ...new Set(tokens.filter((_token, index) => isCodeCandidate(index)).map((token) => token.raw.toLowerCase())),
  ];
  const served = candidates.length > 0 ? await lookup(candidates) : new Set<string>();
  return tokens.map(({ raw, digitBearing }, index) => ({
    raw,
    protected: digitBearing || (isCodeCandidate(index) && served.has(raw.toLowerCase())),
  }));
}
