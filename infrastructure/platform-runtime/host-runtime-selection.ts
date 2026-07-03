export type SourceRuntimeHostManifest = Readonly<{
  sourceRuntimeDeployables?: readonly string[];
  sourceRuntimeProfiles?: readonly string[];
}>;

export function runtimeProfileMatches(
  profiles: readonly string[] | undefined,
  runtimeProfile: string | undefined,
): boolean {
  return !runtimeProfile || Boolean(profiles?.includes(runtimeProfile));
}

export function sourceRuntimeHostMatches(
  manifest: SourceRuntimeHostManifest,
  hostName: string,
  runtimeProfile: string | undefined,
): boolean {
  return Boolean(
    manifest.sourceRuntimeProfiles &&
    manifest.sourceRuntimeDeployables?.includes(hostName) &&
    runtimeProfileMatches(manifest.sourceRuntimeProfiles, runtimeProfile),
  );
}
