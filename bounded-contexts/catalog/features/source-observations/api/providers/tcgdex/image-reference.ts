export function resolveTcgdexImageReference(source: string, highQualityAssetVariant: string): string {
  const suffix = `/${highQualityAssetVariant}`;
  return source.endsWith(suffix) ? source : `${source.replace(/\/$/, "")}${suffix}`;
}
