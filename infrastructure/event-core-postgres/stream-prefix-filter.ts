export type StreamPrefixFilterSql = Readonly<{
  predicate: string;
  params: readonly string[];
}>;

export function buildStreamPrefixFilterSql(
  streamPrefixes: readonly string[],
  nextParamIndex: number,
): StreamPrefixFilterSql | null {
  const prefixes = [...new Set(streamPrefixes)];
  if (prefixes.length === 0) {
    return null;
  }

  const params: string[] = [];
  const predicates = prefixes.map((prefix) => {
    const streamContextName = normalizedStreamPrefixContextName(prefix);
    if (streamContextName) {
      const contextParam = nextParamIndex + params.length;
      params.push(streamContextName);
      const prefixParam = nextParamIndex + params.length;
      params.push(prefix);
      return `(stream_context_name = $${contextParam} AND stream_id LIKE $${prefixParam} || '%')`;
    }

    const prefixParam = nextParamIndex + params.length;
    params.push(prefix);
    return `(stream_id LIKE $${prefixParam} || '%')`;
  });

  return {
    predicate: `(${predicates.join(" OR ")})`,
    params,
  };
}

export function streamContextName(streamId: string): string {
  const separatorIndex = streamId.indexOf(".");
  return separatorIndex > 0 ? streamId.slice(0, separatorIndex) : streamId;
}

export function streamCategory(streamId: string): string {
  const lastDashIndex = streamId.lastIndexOf("-");
  return lastDashIndex > 0 ? streamId.slice(0, lastDashIndex) : streamId;
}

function normalizedStreamPrefixContextName(prefix: string): string | null {
  const separatorIndex = prefix.indexOf(".");
  return separatorIndex > 0 ? prefix.slice(0, separatorIndex) : null;
}
