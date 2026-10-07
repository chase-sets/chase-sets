export const SYNTHETIC_FIXTURES: Readonly<Record<string, unknown>>;
export function syntheticManifest(now?: number): Record<string, unknown> & {
  schedule: Array<{
    flow: string;
    windowId: string;
    mappers: string[];
    slots: number[];
    identityDigest: string;
    cleanupObligations: string[];
  }>;
};
export function syntheticHash(value: string): string;
