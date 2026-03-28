export function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ${streamId} does not start with ${prefix}.`);
  }

  return streamId.slice(prefix.length);
}
